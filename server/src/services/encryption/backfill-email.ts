/**
 * Seal the mail that predates content encryption and build its blind index
 * (ADR 0201, phase 3).
 *
 * Reads raw (no decrypt plugin) so it sees exactly what is stored: plaintext
 * gets sealed, already-sealed values are opened only to build the index. Safe
 * to stop and re-run: a row that is fully sealed with its index present is
 * skipped, and each batch is one transaction, so a crash leaves whole rows
 * either done or untouched.
 */
import { sql, type Kysely } from 'kysely';

import { contentCrypto, indexKeyFor, isSealedText, JSON_CTX_SUFFIX, openText, sealText } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import {
  buildCodeGramsVector,
  buildGramsVector,
  buildWordsVector,
} from '../../utils/blind-index.js';

export interface EmailBackfillOptions {
  batch?: number;
  dryRun?: boolean;
  onProgress?: (r: EmailBackfillResult) => void;
}

export interface EmailBackfillResult {
  messagesScanned: number;
  messagesSealed: number;
  threadsScanned: number;
  threadsSealed: number;
  skipped: number;
  failed: number;
}

const MESSAGE_TEXT = ['subject', 'snippet', 'from_name', 'body_text', 'body_html', 'body_excerpt', 'ics_text'] as const;
const THREAD_TEXT = ['subject', 'snippet', 'from_name'] as const;
const THREAD_JSON = ['delivery_json', 'flight_json', 'receipt_json', 'read_advisory_json', 'scheduling_json'] as const;

const tsvector = (literal: string) => sql<string>`${literal}::tsvector`;

async function plain(
  db: Kysely<DB>,
  userId: string,
  table: string,
  column: string,
  value: string | null,
): Promise<string | null> {
  if (value === null || value === '') return value;
  if (!isSealedText(value)) return value;
  const { store, keys } = contentCrypto();
  void db;
  void userId;
  void table;
  void column;
  return openText(store, keys, value);
}

async function seal(userId: string, table: string, column: string, value: string | null): Promise<string | null> {
  if (value === null || value === '' || isSealedText(value)) return value;
  const { store, keys } = contentCrypto();
  return sealText(store, keys, userId, `${table}:${column}`, value);
}

/** A jsonb value as it is stored, to what a sealed column holds. */
async function sealJson(userId: string, table: string, column: string, stored: unknown): Promise<string | null> {
  if (stored === null || stored === undefined) return null;
  if (typeof stored === 'string' && isSealedText(stored)) return JSON.stringify(stored);
  const text = JSON.stringify(stored);
  if (text === '[]' || text === '{}' || text === 'null') return text;
  const { store, keys } = contentCrypto();
  return JSON.stringify(await sealText(store, keys, userId, `${table}:${column}${JSON_CTX_SUFFIX}`, text));
}

async function openJsonText(stored: unknown): Promise<string | null> {
  if (stored === null || stored === undefined) return null;
  if (typeof stored === 'string' && isSealedText(stored)) {
    const { store, keys } = contentCrypto();
    return openText(store, keys, stored);
  }
  return JSON.stringify(stored);
}

