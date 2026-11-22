/**
 * Boot-time extraction recovery (roadmap "Known gaps → Bot"). An upload
 * interrupted by a crash/restart leaves an attachment row with
 * `indexed_at IS NULL`; `requeuePendingExtractions` retries those — but only
 * the ones that actually requested indexing (`index_requested = 1`) and are
 * old enough to not be racing an in-flight upload. Files deliberately stored
 * without indexing (`saveFile({ index: false })`) carry `index_requested = 0`
 * and must be left alone.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttachmentsTable, DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { createGroup } from '@/services/groups.service.js';
import { requeuePendingExtractions } from '@/services/attachments.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

async function writeFileAt(rel: string, body: string): Promise<void> {
  const abs = path.join(env.DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

async function insertPending(
  db: Kysely<DB>,
  over: Partial<AttachmentsTable> &
    Pick<AttachmentsTable, 'id' | 'scope_id' | 'uploaded_by' | 'path'>,
): Promise<void> {
  const row: AttachmentsTable = {
    scope_kind: 'group',
    filename: 'note.txt',
    mime_type: 'text/plain',
    size: 64,
    summary: null,
    extracted_text: null,
    image_meta: null,
    pinned: 0,
    indexed_at: null,
    index_requested: 1,
    created_at: HOUR_AGO,
    ...over,
  } as AttachmentsTable;
  await db.insertInto('attachments').values(row).execute();
}

async function indexedAt(db: Kysely<DB>, id: string): Promise<string | null> {
  const r = await db
    .selectFrom('attachments')
    .select('indexed_at')
    .where('id', '=', id)
    .executeTakeFirst();
  return r?.indexed_at ?? null;
}

async function waitForIndexed(db: Kysely<DB>, id: string, timeoutMs = 5_000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const at = await indexedAt(db, id);
    if (at) return at;
    await new Promise((res) => setTimeout(res, 25));
  }
  return null;
}

async function chunkCount(db: Kysely<DB>, id: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM attachment_chunks WHERE attachment_id = ${id}
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

describe('requeuePendingExtractions — interrupted-upload recovery', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('re-extracts an interrupted upload and rebuilds its chunk index', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    const rel = path.join('test-attachments', `rec-${Date.now()}`, 'note.txt');
    await writeFileAt(rel, 'soccer practice is at 4pm on saturday');

    await insertPending(db, { id: 'a_pending', scope_id: group.id, uploaded_by: john, path: rel });

    const requeued = await requeuePendingExtractions(db, 0);
    expect(requeued).toBe(1);

    const at = await waitForIndexed(db, 'a_pending');
    expect(at).toBeTruthy();
    expect(await chunkCount(db, 'a_pending')).toBeGreaterThan(0);
  });

  it('skips deliberately-unindexed files and rows still within the age guard', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });

    // Deliberately skipped (index: false → index_requested = 0).
    await insertPending(db, {
      id: 'a_skipped',
      scope_id: group.id,
      uploaded_by: john,
      path: 'group/x/a_skipped/media.jpg',
      index_requested: 0,
    });
    // Requested but too recent — could be an upload still in flight.
    await insertPending(db, {
      id: 'a_fresh',
      scope_id: group.id,
      uploaded_by: john,
      path: 'group/x/a_fresh/note.txt',
      created_at: new Date().toISOString(),
    });

    // Default 60s age guard: neither row qualifies.
    const requeued = await requeuePendingExtractions(db);
    expect(requeued).toBe(0);
    expect(await indexedAt(db, 'a_skipped')).toBeNull();
    expect(await indexedAt(db, 'a_fresh')).toBeNull();
  });
});
