/**
 * The blind index (ADR 0201), tested without a database by simulating what
 * Postgres does with the two shapes it stores: an OR of lexemes for words
 * (`a | b`) and an AND for trigrams (`a & b`). The point is not the happy
 * path, it is that a search still finds what it found before, that nothing
 * readable is stored, and that the index stays bounded.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildCodeGramsVector,
  buildGramsQuery,
  buildGramsVector,
  buildWordsQuery,
  buildWordsVector,
  gramsOf,
  headline,
  indexableStem,
  literalNeedsConfirmation,
  normalizeForGrams,
  wordsOf,
} from '../blind-index.js';
import { extractKeywords } from '../keywords.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

/** A tsvector literal back into lexeme -> positions. */
function parse(vector: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const re = /'(x[0-9a-f]{8})'(?::([\d,]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vector))) out.set(m[1]!, m[2] ? m[2].split(',').map(Number) : []);
  return out;
}

/** `'a' | 'b'` matches when any lexeme is in the vector; `'a' & 'b'` when all are. */
function matches(vector: string, query: string | null): boolean {
  if (!query) return false;
  const have = parse(vector);
  const lex = (s: string) => s.match(/x[0-9a-f]{8}/g) ?? [];
  return query.includes('&') ? lex(query).every((l) => have.has(l)) : lex(query).some((l) => have.has(l));
}

const words = (doc: string, key = KEY) => buildWordsVector(key, doc);
const wordQ = (q: string, key = KEY) => buildWordsQuery(key, extractKeywords(q)).words;