export async function sealExistingMail(
  db: Kysely<DB>,
  opts: EmailBackfillOptions = {},
): Promise<EmailBackfillResult> {
  const { raw } = contentCrypto();
  const batch = opts.batch ?? 100;
  const r: EmailBackfillResult = {
    messagesScanned: 0,
    messagesSealed: 0,
    threadsScanned: 0,
    threadsSealed: 0,
    skipped: 0,
    failed: 0,
  };

  // ── messages ─────────────────────────────────────────────────────
  let cursor = '';
  for (;;) {
    const rows = await raw
      .selectFrom('email_messages')
      .selectAll()
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(batch)
      .execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
    for (const row of rows) {
      r.messagesScanned++;
      try {
        const set: Record<string, unknown> = {};
        let needsBlind = row.blind_words === null || row.blind_from === null;
        for (const col of MESSAGE_TEXT) {
          const v = row[col] as string | null;
          if (v !== null && v !== '' && !isSealedText(v)) {
            set[col] = await seal(row.user_id, 'email_messages', col, v);
            needsBlind = true;
          }
        }
        const stored = row.attachments_json as unknown;
        const sealedAtt = await sealJson(row.user_id, 'email_messages', 'attachments_json', stored);
        if (sealedAtt !== null && !(typeof stored === 'string' && isSealedText(stored))) {
          if (sealedAtt !== JSON.stringify(stored)) set.attachments_json = sealedAtt;
        }
        if (!needsBlind && Object.keys(set).length === 0) {
          r.skipped++;
          continue;
        }
        const key = await indexKeyFor(row.user_id);
        const body = (await plain(raw, row.user_id, 'email_messages', 'body_text', row.body_text)) ??
          (await plain(raw, row.user_id, 'email_messages', 'body_excerpt', row.body_excerpt));
        const name = await plain(raw, row.user_id, 'email_messages', 'from_name', row.from_name);
        set.blind_words = tsvector(buildWordsVector(key, body));
        set.blind_grams = tsvector(buildCodeGramsVector(key, body));
        set.blind_from = tsvector(buildGramsVector(key, `${name ?? ''} ${row.from_email ?? ''}`));
        updates.push({ id: row.id, set });
      } catch {
        r.failed++;
      }
    }
    if (!opts.dryRun && updates.length > 0) {
      await raw.transaction().execute(async (trx) => {
        for (const u of updates) await trx.updateTable('email_messages').set(u.set as never).where('id', '=', u.id).execute();
      });
    }
    r.messagesSealed += updates.length;
    opts.onProgress?.({ ...r });
  }

  // ── threads ──────────────────────────────────────────────────────
  cursor = '';
  for (;;) {
    const rows = await raw
      .selectFrom('email_threads')
      .selectAll()
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(batch)
      .execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
    for (const row of rows) {
      r.threadsScanned++;
      try {
        const set: Record<string, unknown> = {};
        let needsBlind = row.blind_words === null || row.blind_from === null;
        for (const col of THREAD_TEXT) {
          const v = row[col] as string | null;
          if (v !== null && v !== '' && !isSealedText(v)) {
            set[col] = await seal(row.user_id, 'email_threads', col, v);
            needsBlind = true;
          }
        }
        for (const col of THREAD_JSON) {
          const stored = row[col] as unknown;
          if (stored === null || stored === undefined) continue;
          if (typeof stored === 'string' && isSealedText(stored)) continue;
          const sealed = await sealJson(row.user_id, 'email_threads', col, stored);
          if (sealed !== null && sealed !== JSON.stringify(stored)) set[col] = sealed;
        }
        if (!needsBlind && Object.keys(set).length === 0) {
          r.skipped++;
          continue;
        }
        const key = await indexKeyFor(row.user_id);
        const subject = await plain(raw, row.user_id, 'email_threads', 'subject', row.subject);
        const snippet = await plain(raw, row.user_id, 'email_threads', 'snippet', row.snippet);
        const name = await plain(raw, row.user_id, 'email_threads', 'from_name', row.from_name);
        const joined = [subject, snippet, name, row.from_email].filter(Boolean).join(' ');
        set.blind_words = tsvector(buildWordsVector(key, subject, snippet, name, row.from_email));
        set.blind_grams = tsvector(buildGramsVector(key, joined));
        set.blind_from = tsvector(buildGramsVector(key, `${name ?? ''} ${row.from_email ?? ''}`));
        updates.push({ id: row.id, set });
      } catch {
        r.failed++;
      }
    }
    if (!opts.dryRun && updates.length > 0) {
      await raw.transaction().execute(async (trx) => {
        for (const u of updates) await trx.updateTable('email_threads').set(u.set as never).where('id', '=', u.id).execute();
      });
    }
    r.threadsSealed += updates.length;
    opts.onProgress?.({ ...r });
  }

  // ── kept receipts (ADR 0249) ─────────────────────────────────────
  // Copied from the thread as stored, so a copy made before the switch is
  // plaintext. No blind index: receipts are not searched.
  cursor = '';
  for (;;) {
    const rows = await raw
      .selectFrom('email_receipts')
      .select(['id', 'user_id', 'receipt_json', 'from_name'])
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(batch)
      .execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
    for (const row of rows) {
      try {
        const set: Record<string, unknown> = {};
        const stored = row.receipt_json as unknown;
        if (!(typeof stored === 'string' && isSealedText(stored))) {
          const sealed = await sealJson(row.user_id, 'email_receipts', 'receipt_json', stored);
          if (sealed !== null && sealed !== JSON.stringify(stored)) set.receipt_json = sealed;
        }
        if (row.from_name && !isSealedText(row.from_name)) {
          set.from_name = await seal(row.user_id, 'email_receipts', 'from_name', row.from_name);
        }
        if (Object.keys(set).length > 0) updates.push({ id: row.id, set });
      } catch {
        r.failed++;
      }
    }
    if (!opts.dryRun && updates.length > 0) {
      await raw.transaction().execute(async (trx) => {
        for (const u of updates) await trx.updateTable('email_receipts').set(u.set as never).where('id', '=', u.id).execute();
      });
    }
    r.threadsSealed += updates.length;
  }
  void openJsonText;
  return r;
}

export interface PlaintextCounts {
  messages: Record<string, number>;
  threads: Record<string, number>;
  total: number;
}

/** Rows that still hold readable content in a column that should be sealed. */
export async function countPlaintextMail(db: Kysely<DB>): Promise<PlaintextCounts> {
  const { raw } = contentCrypto();
  void db;
  const textCount = async (table: string, col: string): Promise<number> => {
    const res = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.table(table)}
      WHERE ${sql.ref(col)} IS NOT NULL AND ${sql.ref(col)} <> '' AND ${sql.ref(col)} NOT LIKE 'enc1.%'`.execute(raw);
    return Number(res.rows[0]!.n);
  };
  const jsonCount = async (table: string, col: string): Promise<number> => {
    const res = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.table(table)}
      WHERE ${sql.ref(col)} IS NOT NULL
        AND ${sql.ref(col)}::text NOT IN ('[]', '{}', 'null')
        AND NOT (jsonb_typeof(${sql.ref(col)}) = 'string' AND (${sql.ref(col)} #>> '{}') LIKE 'enc1.%')`.execute(raw);
    return Number(res.rows[0]!.n);
  };
  const messages: Record<string, number> = {};
  for (const c of MESSAGE_TEXT) messages[c] = await textCount('email_messages', c);
  messages.attachments_json = await jsonCount('email_messages', 'attachments_json');
  const threads: Record<string, number> = {};
  for (const c of THREAD_TEXT) threads[c] = await textCount('email_threads', c);
  for (const c of THREAD_JSON) threads[c] = await jsonCount('email_threads', c);
  threads['email_receipts.receipt_json'] = await jsonCount('email_receipts', 'receipt_json');
  threads['email_receipts.from_name'] = await textCount('email_receipts', 'from_name');
  const total =
    Object.values(messages).reduce((a, b) => a + b, 0) + Object.values(threads).reduce((a, b) => a + b, 0);
  return { messages, threads, total };
}
