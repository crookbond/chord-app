/**
 * Seal what the product derived from mail and files (ADR 0201, phase 4): the
 * text read out of attachments and its search chunks, suggestions mined from
 * mail, drafts, and the summaries attached to meetings.
 *
 * Same contract as the mail backfill: reads raw, seals plaintext, opens sealed
 * values only to build an index, skips what is already done, and commits each
 * batch as one transaction so a crash leaves whole rows done or untouched.
 */
import { sql, type Kysely } from 'kysely';

import { contentCrypto, indexKeyFor, isSealedText, openText, sealText } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { buildWordsVector } from '../../utils/blind-index.js';

export interface DerivedBackfillOptions {
  batch?: number;
  dryRun?: boolean;
  onProgress?: (r: DerivedBackfillResult) => void;
}

export interface DerivedBackfillResult {
  attachments: number;
  chunks: number;
  proposals: number;
  drafts: number;
  meetings: number;
  skipped: number;
  failed: number;
}

const ATTACHMENT_TEXT = ['summary', 'extracted_text', 'image_meta', 'answerable_questions'] as const;

async function sealValue(owner: string, ctx: string, value: string | null): Promise<string | null> {
  if (value === null || value === '' || isSealedText(value)) return value;
  const { store, keys } = contentCrypto();
  return sealText(store, keys, owner, ctx, value);
}

async function openValue(value: string | null): Promise<string | null> {
  if (value === null || value === '' || !isSealedText(value)) return value;
  const { store, keys } = contentCrypto();
  return openText(store, keys, value);
}

export async function sealExistingDerived(
  db: Kysely<DB>,
  opts: DerivedBackfillOptions = {},
): Promise<DerivedBackfillResult> {
  const { raw } = contentCrypto();
  const batch = opts.batch ?? 100;
  const r: DerivedBackfillResult = { attachments: 0, chunks: 0, proposals: 0, drafts: 0, meetings: 0, skipped: 0, failed: 0 };
  const commit = async (fn: (trx: Kysely<DB>) => Promise<void>): Promise<void> => {
    if (opts.dryRun) return;
    await raw.transaction().execute(fn);
  };

  // ── attachments ───────────────────────────────────────────────────
  let cursor = '';
  for (;;) {
    const rows = await raw.selectFrom('attachments').selectAll().where('id', '>', cursor).orderBy('id', 'asc').limit(batch).execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const updates: Array<{ id: string; set: Record<string, string | null> }> = [];
    for (const row of rows) {
      try {
        const set: Record<string, string | null> = {};
        for (const col of ATTACHMENT_TEXT) {
          const v = row[col] as string | null;
          if (v !== null && v !== '' && !isSealedText(v)) set[col] = await sealValue(row.scope_id, `attachments:${col}`, v);
        }
        if (Object.keys(set).length === 0) {
          r.skipped++;
          continue;
        }
        updates.push({ id: row.id, set });
      } catch {
        r.failed++;
      }
    }
    await commit(async (trx) => {
      for (const u of updates) await trx.updateTable('attachments').set(u.set as never).where('id', '=', u.id).execute();
    });
    r.attachments += updates.length;
    opts.onProgress?.({ ...r });
  }

  // ── chunks ────────────────────────────────────────────────────────
  let afterA = '';
  let afterI = -1;
  for (;;) {
    const rows = await sql<{
      attachment_id: string;
      chunk_idx: number;
      content: string;
      filename: string;
      scope_id: string;
      indexed: boolean;
    }>`
      SELECT c.attachment_id, c.chunk_idx, c.content, c.filename, a.scope_id, (c.blind_words IS NOT NULL) AS indexed
      FROM attachment_chunks c JOIN attachments a ON a.id = c.attachment_id
      WHERE (c.attachment_id, c.chunk_idx) > (${afterA}, ${afterI})
      ORDER BY c.attachment_id, c.chunk_idx
      LIMIT ${batch}`.execute(raw);
    if (rows.rows.length === 0) break;
    const last = rows.rows[rows.rows.length - 1]!;
    afterA = last.attachment_id;
    afterI = last.chunk_idx;
    const updates: Array<{ a: string; i: number; content: string; blind: string }> = [];
    for (const c of rows.rows) {
      try {
        if (isSealedText(c.content) && c.indexed) {
          r.skipped++;
          continue;
        }
        const plain = (await openValue(c.content)) ?? '';
        const key = await indexKeyFor(c.scope_id);
        updates.push({
          a: c.attachment_id,
          i: c.chunk_idx,
          content: (await sealValue(c.scope_id, 'attachment_chunks:content', plain)) ?? '',
          blind: buildWordsVector(key, plain, c.filename),
        });
      } catch {
        r.failed++;
      }
    }
    await commit(async (trx) => {
      for (const u of updates) {
        await sql`UPDATE attachment_chunks SET content = ${u.content}, blind_words = ${u.blind}::tsvector
                  WHERE attachment_id = ${u.a} AND chunk_idx = ${u.i}`.execute(trx);
      }
    });
    r.chunks += updates.length;
    opts.onProgress?.({ ...r });
  }

  // ── proposals mined from mail ─────────────────────────────────────
  cursor = '';
  for (;;) {
    const rows = await raw
      .selectFrom('proposals')
      .select(['id', 'args_json', 'proposed_by_user_id'])
      .where('id', '>', cursor)
      .where('provenance', 'like', 'gmail:%')
      .where('proposed_by_user_id', 'is not', null)
      .orderBy('id', 'asc')
      .limit(batch)
      .execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const updates: Array<{ id: string; args: string }> = [];
    for (const row of rows) {
      if (isSealedText(row.args_json)) {
        r.skipped++;
        continue;
      }
      try {
        updates.push({ id: row.id, args: (await sealValue(row.proposed_by_user_id!, 'proposals:args_json', row.args_json))! });
      } catch {
        r.failed++;
      }
    }
    await commit(async (trx) => {
      for (const u of updates) await trx.updateTable('proposals').set({ args_json: u.args }).where('id', '=', u.id).execute();
    });
    r.proposals += updates.length;
  }

  // ── drafts ────────────────────────────────────────────────────────
  cursor = '';
  for (;;) {
    const rows = await raw.selectFrom('email_drafts').select(['id', 'user_id', 'subject', 'body', 'body_html']).where('id', '>', cursor).orderBy('id', 'asc').limit(batch).execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const updates: Array<{ id: string; subject: string; body: string; body_html: string | null }> = [];
    for (const row of rows) {
      if (
        (row.subject === '' || isSealedText(row.subject)) &&
        (row.body === '' || isSealedText(row.body)) &&
        (!row.body_html || isSealedText(row.body_html))
      ) {
        r.skipped++;
        continue;
      }
      try {
        updates.push({
          id: row.id,
          subject: (await sealValue(row.user_id, 'email_drafts:subject', row.subject)) ?? '',
          body: (await sealValue(row.user_id, 'email_drafts:body', row.body)) ?? '',
          body_html: row.body_html ? ((await sealValue(row.user_id, 'email_drafts:body_html', row.body_html)) ?? null) : null,
        });
      } catch {
        r.failed++;
      }
    }
    await commit(async (trx) => {
      for (const u of updates) await trx.updateTable('email_drafts').set({ subject: u.subject, body: u.body, body_html: u.body_html }).where('id', '=', u.id).execute();
    });
    r.drafts += updates.length;
  }

  // ── meeting summaries ─────────────────────────────────────────────
  cursor = '';
  for (;;) {
    const rows = await raw
      .selectFrom('events')
      .select(['id', 'meeting_context', 'owner_user_id', 'created_by'])
      .where('id', '>', cursor)
      .where('meeting_context', 'is not', null)
      .orderBy('id', 'asc')
      .limit(batch)
      .execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const updates: Array<{ id: string; value: string }> = [];
    for (const row of rows) {
      const owner = row.owner_user_id ?? row.created_by;
      if (!row.meeting_context || isSealedText(row.meeting_context) || !owner) {
        r.skipped++;
        continue;
      }
      try {
        updates.push({ id: row.id, value: (await sealValue(owner, 'events:meeting_context', row.meeting_context))! });
      } catch {
        r.failed++;
      }
    }
    await commit(async (trx) => {
      for (const u of updates) await trx.updateTable('events').set({ meeting_context: u.value }).where('id', '=', u.id).execute();
    });
    r.meetings += updates.length;
  }

  opts.onProgress?.({ ...r });
  return r;
}

