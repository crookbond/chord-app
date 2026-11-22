/**
 * Coverage for the reference_file tool (insurance-cards-file-link-bug).
 *
 * Prod bug: "Do you have my insurance cards?" got a confident yes naming the
 * files, with no way to tap through to them — the attachmentBlock context
 * path answers content questions directly and never attaches a card the way
 * search/send_file do. reference_file lets the model attach a tappable card
 * to ITS OWN reply, without re-posting the file as a new message.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function seedGroupAttachment(
  db: Kysely<DB>,
  opts: { groupId: string; uploadedBy: string; filename: string; blobMissing?: boolean },
): Promise<string> {
  const id = newId('a');
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: opts.groupId,
      uploaded_by: opts.uploadedBy,
      filename: opts.filename,
      mime_type: 'image/jpeg',
      size: 1234,
      path: `group/${opts.groupId}/${id}/${opts.filename}`,
      summary: null,
      extracted_text: null,
      image_meta: null,
      pinned: 0,
      indexed_at: new Date().toISOString(),
      blob_missing_at: opts.blobMissing ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

describe('reference_file tool', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('attaches a tappable card without posting a new message', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    const attId = await seedGroupAttachment(db, {
      groupId: group.id,
      uploadedBy: john,
      filename: 'insurance card front.jpeg',
    });

    const before = await db.selectFrom('messages').select('id').where('group_id', '=', group.id).execute();
    expect(before).toHaveLength(0);

    const res = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'reference_file', args: { attachmentId: attId } },
    });

    expect(res.data).toEqual({ ok: true, attachmentId: attId });
    expect(res.card).toEqual({
      kind: 'action',
      title: 'insurance card front.jpeg',
      attachmentId: attId,
      mimeType: 'image/jpeg',
    });
    // No file message posted — this is a reference on THIS reply, not send_file.
    expect(await db.selectFrom('messages').select('id').where('group_id', '=', group.id).execute()).toHaveLength(0);
  });

  it('refuses a blob-missing attachment and attaches no card', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    const attId = await seedGroupAttachment(db, {
      groupId: group.id,
      uploadedBy: john,
      filename: 'insurance card back.jpeg',
      blobMissing: true,
    });

    const res = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'reference_file', args: { attachmentId: attId } },
    });

    expect(res.data).toEqual({ ok: false, reason: 'blob_missing' });
    expect(res.card).toBeUndefined();
    expect(res.summary).toContain('no longer stored on the server');
  });

  it('refuses an attachment that lives in a sibling group', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const here = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    const other = await createGroup(db, { name: 'Work', kind: 'group', createdBy: john });
    const attId = await seedGroupAttachment(db, {
      groupId: other.id,
      uploadedBy: john,
      filename: 'secret.pdf',
    });

    const res = await applyToolCall(db, {
      groupId: here.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'reference_file', args: { attachmentId: attId } },
    });

    expect(res.data).toEqual({ ok: false, reason: 'not_visible' });
    expect(res.card).toBeUndefined();
  });

  it('reports not_found for an unknown id', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });

    const res = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'reference_file', args: { attachmentId: 'a_nonexistent' } },
    });

    expect(res.data).toEqual({ ok: false, reason: 'not_found' });
    expect(res.card).toBeUndefined();
  });
});
