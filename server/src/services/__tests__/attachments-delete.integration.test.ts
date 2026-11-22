/**
 * Coverage for the file-management surface behind the Catchup "Files"
 * tab: the cross-group `listAttachmentsForUser` aggregation and
 * `deleteAttachment`. The delete path has to (a) drop the FTS chunks so
 * retrieval forgets the file, (b) remove the row, and (c) unlink the
 * on-disk file ONLY when no sibling row still points at the same path —
 * sharing (`copyAttachmentToGroup`) deliberately reuses the path, so an
 * unconditional unlink would break the shared copy.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import type { AttachmentsTable } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { createGroup } from '@/services/groups.service.js';
import {
  deleteAttachment,
  listAttachmentsForUser,
} from '@/services/attachments.service.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function insertAttachment(
  db: Kysely<DB>,
  over: Partial<AttachmentsTable> & Pick<AttachmentsTable, 'id' | 'scope_id' | 'uploaded_by' | 'path'>,
): Promise<void> {
  const row: AttachmentsTable = {
    scope_kind: 'group',
    filename: 'doc.pdf',
    mime_type: 'application/pdf',
    size: 1234,
    summary: null,
    extracted_text: 'soccer practice is at 4pm on saturday',
    image_meta: null,
    pinned: 0,
    indexed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...over,
  } as AttachmentsTable;
  await db.insertInto('attachments').values(row).execute();
  await indexAttachmentChunks(db, row.id);
}

async function chunkCount(db: Kysely<DB>, attachmentId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM attachment_chunk_meta WHERE attachment_id = ${attachmentId}
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

describe('attachments — Files tab delete + cross-group listing', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('listAttachmentsForUser returns group files for every member, newest first', async () => {
    const john = await createUser(db, 'john', 'John');
    const alice = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    await addMember(db, group.id, alice);

    await insertAttachment(db, {
      id: 'a_old',
      scope_id: group.id,
      uploaded_by: john,
      path: 'group/x/a_old/old.pdf',
      filename: 'old.pdf',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await insertAttachment(db, {
      id: 'a_new',
      scope_id: group.id,
      uploaded_by: john,
      path: 'group/x/a_new/new.pdf',
      filename: 'new.pdf',
      created_at: '2026-05-01T00:00:00.000Z',
    });

    // Both members see both files; ordered newest-first.
    const view = await listAttachmentsForUser(db, alice);
    expect(view.map((a) => a.filename)).toEqual(['new.pdf', 'old.pdf']);
  });

  it('listAttachmentsForUser excludes files from groups the user is not in', async () => {
    const john = await createUser(db, 'john');
    const stranger = await createUser(db, 'stranger');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    await insertAttachment(db, {
      id: 'a1',
      scope_id: group.id,
      uploaded_by: john,
      path: 'group/x/a1/doc.pdf',
    });

    expect(await listAttachmentsForUser(db, stranger)).toEqual([]);
  });

  it('deleteAttachment drops FTS chunks and the row', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await insertAttachment(db, {
      id: 'a1',
      scope_id: group.id,
      uploaded_by: john,
      path: 'group/x/a1/doc.pdf',
    });
    expect(await chunkCount(db, 'a1')).toBeGreaterThan(0);

    const ok = await deleteAttachment(db, 'a1');
    expect(ok).toBe(true);
    expect(await chunkCount(db, 'a1')).toBe(0);
    expect(await listAttachmentsForUser(db, john)).toEqual([]);
  });

  it('returns false for an unknown id', async () => {
    expect(await deleteAttachment(db, 'nope')).toBe(false);
  });

  it('unlinks the disk file when no other row shares its path', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    const rel = path.join('test-attachments', `solo-${Date.now()}`, 'doc.pdf');
    const abs = path.join(env.DATA_DIR, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'hello');

    await insertAttachment(db, { id: 'a1', scope_id: group.id, uploaded_by: john, path: rel });
    await deleteAttachment(db, 'a1');

    await expect(fs.access(abs)).rejects.toBeTruthy();
  });

  it('preserves the disk file when a shared copy still references the same path', async () => {
    const john = await createUser(db, 'john');
    const groupA = await createGroup(db, { name: 'A', kind: 'group', createdBy: john });
    const groupB = await createGroup(db, { name: 'B', kind: 'group', createdBy: john });
    const rel = path.join('test-attachments', `shared-${Date.now()}`, 'doc.pdf');
    const abs = path.join(env.DATA_DIR, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'hello');

    // Original in A, shared copy in B — both point at the same file.
    await insertAttachment(db, { id: 'orig', scope_id: groupA.id, uploaded_by: john, path: rel });
    await insertAttachment(db, { id: 'copy', scope_id: groupB.id, uploaded_by: john, path: rel });

    await deleteAttachment(db, 'orig');

    // File survives because the shared copy still needs it.
    await expect(fs.access(abs)).resolves.toBeUndefined();

    // Deleting the last referrer finally unlinks it.
    await deleteAttachment(db, 'copy');
    await expect(fs.access(abs)).rejects.toBeTruthy();
  });
});
