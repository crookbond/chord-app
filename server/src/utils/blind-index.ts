/**
 * Blind search index (ADR 0201).
 *
 * The database can no longer read the text it used to build `search_tsv` from,
 * and it must not learn the words from an index either. So the index is built
 * here, in the application, from keyed hashes: every word (and every prefix of
 * it) and every character trigram is replaced by a truncated HMAC under a key
 * derived from the owner's data key, and the result is stored as an ordinary
 * `tsvector` of opaque lexemes. Postgres still does what it is good at, GIN
 * lookups and `ts_rank_cd`, and never sees a word.
 *
 * Two indexes per row, because they answer two different questions:
 *   words  stemmed words, each with all its prefixes (3..12 letters), carrying
 *          positions so ranking still rewards frequency and closeness. This is
 *          what "school" finding "schools" and "plumb" finding "plumber" ride on.
 *   grams  character trigrams of the lowercased text, presence only. A literal
 *          (`ua512`, `lcps.example`, `50%`, non-latin text) has every one of its
 *          trigrams in the index, so a match is "all trigrams present", then
 *          confirmed by opening the candidate: trigrams say every piece is
 *          there, not that they are next to each other.
 *
 * What the index reveals to someone reading the database without the key:
 * how many distinct words a row has and which rows share a word (equal
 * lexemes). It does not reveal the words, and the key is per owner, so nothing
 * links two users. Hashes are cut to 32 bits so that frequency counts blur (a
 * lexeme stands for a handful of words), which a query then corrects by
 * confirming candidates. That is a deliberate trade, stated here so it is not
 * mistaken for full secrecy: this is searchable encryption, and searchable
 * encryption leaks access patterns by construction.
 */
import { createHmac } from 'node:crypto';

import { stemmer } from 'stemmer';

import { STOPWORDS } from './keywords.js';

const MIN_PREFIX = 3;
const MAX_PREFIX = 12;
/** A tsvector is limited to 1 MB; this keeps the biggest bodies well inside it. */
const MAX_LEXEMES = 20_000;
/** Text indexed per body: the first ~9k words. */
export const MAX_INDEXED_CHARS = 100_000;
const MAX_POSITIONS_PER_LEXEME = 200;
const MAX_POSITION = 16_000;
/** Body trigrams are kept only for code-like tokens (a digit inside, 4-40 long). */
const CODE_MIN = 4;
const CODE_MAX = 40;
const MAX_CODE_TOKENS = 300;

export type IndexKey = Buffer;

/**
 * A lexeme is a pure function of (key, kind, value), and one message asks for
 * thousands of them: every word contributes a lexeme for each prefix from 3 to
 * 12 characters, and mail repeats its vocabulary heavily. Each was a fresh
 * HMAC (about 4 microseconds); indexing a ~350-word body took ~8 ms, and it
 * was ~10% of server CPU under mail load. Already-computed lexemes are kept in
 * a bounded memo: a hit is ~0.15 microseconds and yields exactly the same
 * value, so nothing already stored changes.
 *
 * Entries are scoped to the key INSTANCE (an id handed out per Buffer), so two
 * owners can never see each other's lexemes through it. Full means clear: the
 * working set that matters is one owner's sync pass, which refills it at once.
 */
const LEXEME_MEMO_MAX = 100_000;
const lexemeMemo = new Map<string, string>();
const keyIds = new WeakMap<Buffer, number>();
let nextKeyId = 1;

function lexeme(key: IndexKey, kind: 'w' | 'g', value: string): string {
  let id = keyIds.get(key);
  if (id === undefined) keyIds.set(key, (id = nextKeyId++));
  // digits, then one letter, then the value: unambiguous however long the value is.
  const memoKey = `${id}${kind}${value}`;
  const hit = lexemeMemo.get(memoKey);
  if (hit !== undefined) return hit;
  const h = createHmac('sha256', key).update(kind).update(':').update(value).digest();
  const lex = `x${h.subarray(0, 4).toString('hex')}`;
  if (lexemeMemo.size >= LEXEME_MEMO_MAX) lexemeMemo.clear();
  lexemeMemo.set(memoKey, lex);
  return lex;
}

