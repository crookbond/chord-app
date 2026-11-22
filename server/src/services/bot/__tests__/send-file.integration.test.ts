/**
 * Coverage for the send_file tool — the bot delivers an existing attachment
 * back into the chat as a downloadable `file` message instead of inventing a
 * URL/link (the failure mode that produced fabricated example.com links).
 *
 * - send_file posts a kind:'file' message carrying the real attachmentId.
 * - send_file refuses an attachment that lives in a sibling group.
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
  opts: { groupId: string; uploadedBy: string; filename: string },
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
      mime_type: 'application/pdf',
      size: 1234,
      path: `group/${opts.groupId}/${id}/${opts.filename}`,
      summary: null,
      extracted_text: null,
      image_meta: null,
      pinned: 0,
      indexed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

async function fileMessages(db: Kysely<DB>, groupId: string) {
  return db
    .selectFrom('messages')
    .select(['kind', 'attachment_id', 'sender_id'])
    .where('group_id', '=', groupId)
    .where('kind', '=', 'file')
    .execute();
}

describe('send_file tool', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('posts a file message carrying the real attachment id', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    const attId = await seedGroupAttachment(db, {
      groupId: group.id,
      uploadedBy: john,
      filename: 'LakesideCalendar.pdf',
    });

    const res = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'send_file', args: { attachmentId: attId } },
    });

    expect(res.summary).toContain('LakesideCalendar.pdf');
    const msgs = await fileMessages(db, group.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].attachment_id).toBe(attId);
    expect(msgs[0].sender_id).toBeNull(); // bot-authored
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
      call: { name: 'send_file', args: { attachmentId: attId } },
    });

    expect(res.summary).toContain('not visible here');
    expect(await fileMessages(db, here.id)).toHaveLength(0);
  });
});
