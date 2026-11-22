/**
 * Group lifecycle (ADR 0045): delete, leave (incl. owner auto-transfer and
 * sole-member delete), and invite-code regeneration. Deletion has to clear
 * group-scoped attachments (polymorphic scope, no FK cascade) the same way
 * account deletion does — covered here so a regression surfaces.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttachmentsTable, DB } from '@/db/schema.js';
import {
  createGroup,
  deleteGroup,
  getMemberRole,
  isMember,
  joinGroupByCode,
  leaveGroup,
  regenerateInviteCode,
} from '@/services/groups.service.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function setJoinedAt(db: Kysely<DB>, groupId: string, userId: string, iso: string): Promise<void> {
  await db
    .updateTable('group_members')
    .set({ joined_at: iso })
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute();
}

async function insertAttachment(db: Kysely<DB>, id: string, groupId: string, uploadedBy: string): Promise<void> {
  const row: AttachmentsTable = {
    id,
    scope_kind: 'group',
    scope_id: groupId,
    uploaded_by: uploadedBy,
    filename: 'doc.txt',
    mime_type: 'text/plain',
    size: 40,
    path: `group/x/${id}/doc.txt`,
    summary: null,
    extracted_text: 'soccer practice is at 4pm on saturday',
    image_meta: null,
    pinned: 0,
    indexed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  } as AttachmentsTable;
  await db.insertInto('attachments').values(row).execute();
  await indexAttachmentChunks(db, id);
}

async function groupExists(db: Kysely<DB>, id: string): Promise<boolean> {
  const r = await db.selectFrom('groups').select('id').where('id', '=', id).executeTakeFirst();
  return !!r;
}

async function chunkCount(db: Kysely<DB>, attachmentId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM attachment_chunks WHERE attachment_id = ${attachmentId}
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

describe('group lifecycle', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('deleteGroup removes the group and clears its attachment chunks', async () => {
    const owner = await createUser(db, 'john');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner });
    await insertAttachment(db, 'a1', group.id, owner);
    expect(await chunkCount(db, 'a1')).toBeGreaterThan(0);

    const { attachmentsDeleted } = await deleteGroup(db, group.id);
    expect(attachmentsDeleted).toBe(1);
    expect(await groupExists(db, group.id)).toBe(false);
    expect(await chunkCount(db, 'a1')).toBe(0);
  });

  it('a non-owner leaving drops their membership and keeps the group + owner', async () => {
    const owner = await createUser(db, 'john');
    const member = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner });
    await addMember(db, group.id, member);

    const res = await leaveGroup(db, group.id, member);
    expect(res).toEqual({ deleted: false });
    expect(await isMember(db, group.id, member)).toBe(false);
    expect(await isMember(db, group.id, owner)).toBe(true);
    expect(await getMemberRole(db, group.id, owner)).toBe('owner');
  });

  it('the owner leaving auto-transfers ownership to the earliest-joined remaining member', async () => {
    const owner = await createUser(db, 'john');
    const early = await createUser(db, 'alice');
    const late = await createUser(db, 'ben');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner });
    await addMember(db, group.id, early);
    await addMember(db, group.id, late);
    // Make join order unambiguous: early < late < owner.
    await setJoinedAt(db, group.id, early, '2026-01-02T00:00:00.000Z');
    await setJoinedAt(db, group.id, late, '2026-01-03T00:00:00.000Z');
    await setJoinedAt(db, group.id, owner, '2026-01-04T00:00:00.000Z');

    const res = await leaveGroup(db, group.id, owner);
    expect(res).toEqual({ deleted: false, newOwnerId: early });
    expect(await isMember(db, group.id, owner)).toBe(false);
    expect(await getMemberRole(db, group.id, early)).toBe('owner');

    const g = await db
      .selectFrom('groups')
      .select('created_by')
      .where('id', '=', group.id)
      .executeTakeFirst();
    expect(g?.created_by).toBe(early);
  });

  it('the sole member leaving deletes the group', async () => {
    const owner = await createUser(db, 'john');
    const group = await createGroup(db, { name: 'Solo', kind: 'group', createdBy: owner });

    const res = await leaveGroup(db, group.id, owner);
    expect(res).toEqual({ deleted: true });
    expect(await groupExists(db, group.id)).toBe(false);
  });

  it('regenerateInviteCode rotates the code: the old one stops working, the new one joins', async () => {
    const owner = await createUser(db, 'john');
    const joiner = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner });
    const oldCode = group.invite_code;

    const newCode = await regenerateInviteCode(db, group.id);
    expect(newCode).not.toBe(oldCode);

    expect(await joinGroupByCode(db, joiner, oldCode)).toBeNull();
    const joined = await joinGroupByCode(db, joiner, newCode);
    expect(joined?.id).toBe(group.id);
    expect(await isMember(db, group.id, joiner)).toBe(true);
  });
});
