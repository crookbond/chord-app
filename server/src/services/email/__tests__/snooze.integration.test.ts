/**
 * Snooze as a mailbox state (ADR 0129).
 *
 * The test that matters most is the one about NOT waking: `recomputeThread`
 * runs on every label change, not only on new mail, so waking must key on a
 * genuinely newer message or marking a snoozed thread read would wake it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { listThreads, recomputeThread, snoozeThread } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let threadId: string;
let gid: string;

const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function addMessage(when: string): Promise<void> {
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: 'hi',
      snippet: 'hi',
      from_email: 'someone@example.com',
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      gmail_label_ids: JSON.stringify(['INBOX']),
      is_unread: 0,
      ics_text: '',
      internal_date: when,
      created_at: when,
    })
    .execute();
}

async function subjects(folder: 'inbox' | 'snoozed'): Promise<string[]> {
  const rows = await listThreads(db, userId, { folder });
  return rows.map((r) => r.subject);
}

async function snoozedUntil(): Promise<string | null> {
  const row = await db
    .selectFrom('email_threads')
    .select('snoozed_until')
    .where('id', '=', threadId)
    .executeTakeFirst();
  return row?.snoozed_until ?? null;
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  gid = newId('gt');
  threadId = newId('et');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'hi',
      from_email: 'someone@example.com',
      gmail_label_ids: JSON.stringify(['INBOX']),
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await addMessage(now);
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('putting a thread aside', () => {
  it('takes it out of the inbox and into Snoozed', async () => {
    expect(await subjects('inbox')).toEqual(['hi']);

    await snoozeThread(db, userId, threadId, iso(4 * HOUR));

    expect(await subjects('inbox')).toEqual([]);
    expect(await subjects('snoozed')).toEqual(['hi']);
  });

  it('brings it back once the moment has passed', async () => {
    await snoozeThread(db, userId, threadId, iso(-HOUR));

    expect(await subjects('inbox')).toEqual(['hi']);
    // Past its moment, it is not "snoozed" any more either.
    expect(await subjects('snoozed')).toEqual([]);
  });

  it('wakes on request', async () => {
    await snoozeThread(db, userId, threadId, iso(4 * HOUR));

    await snoozeThread(db, userId, threadId, null);

    expect(await subjects('inbox')).toEqual(['hi']);
    expect(await snoozedUntil()).toBeNull();
  });

  it('refuses a thread that is not yours', async () => {
    const other = await createUser(db, 'bob');

    expect(await snoozeThread(db, other, threadId, iso(HOUR))).toBeNull();
  });
});

describe('what wakes it', () => {
  it('a new message wakes it early', async () => {
    await snoozeThread(db, userId, threadId, iso(24 * HOUR));
    await addMessage(iso(HOUR));

    await recomputeThread(db, userId, gid);

    expect(await snoozedUntil()).toBeNull();
    expect(await subjects('inbox')).toEqual(['hi']);
  });

  it('marking it read does NOT wake it', async () => {
    // recomputeThread runs for every label change. Keying the wake on that
    // would mean any touch un-snoozed the thread.
    await snoozeThread(db, userId, threadId, iso(24 * HOUR));

    await recomputeThread(db, userId, gid);

    expect(await snoozedUntil()).not.toBeNull();
    expect(await subjects('inbox')).toEqual([]);
  });

  it('a message OLDER than the snooze does not wake it', async () => {
    // Backfill can insert older mail into a thread; that is not new mail.
    await snoozeThread(db, userId, threadId, iso(24 * HOUR));
    await addMessage(iso(-48 * HOUR));

    await recomputeThread(db, userId, gid);

    expect(await snoozedUntil()).not.toBeNull();
  });
});
