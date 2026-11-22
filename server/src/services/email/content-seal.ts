/**
 * The write side of mail encryption (ADR 0201): turn the content of a message
 * or a thread into what is stored, sealed columns plus the blind index built
 * from the plaintext.
 *
 * Every provider funnels a message through `upsertMessageMeta` and every
 * thread through `recomputeThread`, so those two call here and nothing else in
 * the sync path needs to know. The blind index is maintained whether or not
 * `CONTENT_ENCRYPTION` is on: search reads it, so it has to be current before
 * the switch is flipped, and a mailbox that is never switched on still
 * searches the same way.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';

import { indexKeyFor, sealField, sealJsonField } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import {
  buildCodeGramsVector,
  buildGramsVector,
  buildWordsVector,
  MAX_INDEXED_CHARS,
  type IndexKey,
} from '../../utils/blind-index.js';

const tsvector = (literal: string): RawBuilder<string> => sql<string>`${literal}::tsvector`;

const ctx = (table: string, column: string): string => `${table}:${column}`;

export interface MessageContent {
  subject?: string;
  snippet?: string;
  from_name?: string | null;
  from_email?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  body_excerpt?: string | null;
  ics_text?: string | null;
  /** JSON text of the parts list, as the providers already build it. */
  attachments_json?: string | null;
}

/**
 * Whether a message carries a file the reader would download: 1, 0, or null
 * when its parts are not known yet. A part with a Content-ID is an image shown
 * inside the body (a logo, a pasted photo), not an attachment. Kept in the
 * clear beside the sealed part list so the email list can show a paperclip
 * without decrypting every message, like the labels it already keeps clear.
 */
export function attachmentFlag(json: string | null): number | null {
  if (json === null) return null;
  try {
    const parts = JSON.parse(json) as { contentId?: string }[];
    return Array.isArray(parts) && parts.some((p) => !p.contentId) ? 1 : 0;
  } catch {
    return null;
  }
}

/** The text a body is indexed from: the full body once it is known, else the sync-time excerpt. */
function bodyForIndex(c: MessageContent): string | null | undefined {
  return c.body_text ?? c.body_excerpt;
}

/**
 * Sealed columns for whichever fields are present, plus the message's blind
 * columns. Absent fields are absent from the result, so an UPDATE that only
 * carries a body does not touch the subject.
 *
 * `indexBody` is false when the caller knows an existing full body must not be
 * displaced by an excerpt (the upsert conflict path), in which case the words
 * column is left for the caller to handle.
 */
export type BodyIndexMode =
  /** Insert: the words and code trigrams are always written, empty if there is no body yet. */
  | 'always'
  /** Update: written only when a body is present, so a body-less write never wipes an index. */
  | 'if-present'
  /** Upsert conflict: an excerpt may only stand in while no full body is stored. */
  | 'excerpt-until-full'
  | 'none';

export async function sealMessageContent(
  userId: string,
  c: MessageContent,
  opts: { index?: BodyIndexMode } = {},
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const t = 'email_messages';
  const seal = async (col: keyof MessageContent, value: string | null | undefined) => {
    if (value === undefined) return;
    out[col] = await sealField(userId, ctx(t, col), value);
  };
  await Promise.all([
    seal('subject', c.subject),
    seal('snippet', c.snippet),
    seal('from_name', c.from_name),
    seal('body_text', c.body_text),
    seal('body_html', c.body_html),
    seal('body_excerpt', c.body_excerpt),
    seal('ics_text', c.ics_text),
  ]);
  if (c.from_email !== undefined) out.from_email = c.from_email;
  if (c.attachments_json !== undefined) {
    out.attachments_json = await sealJsonField(userId, ctx(t, 'attachments_json'), c.attachments_json);
    out.has_attachments = attachmentFlag(c.attachments_json);
  }

  const key = await indexKeyFor(userId);
  const mode = opts.index ?? 'if-present';
  const body = bodyForIndex(c);
  const words = () => buildWordsVector(key, body);
  const codes = () => buildCodeGramsVector(key, body);
  if (mode === 'always') {
    out.blind_words = tsvector(words());
    out.blind_grams = tsvector(codes());
  } else if (mode === 'if-present' && body) {
    out.blind_words = tsvector(words());
    out.blind_grams = tsvector(codes());
  } else if (mode === 'excerpt-until-full' && body) {
    out.blind_words = sql`case when email_messages.body_text is null then ${tsvector(words())} else email_messages.blind_words end`;
    out.blind_grams = sql`case when email_messages.body_text is null then ${tsvector(codes())} else email_messages.blind_grams end`;
  }
  if (c.from_name !== undefined || c.from_email !== undefined) {
    out.blind_from = tsvector(buildGramsVector(key, `${c.from_name ?? ''} ${c.from_email ?? ''}`));
  }
  return out;
}

export interface ThreadContent {
  subject?: string;
  snippet?: string;
  from_name?: string | null;
  from_email?: string | null;
}

/** Sealed columns and the blind index for a thread's display fields, which are derived from its messages. */
export async function sealThreadContent(
  userId: string,
  c: Required<Pick<ThreadContent, 'subject' | 'snippet'>> & ThreadContent,
): Promise<Record<string, unknown>> {
  const t = 'email_threads';
  const [subject, snippet, fromName] = await Promise.all([
    sealField(userId, ctx(t, 'subject'), c.subject),
    sealField(userId, ctx(t, 'snippet'), c.snippet),
    sealField(userId, ctx(t, 'from_name'), c.from_name),
  ]);
  const key: IndexKey = await indexKeyFor(userId);
  const joined = [c.subject, c.snippet, c.from_name, c.from_email].filter(Boolean).join(' ');
  return {
    subject,
    snippet,
    from_name: fromName,
    from_email: c.from_email ?? null,
    blind_words: tsvector(buildWordsVector(key, c.subject, c.snippet, c.from_name, c.from_email)),
    blind_grams: tsvector(buildGramsVector(key, joined)),
    blind_from: tsvector(buildGramsVector(key, `${c.from_name ?? ''} ${c.from_email ?? ''}`)),
  };
}

/**
 * The same, for a caller that has the thread's id but not its owner: the magics
 * pass writes a fact once per thread it reads, so one lookup is negligible.
 */
export async function sealThreadJsonFor(
  db: Kysely<DB>,
  threadId: string,
  column: string,
  value: unknown,
): Promise<string | null> {
  const row = await db.selectFrom('email_threads').select('user_id').where('id', '=', threadId).executeTakeFirst();
  if (!row) return value === null ? null : JSON.stringify(value);
  return sealThreadJson(row.user_id, column, value);
}

/** A structured fact stored on a thread (delivery, flight, receipt, advisory). */
export function sealThreadJson(userId: string, column: string, value: unknown): Promise<string | null> {
  return sealJsonField(userId, ctx('email_threads', column), value === null ? null : JSON.stringify(value));
}

export { MAX_INDEXED_CHARS };