describe('what a word search finds', () => {
  it('stems: "schools" finds "School pickup", "cancel" finds "cancelled"', () => {
    expect(matches(words('School pickup'), wordQ('schools'))).toBe(true);
    expect(matches(words('Your booking was cancelled'), wordQ('cancel'))).toBe(true);
    expect(matches(words('The plumber is coming'), wordQ('plumbers'))).toBe(true);
  });

  it('matches a prefix: "plumb" finds "plumber", "schoo" finds "school"', () => {
    expect(matches(words('The plumber is coming'), wordQ('plumb'))).toBe(true);
    expect(matches(words('School pickup'), wordQ('schoo'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matches(words('PLUMBER visit'), wordQ('plumber'))).toBe(true);
    expect(matches(words('plumber visit'), wordQ('PLUMBER'))).toBe(true);
  });

  it('ORs the query words: one is enough', () => {
    expect(matches(words('The plumber is coming'), wordQ('plumber xyzzynonword'))).toBe(true);
  });

  it('does not match a word that is not there', () => {
    expect(matches(words('The plumber is coming'), wordQ('electrician'))).toBe(false);
  });

  it('a query word longer than the indexed prefix still matches the full stem', () => {
    // 12-letter prefixes are indexed, and a longer stem is indexed whole.
    expect(matches(words('Internationalization schedule'), wordQ('internationalization'))).toBe(true);
  });

  it('accents are kept, not folded (pinned: José finds José, jose does not)', () => {
    // The query loses the accent ("jos"), which is a prefix of the indexed "josé".
    expect(matches(words('José Núñez'), wordQ('José'))).toBe(true);
    expect(matches(words('José Núñez'), wordQ('jose'))).toBe(false);
  });

  it('a typed prefix is matched as typed, not only after stemming', () => {
    // Porter turns "jos" into "jo" and "plumbe" into "plumb"; the as-typed form
    // is what a prefix of a document stem looks like.
    expect(matches(words('Josephine visits'), wordQ('jos'))).toBe(true);
    expect(matches(words('The plumber'), wordQ('plumbe'))).toBe(true);
  });

  it('indexes an address as its words', () => {
    expect(matches(words('chen@school.example'), wordQ('school'))).toBe(true);
  });

  it('never indexes what a query cannot ask for: stopwords and words under 3 letters', () => {
    expect(words('to be or the of it')).toBe('');
    expect(indexableStem('the')).toBeNull();
    expect(indexableStem('at')).toBeNull();
    expect(indexableStem('school')).toBe('school');
  });

  it('gives a query with no usable words no query', () => {
    expect(wordQ('the of')).toBeNull();
    expect(wordQ('ab')).toBeNull();
    expect(wordQ('')).toBeNull();
  });
});

describe('what a literal search finds', () => {
  const grams = (doc: string, key = KEY) => buildGramsVector(key, doc);
  const gramQ = (q: string, key = KEY) => buildGramsQuery(key, q);

  it('a code inside a token: "512" finds "UA512", "ua512" finds "Booking UA512"', () => {
    expect(matches(grams('Booking UA512 confirmed'), gramQ('512'))).toBe(true);
    expect(matches(grams('Booking UA512 confirmed'), gramQ('ua512'))).toBe(true);
  });

  it('punctuation and wildcards are ordinary characters: "50%", "a_b", a domain', () => {
    expect(matches(grams('Everything 50% off'), gramQ('50%'))).toBe(true);
    expect(matches(grams('Ticket a_b confirmed'), gramQ('a_b'))).toBe(true);
    expect(matches(grams('office@lcps.example'), gramQ('lcps.example'))).toBe(true);
    expect(matches(grams('Path C:\\temp\\report'), gramQ('c:\\temp'))).toBe(true);
  });

  it('non-latin text works, which words cannot do', () => {
    expect(matches(grams('学校の連絡 明日'), gramQ('学校の連絡'))).toBe(true);
  });

  it('is case-insensitive and treats runs of whitespace as one', () => {
    expect(matches(grams('Booking   UA512'), gramQ('booking ua512'))).toBe(true);
  });

  it('a query needs three characters', () => {
    expect(gramQ('ab')).toBeNull();
    expect(gramQ('')).toBeNull();
    expect(gramQ('abc')).not.toBeNull();
  });

  it('does not match text that lacks the pieces', () => {
    expect(matches(grams('Booking UA512 confirmed'), gramQ('zzz999'))).toBe(false);
  });

  it('every trigram present is NOT the same as the text being present: the caller must confirm', () => {
    // "bca abc cab" holds every trigram of "bcabc" (bca, cab, abc) without the
    // substring. That is why a literal longer than one trigram is verified
    // against the opened text before it counts.
    const doc = 'bca abc cab';
    expect(matches(grams(doc), gramQ('bcabc'))).toBe(true);
    expect(normalizeForGrams(doc).includes(normalizeForGrams('bcabc'))).toBe(false);
    expect(literalNeedsConfirmation('bcab')).toBe(true);
    expect(literalNeedsConfirmation('abc')).toBe(false);
    expect(literalNeedsConfirmation('ab')).toBe(false);
  });

  it('a code-like token in a body is found by its inside, plain prose is not indexed as grams', () => {
    const body = 'Please quote confirmation code KX8QP2 at the desk. Flight UA512 departs at nine.';
    const codes = buildCodeGramsVector(KEY, body);
    expect(matches(codes, gramQ('kx8qp2'))).toBe(true);
    expect(matches(codes, gramQ('512'))).toBe(true);
    expect(matches(codes, gramQ('desk'))).toBe(false);
    expect(matches(codes, gramQ('confirmation'))).toBe(false);
  });
});

describe('what the stored index reveals', () => {
  it('contains only opaque lexemes, never a word or a fragment of one', () => {
    const doc = 'Confirmation KX8QP2 for the plumber at 42 Oak Street, Loudoun County';
    for (const v of [words(doc), buildGramsVector(KEY, doc), buildCodeGramsVector(KEY, doc)]) {
      const stripped = v.replace(/'x[0-9a-f]{8}'(:[\d,]+)?/g, '').trim();
      expect(stripped).toBe(''); // nothing but lexemes and positions
      for (const readable of ['plumber', 'plum', 'confirm', 'oak', 'loudoun', 'kx8']) {
        expect(v.toLowerCase()).not.toContain(readable);
      }
    }
  });

  it('is keyed: the same text under another key shares no lexeme', () => {
    const a = parse(words('The plumber is coming Tuesday'));
    const b = parse(words('The plumber is coming Tuesday', OTHER_KEY));
    expect([...a.keys()].filter((k) => b.has(k))).toEqual([]);
    expect(matches(words('The plumber is coming', OTHER_KEY), wordQ('plumber'))).toBe(false);
  });

  it('is deterministic for one key, so a query built later finds a document built earlier', () => {
    expect(words('School pickup')).toBe(words('School pickup'));
    expect(buildGramsVector(KEY, 'ua512')).toBe(buildGramsVector(KEY, 'ua512'));
  });

  it('keeps word frequency as positions, so repeated words rank higher', () => {
    const once = parse(words('zebrafish care'));
    const thrice = parse(words('zebrafish zebrafish zebrafish care'));
    const lex = [...once.keys()].find((k) => once.get(k)!.length === 1 && thrice.get(k)?.length === 3);
    expect(lex).toBeDefined();
  });
});

describe('the index is bounded', () => {
  it('a 200 KB body stays inside the tsvector size limit and the lexeme cap', () => {
    const body = Array.from({ length: 30_000 }, (_, i) => `word${i} plumber${i % 500}`).join(' ');
    const v = words(body);
    const parsed = parse(v);
    expect(v.length).toBeLessThan(900_000); // Postgres limits a tsvector to 1 MB
    expect(parsed.size).toBeLessThanOrEqual(20_000);
    for (const pos of parsed.values()) {
      expect(pos.length).toBeLessThanOrEqual(200);
      expect(Math.max(...pos, 0)).toBeLessThanOrEqual(16_383);
    }
  });

  it('a body of nothing but codes is capped', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `code${i}x9`).join(' ');
    expect(parse(buildCodeGramsVector(KEY, body)).size).toBeLessThanOrEqual(20_000);
  });

  it('positions are strictly increasing per lexeme', () => {
    for (const pos of parse(words('plumber leak plumber sink plumber')).values()) {
      expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    }
  });

  it('empty and missing input give an empty vector, not an error', () => {
    expect(words('')).toBe('');
    expect(buildWordsVector(KEY, null, undefined)).toBe('');
    expect(buildGramsVector(KEY, '')).toBe('');
    expect(buildCodeGramsVector(KEY, null)).toBe('');
  });
});

