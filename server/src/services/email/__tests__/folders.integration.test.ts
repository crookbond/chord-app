/**
 * Folders (ADR 0108). Sent and archived threads were in the mirror all along;
 * the only thing standing between the user and their own sent mail was the
 * unconditional `is_archived = 0` every listing carried.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seed(
  userId: string,
  subject: string,
  labels: string[],
): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: id,
      subject,
      // The mirror derives this from the labels; seeding both keeps the
      // fixture honest about what a real row looks like.
      is_archived: labels.includes('INBOX') ? 0 : 1,
      gmail_label_ids: JSON.stringify(labels),
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function subjectsIn(userId: string, folder?: 'inbox' | 'sent' | 'archive') {
  const rows = await listThreads(db, userId, folder ? { folder } : {});
  return rows.map((r) => r.subject).sort();
}

async function seedAll(userId: string): Promise<void> {
  await seed(userId, 'live', ['INBOX']);
  await seed(userId, 'sent', ['SENT']);
  await seed(userId, 'filed', []);
  await seed(userId, 'deleted', ['TRASH']);
}

describe('folders', () => {
  it('defaults to the inbox, so every existing caller is unchanged', async () => {
    const uid = await createUser(db, 'alice');
    await seedAll(uid);

    expect(await subjectsIn(uid)).toEqual(['live']);
  });

  it('sent holds what you sent, and nothing else', async () => {
    const uid = await createUser(db, 'alice');
    await seedAll(uid);

    expect(await subjectsIn(uid, 'sent')).toEqual(['sent']);
  });

  it('archive is mail that left the inbox without being filed elsewhere', async () => {
    // Excluding SENT is the load-bearing half: a reply you sent is not a
    // thread you dealt with, and mixing the two makes archive useless.
    const uid = await createUser(db, 'alice');
    await seedAll(uid);

    expect(await subjectsIn(uid, 'archive')).toEqual(['filed']);
  });

  it('keeps deleted mail out of every folder', async () => {
    const uid = await createUser(db, 'alice');
    await seedAll(uid);

    const all = [
      ...(await subjectsIn(uid, 'inbox')),
      ...(await subjectsIn(uid, 'sent')),
      ...(await subjectsIn(uid, 'archive')),
    ];
    expect(all).not.toContain('deleted');
  });

  it('a thread trashed after it was sent stops appearing in Sent', async () => {
    const uid = await createUser(db, 'alice');
    await seed(uid, 'recalled', ['SENT', 'TRASH']);

    expect(await subjectsIn(uid, 'sent')).toEqual([]);
  });

  it('scopes folders to their owner', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    await seed(alice, 'hers', ['SENT']);
    await seed(bob, 'his', ['SENT']);

    expect(await subjectsIn(alice, 'sent')).toEqual(['hers']);
    expect(await subjectsIn(bob, 'sent')).toEqual(['his']);
  });
});
