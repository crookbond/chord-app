/**
 * New-mail push (ADR 0117). The behaviour worth pinning is exactly-once: the
 * high-water mark is what stops the same thread being announced on every sync
 * tick, and what stops connecting a mailbox firing a push per backfilled
 * message.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { notifyNewMail } from '@/services/email/new-mail-notify.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  await registerDevice(userId);
});

/** A device to notify. Without one the pass has nobody to tell and reports 0,
 *  which is correct behaviour and useless for testing the decision. */
async function registerDevice(id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('push_tokens')
    .values({
      token: `ExponentPushToken[${id}]`,
      user_id: id,
      platform: 'ios',
      created_at: now,
      last_seen_at: now,
    })
    .execute();
}
afterEach(async () => {
  await closeTestDb(db);
});

async function arrive(
  subject: string,
  opts: { unread?: boolean; archived?: boolean; bulk?: boolean; at?: string } = {},
): Promise<void> {
  const id = newId('emt');
  const at = opts.at ?? new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: id,
      subject,
      from_name: 'Ms Chen',
      from_email: 'chen@school.example',
      is_unread: opts.unread === false ? 0 : 1,
      is_archived: opts.archived ? 1 : 0,
      bulk: opts.bulk ? 1 : 0,
      last_message_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

/** Pretend a previous pass already ran, so we are past the adopt-and-stay-quiet
 *  case that a fresh mailbox hits. */
async function seenUpTo(iso: string): Promise<void> {
  await db.updateTable('users').set({ email_notified_at: iso }).where('id', '=', userId).execute();
}

const markOf = async () =>
  (
    await db
      .selectFrom('users')
      .select('email_notified_at')
      .where('id', '=', userId)
      .executeTakeFirst()
  )?.email_notified_at ?? null;

describe('new-mail notification', () => {
  it('says nothing on the first pass, and adopts the mark', async () => {
    // Connecting a mailbox must not fire a push per message in the backfill
    // window; that is how people learn to turn notifications off.
    await arrive('Permission slip');

    expect(await notifyNewMail(db, userId)).toBe(0);
    expect(await markOf()).toBeTruthy();
  });

  it('counts mail that arrived after the mark', async () => {
    await seenUpTo('2026-08-01T00:00:00.000Z');
    await arrive('Permission slip', { at: '2026-08-20T10:00:00.000Z' });

    expect(await notifyNewMail(db, userId)).toBe(1);
  });

  it('does not announce the same thread twice', async () => {
    await seenUpTo('2026-08-01T00:00:00.000Z');
    await arrive('Permission slip', { at: '2026-08-20T10:00:00.000Z' });

    expect(await notifyNewMail(db, userId)).toBe(1);
    expect(await notifyNewMail(db, userId)).toBe(0);
  });

  it('skips read, archived and bulk mail', async () => {
    // A push per newsletter is indistinguishable from spam to the person
    // holding the phone - which is what ADR 0109 gave us `bulk` for.
    await seenUpTo('2026-08-01T00:00:00.000Z');
    const at = '2026-08-20T10:00:00.000Z';
    await arrive('Already read', { unread: false, at });
    await arrive('Filed away', { archived: true, at });
    await arrive('Newsletter', { bulk: true, at });

    expect(await notifyNewMail(db, userId)).toBe(0);
  });

  it('moves the mark even when nobody is listening', async () => {
    // A user with pushes off must not accumulate a backlog that fires the
    // moment they turn them on.
    await seenUpTo('2026-08-01T00:00:00.000Z');
    await arrive('Permission slip', { at: '2026-08-20T10:00:00.000Z' });

    await notifyNewMail(db, userId);

    expect(await markOf()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('counts several arrivals as one notification', async () => {
    // One push per sync tick, not one per message: a sync that pulls twenty
    // must not buzz twenty times.
    await seenUpTo('2026-08-01T00:00:00.000Z');
    await arrive('One', { at: '2026-08-20T10:00:00.000Z' });
    await arrive('Two', { at: '2026-08-20T11:00:00.000Z' });
    await arrive('Three', { at: '2026-08-20T12:00:00.000Z' });

    expect(await notifyNewMail(db, userId)).toBe(3);
    expect(await markOf()).toBe('2026-08-20T12:00:00.000Z');
  });

  it('reports nothing when there is no device to tell', async () => {
    // The count is notifications, not arrivals - and the mark still moves, so
    // turning a phone on later does not fire a backlog.
    const quiet = await createUser(db, 'quiet');
    await db
      .updateTable('users')
      .set({ email_notified_at: '2026-08-01T00:00:00.000Z' })
      .where('id', '=', quiet)
      .execute();
    const id = newId('emt');
    const at = '2026-08-20T10:00:00.000Z';
    await db
      .insertInto('email_threads')
      .values({
        id,
        user_id: quiet,
        gmail_thread_id: id,
        subject: 'Permission slip',
        is_unread: 1,
        last_message_at: at,
        created_at: at,
        updated_at: at,
      })
      .execute();

    expect(await notifyNewMail(db, quiet)).toBe(0);
    const row = await db
      .selectFrom('users')
      .select('email_notified_at')
      .where('id', '=', quiet)
      .executeTakeFirst();
    expect(row?.email_notified_at).toBe(at);
  });

  it('is scoped to its owner', async () => {
    const bob = await createUser(db, 'bob');
    await registerDevice(bob);
    await seenUpTo('2026-08-01T00:00:00.000Z');
    await db
      .updateTable('users')
      .set({ email_notified_at: '2026-08-01T00:00:00.000Z' })
      .where('id', '=', bob)
      .execute();
    await arrive('Permission slip', { at: '2026-08-20T10:00:00.000Z' });

    expect(await notifyNewMail(db, bob)).toBe(0);
  });
});