describe('helpers', () => {
  it('wordsOf splits on anything that is not a letter or a digit, keeping unicode letters', () => {
    expect(wordsOf("O'Brien's e-mail, 学校 café_42")).toEqual(['o', 'brien', 's', 'e', 'mail', '学校', 'café', '42']);
  });

  it('normalizeForGrams lowercases and collapses whitespace', () => {
    expect(normalizeForGrams('  Booking   UA512\n')).toBe('booking ua512');
  });

  it('gramsOf slides a three-character window over code points, not UTF-16 units', () => {
    expect(gramsOf('abcd')).toEqual(['abc', 'bcd']);
    expect(gramsOf('a😀b')).toEqual(['a😀b']);
    expect(gramsOf('ab')).toEqual([]);
  });
});

describe('headline', () => {
  const text =
    'Hello parents. We wanted to let you know that the school pickup time is changing next week because of the assembly on Tuesday morning.';

  it('marks the matching words and windows around the first hit', () => {
    const h = headline(text, ['school']);
    expect(h).toContain('<b>school</b>');
    expect(h.split(' ').length).toBeLessThanOrEqual(19);
  });

  it('marks by stem, so "schools" highlights "school"', () => {
    expect(headline(text, ['school'])).toContain('<b>school</b>');
    expect(headline('Two schools closed today', ['school'])).toContain('<b>schools</b>');
  });

  it('cuts a long text down to a window around the hit, without adding ellipses', () => {
    const h = headline(text, ['assembly']);
    expect(h).toContain('<b>assembly</b>');
    expect(h.startsWith('Hello parents')).toBe(false);
    expect(h).not.toContain('…');
  });

  it('falls back to the literal when no stem matches', () => {
    expect(headline('Booking UA512 confirmed', [], '512')).toContain('<b>UA512</b>');
  });

  it('with no match it returns the start of the text unmarked', () => {
    const h = headline(text, ['zebrafish']);
    expect(h).not.toContain('<b>');
    expect(h.startsWith('Hello parents')).toBe(true);
  });

  it('is empty for empty text', () => {
    expect(headline('   ', ['school'])).toBe('');
  });
});
