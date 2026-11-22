/**
 * Email thread search over the blind index (ADR 0201).
 *
 * One implementation behind both search surfaces (the bot tool and the search
 * box), which used to carry two copies of the same predicate and were kept
 * honest by a parity test (ADR 0085). With the words and literals hashed, the
 * match is a candidate query in SQL followed by a confirmation in the
 * application, and that shape is not something to write twice.
 *
 * A row matches a free-text query when any of these hold:
 *   words     a stemmed query word is a prefix of a word in the thread's own
 *             text, or in any of its messages;
 *   literal   every trigram of the query is present in the thread's subject,
 *             snippet or sender, or in a code-like token of a message body,
 *             and, for a literal longer than one trigram, the text really does
 *             contain it (trigrams say every piece is present, not adjacent);
 *   legacy    the old plaintext tsvector and LIKE, while rows that predate the
 *             index exist (`CONTENT_LEGACY_TSV`).
 * Operators (`from:`, `has:attachment`, dates, `label:`) narrow the result and
 * are ANDed on top; an operator with no free text is a legitimate query.
 */
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely';

import type { EmailAction } from '@chord/kernel';

import { env } from '../../config/env.js';
import { indexKeyFor } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { instantMs, textInstant } from '../../db/text-instant.js';
import {
  buildGramsQuery,
  buildWordsQuery,
  headline,
  literalNeedsConfirmation,
  normalizeForGrams,
} from '../../utils/blind-index.js';
import { extractKeywords, literalQueryUsable } from '../../utils/keywords.js';
import { searchablePredicate, searchLabelPredicate } from './folders.js';
import type { NamedAddress } from './person-resolve.js';

export interface EmailSearchInput {
  userId: string;
  /** The free text left after operators were lifted out. */
  text: string;
  /** A category the classifier filed the query under: replaces the text arm. */
  categoryIds?: string[] | null;
  /** Substring of the sender's name or address: a sender nobody could resolve. */
  from?: string;
  /** ADR 0270: exact sender addresses / domains, matched on ANY message in the thread. */
  fromAddresses?: string[];
  /** Shared robot addresses, each matched only with the sender's name. */
  fromNamed?: NamedAddress[];
  fromDomains?: string[];
  /** Exact recipient addresses / domains (To or Cc), for mail the user sent. */
  toAddresses?: string[];
  toDomains?: string[];
  /** Only threads the classifier gave one of these actions. */
  actions?: EmailAction[];
  /** Only threads carrying this kind of fact. */
  kind?: EmailFactKind;
  hasAttachment?: boolean;
  /** Only threads with an unread message. */
  unread?: boolean;
  after?: string;
  before?: string;
  label?: string;
  /** Only these threads (ADR 0276: the meaning matches, still under every filter). */
  onlyIds?: string[];
  limit: number;
  order: 'rank' | 'recent';
  /** The search box shows a highlighted excerpt; the bot tool does not. */
  withHeadline?: boolean;
}

export interface EmailSearchHit {
  id: string;
  subject: string;
  snippet: string;
  fromName: string | null;
  fromEmail: string | null;
  lastMessageAt: string;
  action: EmailAction | null;
  score: number;
  headline: string;
}

/** Candidate windows read before giving up on filling `limit`. */
const MAX_PAGES = 5;
/** Query words scored one by one; the rest still match, they just do not add. */
const MAX_TERMS = 8;

export type EmailFactKind = 'receipt' | 'delivery' | 'flight' | 'invite';

const asBool = (e: Expression<SqlBool>, alias: string) => sql<boolean>`${e}`.as(alias);

/** The old plaintext tsquery, for rows that have not been through the index yet. */
function legacyTsQuery(keywords: string[]): string | null {
  const cleaned = keywords.map((k) => k.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase()).filter((k) => k.length >= 3);
  return cleaned.length ? cleaned.map((k) => `${k}:*`).join(' | ') : null;
}

