/**
 * A list the user already left is not handed back as the next one to leave
 * (ADR 0246 addendum 2026-11-05).
 *
 * The reported failure: the user unsubscribed, then asked again "who should I
 * unsubscribe from" / "who emails me most" and got the same lists, because the
 * ranking counted the 90 days of mail sent BEFORE they left, and the already-
 * asked marker was added after the top 30 were picked - so the left list kept
 * its slot and the next one never moved up.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { setAutoTrash } from '@/services/email/auto-trash.service.js';
import { senderStats } from '@/services/email/sender-stats.service.js';
import { listSubscriptions, unsubscribeThread } from '@/services/email/unsubscribe.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

// One-click POSTs go through the real SSRF guard; only DNS is faked.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34' }] }));

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let db: Kysely<DB>;
let userId: string;
let personalId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'ro');
  personalId = (await ensurePersonalGroup(db, userId)).id;
  vi.stubGlobal('fetch', async () => new Response('', { status: 200 }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

/** `count` one-click list emails from `from`, the newest `daysAgo` old. Returns the newest thread. */
async function listMail(from: string, count: number, daysAgo = 1): Promise<string> {
  let newest = '';
  for (let i = 0; i < count; i += 1) {
    const id = await seedPlainMail(db, userId, {
      subject: `Deals ${i}`,
      fromEmail: from,
      fromName: from.split('@')[0],
      at: ago(daysAgo + i * 0.5),
    });
    await db
      .updateTable('email_messages')
      .set({
        list_unsubscribe: `<https://${from.split('@')[1]}/u/1>`,
        list_unsubscribe_post: 'List-Unsubscribe=One-Click',
      })
      .where('thread_id', '=', id)
      .execute();
    if (i === 0) newest = id;
  }
  return newest;
}

/** Move the recorded request back in time, as if it was made `days` ago. */
async function askedDaysAgo(sender: string, days: number): Promise<void> {
  await db
    .updateTable('email_unsubscribes')
    .set({ requested_at: ago(days) })
    .where('user_id', '=', userId)
    .where('sender_email', '=', sender)
    .execute();
}

const listTool = async () => {
  const res = await applyToolCall(db, {
    groupId: personalId,
    actorUserId: userId,
    provenance: null,
    mode: 'commit',
    tz: 'America/New_York',
    call: { name: 'list_subscriptions', args: {} } as never,
  });
  return (res.data as { senders: Array<{ senderEmail: string; stillMailing?: boolean; messages: number }> }).senders;
};

describe('asking again after unsubscribing', () => {
  it('drops the list just left and moves the next one up into the answer', async () => {
    // The busiest list, then 30 one-email lists: the tool shows 30, so before
    // leaving the busiest one the oldest small list is the one cut off.
    const busiest = await listMail('deals@macys.example', 6);
    const small: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const from = `news${i}@list${i}.example`;
      small.push(from);
      await listMail(from, 1, 2 + i);
    }
    const before = (await listTool()).map((s) => s.senderEmail);
    expect(before[0]).toBe('deals@macys.example');
    expect(before).not.toContain(small[29]);

    const out = await unsubscribeThread(db, userId, busiest);
    expect(out.unsubscribed).toBe(true);

    const after = (await listTool()).map((s) => s.senderEmail);
    expect(after).not.toContain('deals@macys.example');
    expect(after.sort()).toEqual([...small].sort());
  });

  it('shows the same list again only when it kept mailing past the grace, counting just that mail', async () => {
    const thread = await listMail('deals@macys.example', 5, 12);
    await unsubscribeThread(db, userId, thread);
    await askedDaysAgo('deals@macys.example', 10);

    // A day after the request: still inside the grace, the request landing.
    await listMail('deals@macys.example', 1, 9);
    expect((await listTool()).map((s) => s.senderEmail)).not.toContain('deals@macys.example');

    // Five days after: the list is ignoring the request.
    await listMail('deals@macys.example', 2, 4);
    const row = (await listTool()).find((s) => s.senderEmail === 'deals@macys.example');
    expect(row).toMatchObject({ stillMailing: true, messages: 2 });
  });

  it('leaves out a list whose mail already goes to Trash', async () => {
    await listMail('deals@macys.example', 4);
    await listMail('news@other.example', 1);
    await setAutoTrash(db, userId, ['deals@macys.example'], true);
    expect((await listTool()).map((s) => s.senderEmail)).toEqual(['news@other.example']);
  });

  it('still lists a left sender on the Mailing lists screen, marked as asked', async () => {
    const thread = await listMail('deals@macys.example', 3);
    await unsubscribeThread(db, userId, thread);
    const rows = await listSubscriptions(db, userId);
    expect(rows.find((r) => r.senderEmail === 'deals@macys.example')?.requestedAt).toBeTruthy();
  });

  it('takes the left list out of "who emails me most", and back in with an honest count if it kept mailing', async () => {
    const thread = await listMail('deals@macys.example', 6, 20);
    await listMail('news@other.example', 2);
    await unsubscribeThread(db, userId, thread);
    await askedDaysAgo('deals@macys.example', 15);

    let rows = await senderStats(db, userId, { rank: 'received', includeBulk: true });
    expect(rows.map((r) => r.email)).toEqual(['news@other.example']);

    await listMail('deals@macys.example', 1, 3);
    rows = await senderStats(db, userId, { rank: 'received', includeBulk: true });
    expect(rows.find((r) => r.email === 'deals@macys.example')).toMatchObject({ count: 1 });
    expect(rows.find((r) => r.email === 'deals@macys.example')?.unsubscribedAt).toBeTruthy();
  });

  it('does not report a list the user left as having "gone quiet"', async () => {
    const thread = await listMail('deals@macys.example', 6, 90);
    await unsubscribeThread(db, userId, thread);
    const rows = await senderStats(db, userId, { rank: 'gone_quiet', includeBulk: true });
    expect(rows.map((r) => r.email)).not.toContain('deals@macys.example');
  });
});
