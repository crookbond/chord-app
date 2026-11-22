/**
 * Files going out on a message (ADR 0111). The load-bearing test here is the
 * authorization one: `getAttachment` looks up by id with no scope check, so
 * resolving a request-supplied id without one would let any user mail
 * themselves any file in the system.
 */
import path from 'node:path';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { saveFile } from '@/services/attachments.service.js';
import {
  AttachmentRejected,
  loadOutgoingAttachments,
} from '@/services/email/outgoing-attachments.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function upload(
  userId: string,
  groupId: string,
  filename: string,
  contents: string,
): Promise<string> {
  const att = await saveFile(db, {
    scope: { kind: 'group', groupId },
    uploadedBy: userId,
    filename,
    mimeType: 'text/plain',
    buffer: Buffer.from(contents),
  });
  return att.id;
}

describe('loading files for an outgoing message', () => {
  it('reads a file the sender can see', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    const id = await upload(uid, group.id, 'itinerary.txt', 'UA512 departs 6:40am');

    const out = await loadOutgoingAttachments(db, uid, [id], 'gmail');

    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe('itinerary.txt');
    expect(out[0].content.toString()).toContain('UA512');
  });

  it('refuses a file belonging to a group the sender is not in', async () => {
    // The whole reason this helper exists. Without the membership check an id
    // in a request body is a read of any file in the database.
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const hers = await createGroup(db, { name: 'Hers', kind: 'group', createdBy: alice });
    const id = await upload(alice, hers.id, 'private.txt', 'not for bob');

    await expect(loadOutgoingAttachments(db, bob, [id], 'gmail')).rejects.toBeInstanceOf(
      AttachmentRejected,
    );
  });

  it('says the same thing for a file that does not exist', async () => {
    // Distinguishing "forbidden" from "absent" tells a caller which ids are
    // real, which is the whole of an id-guessing attack.
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const hers = await createGroup(db, { name: 'Hers', kind: 'group', createdBy: alice });
    const id = await upload(alice, hers.id, 'private.txt', 'not for bob');

    const forbidden = await loadOutgoingAttachments(db, bob, [id], 'gmail').catch(
      (e: Error) => e.message,
    );
    const absent = await loadOutgoingAttachments(db, bob, ['att_nope'], 'gmail').catch(
      (e: Error) => e.message,
    );

    expect(forbidden).toBe(absent);
  });

  it('returns nothing when no ids were given', async () => {
    const uid = await createUser(db, 'alice');

    expect(await loadOutgoingAttachments(db, uid, undefined, 'gmail')).toEqual([]);
    expect(await loadOutgoingAttachments(db, uid, [], 'gmail')).toEqual([]);
  });

  it('refuses rather than truncates when the mailbox is too small', async () => {
    // Outlook takes ~3MB inline; Gmail takes tens. The same file is fine on one
    // and refused on the other, and saying so beats pretending every mailbox is
    // the smallest one.
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    const big = 'x'.repeat(4 * 1024 * 1024);
    const id = await upload(uid, group.id, 'scan.txt', big);

    await expect(loadOutgoingAttachments(db, uid, [id], 'gmail')).resolves.toHaveLength(1);
    await expect(loadOutgoingAttachments(db, uid, [id], 'outlook')).rejects.toThrow(/Outlook/);
  });

  it('refuses when the row outlived its file on disk', async () => {
    // Sending a zero-byte attachment because the blob went missing is the ADR
    // 0107 failure in miniature: a thing we did not do, reported as done.
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    const id = await upload(uid, group.id, 'gone.txt', 'here for now');
    const row = await db
      .selectFrom('attachments')
      .select('path')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const { rm } = await import('node:fs/promises');
    await rm(path.join(env.DATA_DIR, row.path));

    await expect(loadOutgoingAttachments(db, uid, [id], 'gmail')).rejects.toBeInstanceOf(
      AttachmentRejected,
    );
  });
});
