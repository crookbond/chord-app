/**
 * On-demand email summary over a window, sectioned by the ADR 0086 action axis.
 *
 * The subtle part is the window: "yesterday" is the USER'S yesterday. A thread
 * that arrives at 20:00 UTC is already tomorrow in Nairobi (+3), so the same
 * instant lands in different days depending on the reader's zone.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmailAction } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import {
  summarizeEmailWindow,
  todayInTz,
  zonedDayStartUtc,
} from '@/services/email/summary.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function setTz(userId: string, tz: string | null): Promise<void> {
  await db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();
}

async function seed(
  userId: string,
  subject: string,
  receivedAtIso: string,
  opts: { action?: EmailAction; unread?: boolean; archived?: boolean } = {},
): Promise<string> {
  const id = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: id,
      subject,
      from_email: 'sender@example.com',
      last_message_at: receivedAtIso,
      is_unread: opts.unread ? 1 : 0,
      is_archived: opts.archived ? 1 : 0,
      action: opts.action ?? null,
      created_at: receivedAtIso,
      updated_at: receivedAtIso,
    })
    .execute();
  return id;
}

describe('window resolution', () => {
  it('resolves a day boundary in the user zone, not UTC', () => {
    // 2026-03-10 00:00 in Nairobi (+3) is 2026-03-09T21:00Z.
    expect(zonedDayStartUtc('2026-03-10', 'Africa/Nairobi').toISOString()).toBe(
      '2026-03-09T21:00:00.000Z',
    );
    expect(zonedDayStartUtc('2026-03-10', null).toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });

  it('includes a thread that is same-day for the user but next-day in UTC', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, 'Africa/Nairobi');
    // 2026-03-10T22:30+03:00 == 2026-03-10T19:30Z - the user's 10th.
    await seed(uid, 'Late evening in Nairobi', '2026-03-10T19:30:00.000Z');

    const out = await summarizeEmailWindow(db, uid, { since: '2026-03-10', until: '2026-03-10' });

    expect(out.total).toBe(1);
  });

  it('excludes a thread that falls outside the user day', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, 'Africa/Nairobi');
    // 2026-03-09T23:00Z is already 02:00 on the 10th in Nairobi.
    await seed(uid, 'Just after midnight', '2026-03-09T23:00:00.000Z');

    const out = await summarizeEmailWindow(db, uid, { since: '2026-03-09', until: '2026-03-09' });

    expect(out.total).toBe(0);
  });

  it('defaults to the user yesterday', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, 'Africa/Nairobi');

    const out = await summarizeEmailWindow(db, uid);

    const today = todayInTz('Africa/Nairobi');
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(out.since).toBe(yesterday.toISOString().slice(0, 10));
    expect(out.until).toBe(out.since);
    expect(out.timezone).toBe('Africa/Nairobi');
  });

  it('spans a multi-day range inclusively', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    await seed(uid, 'day one', '2026-03-09T10:00:00.000Z');
    await seed(uid, 'day three', '2026-03-11T10:00:00.000Z');
    await seed(uid, 'outside', '2026-03-12T10:00:00.000Z');

    const out = await summarizeEmailWindow(db, uid, { since: '2026-03-09', until: '2026-03-11' });

    expect(out.total).toBe(2);
  });
});

describe('sections', () => {
  const DAY = { since: '2026-03-10', until: '2026-03-10' };
  const at = '2026-03-10T10:00:00.000Z';

  it('leads with what wants something and keeps FYI last', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    await seed(uid, 'statement', at, { action: 'informational' });
    await seed(uid, 'rsvp', at, { action: 'to_do' });
    await seed(uid, 'question', at, { action: 'reply_needed' });

    const out = await summarizeEmailWindow(db, uid, DAY);

    expect(out.sections.map((s) => s.key)).toEqual(['to_do', 'reply_needed', 'informational']);
    expect(out.sections[0].label).toBe('Needs doing');
  });

  it('buckets unclassified mail separately from an explicit other', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    await seed(uid, 'not yet classified', at);
    await seed(uid, 'explicitly other', at, { action: 'other' });

    const out = await summarizeEmailWindow(db, uid, DAY);

    const keys = out.sections.map((s) => s.key);
    expect(keys).toContain('unclassified');
    expect(keys).toContain('other');
    expect(out.sections.find((s) => s.key === 'unclassified')?.count).toBe(1);
  });

  it('keeps counts complete while capping the listed examples', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    for (let i = 0; i < 7; i++) await seed(uid, `todo ${i}`, at, { action: 'to_do' });

    const out = await summarizeEmailWindow(db, uid, { ...DAY, perSection: 2 });

    const section = out.sections.find((s) => s.key === 'to_do');
    expect(section?.count).toBe(7);
    expect(section?.items).toHaveLength(2);
  });

  it('omits empty sections rather than listing zeroes', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    await seed(uid, 'rsvp', at, { action: 'to_do' });

    const out = await summarizeEmailWindow(db, uid, DAY);

    expect(out.sections).toHaveLength(1);
  });

  it('counts unread and reports an empty window honestly', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    await seed(uid, 'unread one', at, { action: 'to_do', unread: true });
    await seed(uid, 'read one', at, { action: 'to_do' });

    const busy = await summarizeEmailWindow(db, uid, DAY);
    const quiet = await summarizeEmailWindow(db, uid, {
      since: '2026-03-01',
      until: '2026-03-01',
    });

    expect(busy.unread).toBe(1);
    expect(quiet.total).toBe(0);
    expect(quiet.sections).toEqual([]);
  });
});

describe('scope and hygiene', () => {
  const DAY = { since: '2026-03-10', until: '2026-03-10' };
  const at = '2026-03-10T10:00:00.000Z';

  it('excludes archived mail, matching every other email surface', async () => {
    const uid = await createUser(db, 'alice');
    await setTz(uid, null);
    await seed(uid, 'archived', at, { action: 'to_do', archived: true });

    const out = await summarizeEmailWindow(db, uid, DAY);

    expect(out.total).toBe(0);
  });

  it("never includes another user's mail", async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    await setTz(bob, null);
    await seed(alice, 'alice private', at, { action: 'to_do' });

    const out = await summarizeEmailWindow(db, bob, DAY);

    expect(out.total).toBe(0);
  });
});