const likeEscape = (s: string, esc: string): string => s.replace(new RegExp(`[${esc === '\\' ? '\\\\' : esc}%_]`, 'g'), `${esc}$&`);

export async function findEmailThreads(db: Kysely<DB>, input: EmailSearchInput): Promise<EmailSearchHit[]> {
  const text = input.text.toLowerCase().trim();
  const keywords = extractKeywords(input.text);
  const useLiteral = literalQueryUsable(text);
  const hasFrom = input.from !== undefined;
  const fromText = (input.from ?? '').toLowerCase();
  const hasTextArm = text.length > 0;
  const categoryIds = input.categoryIds && input.categoryIds.length > 0 ? input.categoryIds : null;

  const key = await indexKeyFor(input.userId, false);
  const words = key ? buildWordsQuery(key, keywords) : { words: null, stems: [] as string[] };
  const gramsQ = key && useLiteral ? buildGramsQuery(key, text) : null;
  const fromGramsQ = key && hasFrom && Array.from(fromText).length >= 3 ? buildGramsQuery(key, fromText) : null;
  const legacyOn = env.CONTENT_LEGACY_TSV;
  const legacyTsq = legacyOn ? legacyTsQuery(keywords) : null;
  const legacyLike = legacyOn && useLiteral ? `%${likeEscape(text, '\\')}%` : null;

  const wq = words.words ? sql`${words.words}::tsquery` : null;
  const gq = gramsQ ? sql`${gramsQ}::tsquery` : null;
  const uid = input.userId;
  const inMessages = (pred: Expression<SqlBool>) =>
    sql<boolean>`exists (select 1 from email_messages m where m.thread_id = e.id and m.user_id = ${uid} and ${pred})`;

  // ── the text arm ───────────────────────────────────────────────────
  const wordHit: Expression<SqlBool> = wq
    ? sql<boolean>`(e.blind_words @@ ${wq} or ${inMessages(sql<boolean>`m.blind_words @@ ${wq}`)})`
    : sql<boolean>`false`;
  // Rows written before the index have plaintext columns and Postgres-generated
  // tsvectors, on the thread AND on each message (the body). Same predicate the
  // two surfaces used before, kept until the backfill has run and the columns
  // are dropped. It applies ONLY to rows with no blind index: a sealed row's
  // legacy columns hold ciphertext, and a LIKE over base64 matches short queries
  // by accident.
  const legacyThread: Expression<SqlBool> =
    legacyTsq || legacyLike
      ? sql<boolean>`(e.blind_words is null and (${legacyTsq ? sql`e.search_tsv @@ to_tsquery('english', ${legacyTsq})` : sql`false`} or ${
          legacyLike
            ? sql`lower(coalesce(e.subject,'') || ' ' || coalesce(e.snippet,'') || ' ' || coalesce(e.from_name,'') || ' ' || coalesce(e.from_email,'')) like ${legacyLike} escape '\\'`
            : sql`false`
        }))`
      : sql<boolean>`false`;
  const legacyMessage: Expression<SqlBool> =
    legacyTsq || legacyLike
      ? sql<boolean>`(m.blind_words is null and (${legacyTsq ? sql`m.search_tsv @@ to_tsquery('english', ${legacyTsq})` : sql`false`} or ${
          legacyLike ? sql`lower(coalesce(m.body_text, '')) like ${legacyLike} escape '\\'` : sql`false`
        }))`
      : sql<boolean>`false`;
  const legacyHit: Expression<SqlBool> =
    legacyTsq || legacyLike ? sql<boolean>`(${legacyThread} or ${inMessages(legacyMessage)})` : sql<boolean>`false`;
  const gramThread: Expression<SqlBool> = gq ? sql<boolean>`(e.blind_grams @@ ${gq})` : sql<boolean>`false`;
  const gramBody: Expression<SqlBool> = gq ? inMessages(sql<boolean>`m.blind_grams @@ ${gq}`) : sql<boolean>`false`;

  const arms: Expression<SqlBool>[] = [];
  if (wq) arms.push(wordHit);
  if (gq) arms.push(gramThread, gramBody);
  if (legacyTsq || legacyLike) arms.push(legacyHit);
  const fromAddresses = (input.fromAddresses ?? []).map((a) => a.toLowerCase());
  const fromDomains = (input.fromDomains ?? []).map((d) => d.toLowerCase());
  const fromNamed = (input.fromNamed ?? []).map((n) => ({ email: n.email.toLowerCase(), words: n.words }));
  const toAddresses = (input.toAddresses ?? []).map((a) => a.toLowerCase());
  const toDomains = (input.toDomains ?? []).map((d) => d.toLowerCase());
  const narrowed =
    hasFrom ||
    fromAddresses.length > 0 ||
    fromDomains.length > 0 ||
    toAddresses.length > 0 ||
    toDomains.length > 0 ||
    (input.actions?.length ?? 0) > 0 ||
    input.kind !== undefined ||
    !!input.hasAttachment ||
    !!input.unread ||
    !!input.after ||
    !!input.before ||
    !!input.label;
  if (hasTextArm && arms.length === 0 && !narrowed && !categoryIds) {
    return [];
  }

  // ── from: ─────────────────────────────────────────────────────────
  const fromLike = `%${likeEscape(fromText, '~')}%`;
  const fromEmailHit: Expression<SqlBool> = hasFrom
    ? legacyOn
      ? // A row with no blind index still has a readable name, so the old name-or-address LIKE answers for it.
        sql<boolean>`(lower(coalesce(e.from_email,'')) like ${fromLike} escape '~' or (e.blind_from is null and lower(coalesce(e.from_name,'')) like ${fromLike} escape '~'))`
      : sql<boolean>`lower(coalesce(e.from_email,'')) like ${fromLike} escape '~'`
    : sql<boolean>`false`;
  const fromGramHit: Expression<SqlBool> = fromGramsQ ? sql<boolean>`(e.blind_from @@ ${sql`${fromGramsQ}::tsquery`})` : sql<boolean>`false`;

  const rankParts: Expression<number>[] = [];
  if (wq) {
    rankParts.push(sql<number>`coalesce(ts_rank_cd(e.blind_words, ${wq}), 0)`);
    rankParts.push(
      sql<number>`coalesce((select max(ts_rank_cd(m.blind_words, ${wq})) from email_messages m where m.thread_id = e.id and m.user_id = ${uid}), 0)`,
    );
  }
  if (legacyTsq) {
    // Only rows that predate the index: a sealed row's legacy tsvector is built
    // over ciphertext and its score means nothing.
    rankParts.push(sql<number>`(case when e.blind_words is null then coalesce(ts_rank_cd(e.search_tsv, to_tsquery('english', ${legacyTsq})), 0) else 0 end)`);
    rankParts.push(
      sql<number>`coalesce((select max(ts_rank_cd(m.search_tsv, to_tsquery('english', ${legacyTsq}))) from email_messages m where m.thread_id = e.id and m.user_id = ${uid} and m.blind_words is null), 0)`,
    );
  }
  const score = rankParts.length ? sql<number>`greatest(${sql.join(rankParts)})` : sql<number>`0`;

  const verifyHeavy = gq !== null || fromGramsQ !== null;
  // Ranked: a wide candidate window, re-scored below by how many of the query's
  // words each thread matches and where. Recent: the newest that match.
  const fetchLimit =
    input.order === 'rank' && hasTextArm ? Math.max(input.limit * 8, 80) : verifyHeavy ? input.limit * 3 : input.limit;
  const inCategory: Expression<SqlBool> = categoryIds
    ? sql<boolean>`e.category_id in (${sql.join(categoryIds)})`
    : sql<boolean>`false`;

  let qb = db
    .selectFrom('email_threads as e')
    .select([
      'e.id as id',
      'e.subject as subject',
      'e.snippet as snippet',
      'e.from_name as fromName',
      'e.from_email as fromEmail',
      'e.last_message_at as lastMessageAt',
      'e.action as action',
      score.as('score'),
      asBool(wordHit, 'wordHit'),
      asBool(legacyHit, 'legacyHit'),
      asBool(gramThread, 'gramThread'),
      asBool(gramBody, 'gramBody'),
      asBool(fromEmailHit, 'fromEmailHit'),
      asBool(fromGramHit, 'fromGramHit'),
      asBool(inCategory, 'inCategory'),
    ])
    .where('e.user_id', '=', uid)
    .where(searchablePredicate('e.'));

  // ADR 0271: a category the query names is ADDED to the keyword matches and
  // boosted, not swapped in for them (ADR 0152 replaced them). The newsletter
  // that made 0152 replace is handled in scoring: outside the category, a
  // thread matching one word only in a body is dropped.
  if (categoryIds && hasTextArm && arms.length > 0) {
    qb = qb.where((eb) => eb.or([inCategory, ...arms]));
  } else if (categoryIds) {
    qb = qb.where(inCategory);
  } else if (hasTextArm && arms.length > 0) {
    qb = qb.where((eb) => eb.or(arms));
  }
  if (hasFrom) {
    qb = qb.where((eb) => eb.or([fromEmailHit, ...(fromGramsQ ? [fromGramHit] : [])]));
  }
  if (input.hasAttachment === true) {
    qb = qb.where(
      sql<boolean>`exists (
        select 1 from email_messages m
        where m.thread_id = e.id and m.user_id = ${uid}
          and m.attachments_json is not null and m.attachments_json <> '[]'
      )`,
    );
  }
  // ADR 0270: a person is matched on EVERY message of the thread, not just the
  // latest — a thread Bill started and the user answered last is still mail
  // from Bill — and by exact address, never substring (billing@ is not Bill).
  if (fromAddresses.length > 0 || fromDomains.length > 0 || fromNamed.length > 0) {
    const named = fromNamed.map((n) => {
      const grams = key ? n.words.map((w) => buildGramsQuery(key, w)).filter((g): g is string => !!g) : [];
      const byGrams = grams.length ? sql<boolean>`m.blind_from @@ ${grams.join(' & ')}::tsquery` : sql<boolean>`false`;
      const byLegacy = legacyOn
        ? sql<boolean>`(m.blind_from is null and ${sql.join(
            n.words.map((w) => sql`lower(coalesce(m.from_name, '')) like ${`%${likeEscape(w, '\\')}%`} escape '\\'`),
            sql` and `,
          )})`
        : sql<boolean>`false`;
      return sql<boolean>`(lower(m.from_email) = ${n.email} and (${byGrams} or ${byLegacy}))`;
    });
    qb = qb.where(
      inMessages(
        sql<boolean>`(lower(m.from_email) = any(${fromAddresses}::text[]) or split_part(lower(m.from_email), '@', 2) = any(${fromDomains}::text[])${
          named.length ? sql` or ${sql.join(named, sql` or `)}` : sql``
        })`,
      ),
    );
  }
  if (toAddresses.length > 0 || toDomains.length > 0) {
    qb = qb.where(
      sql<boolean>`exists (
        select 1 from email_messages m, jsonb_array_elements_text(m.to_emails || m.cc_emails) as r(addr)
        where m.thread_id = e.id and m.user_id = ${uid}
          and (lower(r.addr) = any(${toAddresses}::text[]) or split_part(lower(r.addr), '@', 2) = any(${toDomains}::text[]))
      )`,
    );
  }
  if (input.unread === true) qb = qb.where('e.is_unread', '=', 1);
  if (input.actions && input.actions.length > 0) qb = qb.where('e.action', 'in', input.actions);
  if (input.kind === 'receipt') qb = qb.where('e.receipt_json', 'is not', null);
  if (input.kind === 'delivery') qb = qb.where('e.delivery_json', 'is not', null);
  if (input.kind === 'flight') qb = qb.where('e.flight_json', 'is not', null);
  if (input.kind === 'invite') {
    qb = qb.where(inMessages(sql<boolean>`coalesce(m.ics_text, '') <> ''`));
  }
  // Timestamps are text in mixed offsets: compare instants, never strings.
  if (input.after !== undefined) qb = qb.where(sql<boolean>`${textInstant('e.last_message_at')} >= ${input.after}::timestamptz`);
  if (input.before !== undefined) qb = qb.where(sql<boolean>`${textInstant('e.last_message_at')} <= ${input.before}::timestamptz`);
  if (input.label !== undefined) qb = qb.where(searchLabelPredicate(input.label, 'e.'));
  if (input.onlyIds) {
    if (input.onlyIds.length === 0) return [];
    qb = qb.where('e.id', 'in', input.onlyIds);
  }

  const ordered =
    input.order === 'rank'
      ? qb.orderBy('score', 'desc').orderBy('e.last_message_at', 'desc')
      : qb.orderBy('e.last_message_at', 'desc');
  type Row = Awaited<ReturnType<typeof ordered.execute>>[number];

  // ── confirm candidates ────────────────────────────────────────────
  // A window of candidates at a time: when confirmation rejects most of one
  // (a short literal whose trigrams are everywhere), the next is read rather
  // than stopping at whatever survived the first.
  const literal = normalizeForGrams(text);
  const literalChecks = literalNeedsConfirmation(text);
  const fromNorm = normalizeForGrams(fromText);
  const kept: Row[] = [];
  const ranking = input.order === 'rank' && hasTextArm;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await ordered.limit(fetchLimit).offset(page * fetchLimit).execute();
    for (const r of rows) {
      if (await confirmed(r)) kept.push(r);
      if (!ranking && kept.length >= input.limit) break;
    }
    if (kept.length >= input.limit || rows.length < fetchLimit) break;
  }

  async function confirmed(r: Row): Promise<boolean> {
    if (hasTextArm && arms.length > 0 && !r.inCategory) {
      let ok = r.wordHit || r.legacyHit;
      if (!ok && (r.gramThread || r.gramBody)) {
        if (!literalChecks) {
          ok = true;
        } else {
          const own = normalizeForGrams([r.subject, r.snippet, r.fromName, r.fromEmail].filter(Boolean).join(' '));
          ok = own.includes(literal);
          if (!ok && r.gramBody && gq) {
            const bodies = await db
              .selectFrom('email_messages as m')
              .select('m.body_text as body')
              .where('m.thread_id', '=', r.id)
              .where('m.user_id', '=', uid)
              .where(sql<boolean>`m.blind_grams @@ ${gq}`)
              .execute();
            ok = bodies.some((b) => normalizeForGrams(b.body ?? '').includes(literal));
          }
        }
      }
      if (!ok) return false;
    }
    if (hasFrom) {
      let ok = r.fromEmailHit;
      if (!ok && r.fromGramHit) {
        ok = !literalNeedsConfirmation(fromText)
          ? true
          : normalizeForGrams(`${r.fromName ?? ''} ${r.fromEmail ?? ''}`).includes(fromNorm);
      }
      if (!ok) return false;
    }
    return true;
  }

  const top = (ranking ? await rerank(kept) : kept).slice(0, input.limit);

  /**
   * ADR 0271 — order by how well a thread matches, not by date alone:
   *   every query word the thread matches counts, twice when it is in the
   *   thread's own subject / snippet / sender rather than only in a body;
   *   a thread in a category the query names is boosted; and a small recency
   *   factor breaks near-ties toward the newer thread.
   * A thread outside that category matching one word only in a body is dropped
   * when a category matched - the ADR 0152 newsletter that mentions "school"
   * once - since the category already answers for the topic.
   */
  async function rerank(rows: Row[]): Promise<Row[]> {
    if (rows.length === 0) return rows;
    const terms = key ? keywords.slice(0, MAX_TERMS).map((k) => buildWordsQuery(key, [k]).words).filter((w): w is string => !!w) : [];
    const coverage = new Map<string, number>();
    if (terms.length > 0) {
      const ids = rows.map((r) => r.id);
      const cols = terms.flatMap((t, i) => [
        sql<boolean>`(e.blind_words @@ ${t}::tsquery)`.as(`t${i}`),
        sql<boolean>`exists (select 1 from email_messages m where m.thread_id = e.id and m.user_id = ${uid} and m.blind_words @@ ${t}::tsquery)`.as(`b${i}`),
      ]);
      const flags = await db.selectFrom('email_threads as e').select(['e.id as id', ...cols]).where('e.id', 'in', ids).execute();
      for (const f of flags) {
        const rec = f as unknown as Record<string, unknown>;
        let c = 0;
        for (let i = 0; i < terms.length; i++) c += rec[`t${i}`] ? 2 : rec[`b${i}`] ? 1 : 0;
        coverage.set(f.id, c);
      }
    }
    const now = Date.now();
    const n = Math.max(terms.length, 1);
    const scored = rows.flatMap((r) => {
      let c = coverage.get(r.id) ?? 0;
      // A literal ("UA512") or a pre-index row has no per-word flags: it
      // matched the whole query, in its own text or a body.
      if (c === 0 && (r.gramThread || r.gramBody || r.legacyHit)) c = n * (r.gramThread ? 2 : 1);
      if (categoryIds && !r.inCategory && c <= 1) return [];
      const ageDays = Math.max(0, (now - instantMs(r.lastMessageAt)) / 86_400_000);
      const recency = 1 + 0.15 * Math.exp(-ageDays / 90);
      const s = (c * 4 + Number(r.score) * 10 + (r.inCategory ? 6 : 0)) * recency;
      return [{ r, s }];
    });
    scored.sort((a, b) => b.s - a.s || instantMs(b.r.lastMessageAt) - instantMs(a.r.lastMessageAt));
    return scored.map((x) => Object.assign(x.r, { score: x.s }));
  }

  // ── headline (search box only) ───────────────────────────────────
  const excerpts = new Map<string, string>();
  if (input.withHeadline && top.length > 0 && (wq || gq || legacyTsq || legacyLike)) {
    const ids = top.map((r) => r.id);
    const parts: Expression<SqlBool>[] = [];
    if (wq) parts.push(sql<boolean>`m.blind_words @@ ${wq}`);
    if (gq) parts.push(sql<boolean>`m.blind_grams @@ ${gq}`);
    if (legacyTsq || legacyLike) parts.push(legacyMessage);
    const match = sql<boolean>`(${sql.join(parts, sql` or `)})`;
    const bodies = await db
      .selectFrom('email_messages as m')
      .select(['m.thread_id as threadId', 'm.body_text as bodyText', 'm.body_excerpt as bodyExcerpt'])
      .where('m.user_id', '=', uid)
      .where('m.thread_id', 'in', ids)
      .where(match)
      .orderBy('m.thread_id')
      .orderBy('m.internal_date', 'desc')
      .execute();
    for (const b of bodies) {
      if (!excerpts.has(b.threadId)) excerpts.set(b.threadId, (b.bodyText ?? b.bodyExcerpt ?? '').slice(0, 4000));
    }
  }

  return top.map((r) => {
    const source = `${r.subject ?? ''} ${excerpts.get(r.id) || r.snippet || ''}`;
    return {
      id: r.id,
      subject: r.subject,
      snippet: r.snippet,
      fromName: r.fromName,
      fromEmail: r.fromEmail,
      lastMessageAt: r.lastMessageAt,
      action: r.action,
      score: Number(r.score),
      headline: input.withHeadline ? headline(source, words.stems, useLiteral ? text : undefined) : '',
    };
  });
}