export interface DerivedPlaintextCounts {
  counts: Record<string, number>;
  total: number;
}

/** Rows that still hold readable derived content. */
export async function countPlaintextDerived(db: Kysely<DB>): Promise<DerivedPlaintextCounts> {
  const { raw } = contentCrypto();
  void db;
  const one = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(((await query.execute(raw)).rows[0] as { n: string }).n);
  const counts: Record<string, number> = {};
  for (const col of ATTACHMENT_TEXT) {
    counts[`attachments.${col}`] = await one(
      sql`SELECT count(*)::text AS n FROM attachments WHERE ${sql.ref(col)} IS NOT NULL AND ${sql.ref(col)} <> '' AND ${sql.ref(col)} NOT LIKE 'enc1.%'`,
    );
  }
  counts['attachment_chunks.content'] = await one(
    sql`SELECT count(*)::text AS n FROM attachment_chunks WHERE content <> '' AND content NOT LIKE 'enc1.%'`,
  );
  counts['attachment_chunks.unindexed'] = await one(
    sql`SELECT count(*)::text AS n FROM attachment_chunks WHERE blind_words IS NULL`,
  );
  counts['proposals.args_json (mail)'] = await one(
    sql`SELECT count(*)::text AS n FROM proposals WHERE provenance LIKE 'gmail:%' AND proposed_by_user_id IS NOT NULL AND args_json NOT LIKE 'enc1.%'`,
  );
  counts['email_drafts'] = await one(
    sql`SELECT count(*)::text AS n FROM email_drafts WHERE (subject <> '' AND subject NOT LIKE 'enc1.%') OR (body <> '' AND body NOT LIKE 'enc1.%') OR (body_html <> '' AND body_html NOT LIKE 'enc1.%')`,
  );
  counts['events.meeting_context'] = await one(
    sql`SELECT count(*)::text AS n FROM events WHERE meeting_context IS NOT NULL AND meeting_context <> '' AND meeting_context NOT LIKE 'enc1.%'`,
  );
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