/** Lowercase, and split on anything that is not a letter or a digit. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** A word as it is indexed: stemmed, and skipped when it could never be queried. */
export function indexableStem(word: string): string | null {
  if (Array.from(word).length < MIN_PREFIX || STOPWORDS.has(word)) return null;
  return stemmer(word);
}

function prefixesOf(stem: string): string[] {
  const cps = Array.from(stem);
  const out: string[] = [];
  const top = Math.min(cps.length, MAX_PREFIX);
  for (let n = MIN_PREFIX; n <= top; n++) out.push(cps.slice(0, n).join(''));
  if (cps.length > MAX_PREFIX) out.push(stem);
  return out;
}

/** Collapse whitespace so index and query agree on what "next to each other" means. */
export function normalizeForGrams(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function gramsOf(text: string): string[] {
  const cps = Array.from(normalizeForGrams(text));
  const out: string[] = [];
  for (let i = 0; i + 3 <= cps.length; i++) out.push(cps.slice(i, i + 3).join(''));
  return out;
}

/** Positions per lexeme -> tsvector literal text, e.g. `'x1a2b3c4d':1,4 'x9f8e7d6c':2`. */
function toTsvectorLiteral(map: Map<string, number[] | null>): string {
  const parts: string[] = [];
  for (const [lex, pos] of map) {
    parts.push(pos && pos.length > 0 ? `'${lex}':${pos.join(',')}` : `'${lex}'`);
  }
  return parts.join(' ');
}

/**
 * The words index for a piece of text. All prefixes of one word share that
 * word's position, so closeness between different words still means something
 * to `ts_rank_cd`.
 */
export function buildWordsVector(key: IndexKey, ...texts: Array<string | null | undefined>): string {
  const map = new Map<string, number[]>();
  let position = 0;
  for (const text of texts) {
    if (!text) continue;
    for (const word of wordsOf(text.slice(0, MAX_INDEXED_CHARS))) {
      const stem = indexableStem(word);
      if (!stem) continue;
      position = Math.min(position + 1, MAX_POSITION);
      for (const prefix of prefixesOf(stem)) {
        const lex = lexeme(key, 'w', prefix);
        let list = map.get(lex);
        if (!list) {
          if (map.size >= MAX_LEXEMES) continue;
          list = [];
          map.set(lex, list);
        }
        if (list.length < MAX_POSITIONS_PER_LEXEME && list[list.length - 1] !== position) list.push(position);
      }
    }
  }
  return toTsvectorLiteral(map);
}

/** The trigram index for short fields (subject, snippet, sender), every trigram. */
export function buildGramsVector(key: IndexKey, ...texts: Array<string | null | undefined>): string {
  const map = new Map<string, null>();
  for (const text of texts) {
    if (!text) continue;
    for (const g of gramsOf(text.slice(0, 2000))) {
      if (map.size >= MAX_LEXEMES) break;
      map.set(lexeme(key, 'g', g), null);
    }
  }
  return toTsvectorLiteral(map);
}

/**
 * Trigrams of the code-like tokens in a body: `ua512`, `kx8qp2`, an order or
 * confirmation number. A body is too large to trigram whole, and the prose in
 * it is already covered by the words index; codes are the thing that words
 * cannot find, because a search for `512` is inside the token `ua512`.
 */
export function buildCodeGramsVector(key: IndexKey, body: string | null | undefined): string {
  if (!body) return '';
  const map = new Map<string, null>();
  let tokens = 0;
  for (const token of wordsOf(body.slice(0, MAX_INDEXED_CHARS))) {
    if (token.length < CODE_MIN || token.length > CODE_MAX || !/\d/.test(token)) continue;
    if (++tokens > MAX_CODE_TOKENS) break;
    for (const g of gramsOf(token)) {
      if (map.size >= MAX_LEXEMES) break;
      map.set(lexeme(key, 'g', g), null);
    }
  }
  return toTsvectorLiteral(map);
}

export interface QueryTokens {
  /** tsquery text for the words index: `'x..' | 'x..'`, or null when nothing is queryable. */
  words: string | null;
  /** The distinct stems behind `words`, for building a highlight. */
  stems: string[];
}

/**
 * The words arm of a query. `keywords` are what `extractKeywords` returned, so
 * the token rules (length floor, stopwords, ascii-only) are the ones both
 * search surfaces already share. Each is stemmed and hashed exactly as a
 * document word's prefix is, so a query word matches any document word it is a
 * prefix of.
 */
export function buildWordsQuery(key: IndexKey, keywords: string[]): QueryTokens {
  const stems: string[] = [];
  const lexes = new Set<string>();
  for (const k of keywords) {
    // Both the word as typed and its stem. A typed prefix ("jos", "plumb") is a
    // prefix of a document stem as it stands, but stemming it can mangle it
    // ("jos" becomes "jo"); a full word ("schools") only matches once stemmed.
    // A candidate of up to 12 letters is one of a document word's prefixes; a
    // longer one matches the full stem, which is indexed too.
    for (const candidate of new Set([k, stemmer(k)])) {
      if (Array.from(candidate).length < MIN_PREFIX) continue;
      if (!stems.includes(candidate)) stems.push(candidate);
      lexes.add(`'${lexeme(key, 'w', candidate)}'`);
    }
  }
  return { words: lexes.size ? [...lexes].join(' | ') : null, stems };
}

/** The grams arm: every trigram of the literal, ANDed. Null when the literal is under 3 characters. */
export function buildGramsQuery(key: IndexKey, literal: string): string | null {
  const grams = Array.from(new Set(gramsOf(literal)));
  if (grams.length === 0) return null;
  return grams.map((g) => `'${lexeme(key, 'g', g)}'`).join(' & ');
}

/** A literal of exactly three characters is one trigram, so a gram hit needs no confirmation. */
export function literalNeedsConfirmation(literal: string): boolean {
  return Array.from(normalizeForGrams(literal)).length > 3;
}

/**
 * Highlight the words of a query in a piece of text, the way `ts_headline` did:
 * one fragment of about 18 words around the first hit, with matches in <b></b>.
 * Matching is by stem prefix, the same rule the index uses.
 */
export interface HeadlineOptions {
  open?: string;
  close?: string;
  /** Words in the fragment. */
  maxWords?: number;
  /** Words shown before the first hit. */
  lead?: number;
}

/** The forms a query word is matched as: as typed, and stemmed. Used to highlight. */
export function queryStems(keywords: string[]): string[] {
  const out: string[] = [];
  for (const k of keywords) {
    for (const candidate of new Set([k, stemmer(k)])) {
      if (Array.from(candidate).length >= MIN_PREFIX && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

export function headline(text: string, stems: string[], literal?: string, opts: HeadlineOptions = {}): string {
  const open = opts.open ?? '<b>';
  const close = opts.close ?? '</b>';
  const maxWords = opts.maxWords ?? 18;
  const lead = opts.lead ?? 6;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const matches = (word: string): boolean => {
    const w = word.toLowerCase();
    const s = stemmer(w);
    return stems.some((q) => s.startsWith(q) || w.startsWith(q));
  };
  const tokens = clean.split(' ');
  let first = tokens.findIndex((t) => wordsOf(t).some(matches));
  if (first < 0 && literal) {
    const lit = normalizeForGrams(literal);
    first = tokens.findIndex((t) => t.toLowerCase().includes(lit));
  }
  const from = Math.max(0, first < 0 ? 0 : first - lead);
  const to = Math.min(tokens.length, from + maxWords);
  // No ellipses: ts_headline with one fragment did not add any, and the search
  // box renders whatever this returns.
  const mark = (t: string): string => {
    if (first < 0) return t;
    const isHit = wordsOf(t).some(matches) || (literal ? t.toLowerCase().includes(normalizeForGrams(literal)) : false);
    return isHit ? `${open}${t}${close}` : t;
  };
  return tokens.slice(from, to).map(mark).join(' ');
}
