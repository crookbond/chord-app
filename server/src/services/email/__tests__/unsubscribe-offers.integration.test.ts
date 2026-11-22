/**
 * Offering to unsubscribe from a list the user never reads: one card per
 * ignored sender, ever, at most one new card a day, and nothing sent until the
 * card is tapped.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { offerUnsubscribes } from '@/services/email/unsubscribe-offers.js';
import { listSubscriptions } from '@/services/email/unsubscribe.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeParallelHandle, closeTestDb, createUser, openParallelHandle, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const MAILTO = '<mailto:leave@list.example?subject=unsubscribe>';

describe('unsubscribe offers', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'peace');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  /** `count` emails from one sender, one thread each; `opened` of them read. */
  const seed = async (o: { fromName: string; fromEmail: string; count: number; opened?: number; header?: string | null }) => {
    for (let i = 0; i < o.count; i += 1) {
      const at = new Date(Date.now() - (i + 1) * DAY).toISOString();
      const tid = newId('et');
      const gt = newId('gt');
      await db
        .insertInto('email_threads')
        .values({ id: tid, user_id: userId, gmail_thread_id: gt, subject: `From ${o.fromName}`, from_name: o.fromName, from_email: o.fromEmail, bulk: 1, last_message_at: at, created_at: at, updated_at: at })
        .execute();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'), user_id: userId, thread_id: tid, gmail_thread_id: gt, gmail_message_id: newId('gm'),
          from_name: o.fromName, from_email: o.fromEmail, to_emails: JSON.stringify(['peace@example.com']),
          subject: `From ${o.fromName}`, snippet: '', is_unread: i < (o.opened ?? 0) ? 0 : 1,
          gmail_label_ids: JSON.stringify(['INBOX']),
          list_unsubscribe: o.header === undefined ? MAILTO : o.header,
          internal_date: at, created_at: at,
        })
        .execute();
    }
  };

  it('offers one card for a list the user never opens, beside its newest email', async () => {
    await seed({ fromName: 'Valpak', fromEmail: 'offers@valpak.example', count: 5 });

    expect(await offerUnsubscribes(db, userId)).toBe(1);

    const cards = await listProposalsForGroup(db, personalId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.toolName).toBe('unsubscribe_from_sender');
    expect(cards[0]!.provenance).toMatch(/^gmail:/);
    expect(JSON.parse(cards[0]!.argsJson)).toMatchObject({ senderEmail: 'offers@valpak.example', why: '5 emails in the last 90 days, none opened' });
    expect(await db.selectFrom('email_unsubscribes').selectAll().execute()).toHaveLength(0);
  });

  it('never offers to unsubscribe from a sender who is likely a fake (ADR 0294), and offers the next list', async () => {
    // A brand name on a domain the brand does not send from: the shape of
    // the prod "Robinhood" phish. Five unopened emails with a one-click-able
    // header made it the list the offer picked first.
    await seed({ fromName: 'Robinhood Email Alerts', fromEmail: 'alerts@rh-account-review.com', count: 6 });
    await seed({ fromName: 'Valpak', fromEmail: 'offers@valpak.example', count: 5 });

    expect(await offerUnsubscribes(db, userId)).toBe(1);
    const cards = await listProposalsForGroup(db, personalId);
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0]!.argsJson)).toMatchObject({ senderEmail: 'offers@valpak.example' });
  });

  it('leaves alone a list the user opens, one with too few emails, and one with only a web page', async () => {
    await seed({ fromName: 'NYT', fromEmail: 'news@nyt.example', count: 6, opened: 1 });
    await seed({ fromName: 'New School', fromEmail: 'hello@school.example', count: 2 });
    await seed({ fromName: 'Medium', fromEmail: 'noreply@medium.example', count: 6, header: '<https://medium.example/unsub>' });

    expect(await offerUnsubscribes(db, userId)).toBe(0);
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);

    // The Mailing lists screen marks the lists never opened from this count.
    const lists = await listSubscriptions(db, userId);
    expect(lists.map((l) => [l.senderEmail, l.messages, l.opened]).sort()).toEqual([
      ['hello@school.example', 2, 0],
      ['news@nyt.example', 6, 1],
      ['noreply@medium.example', 6, 0],
    ]);
  });

  it('asks once per sender, and at most one new card a day', async () => {
    await seed({ fromName: 'Valpak', fromEmail: 'offers@valpak.example', count: 5 });
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs.example', count: 4 });

    expect(await offerUnsubscribes(db, userId)).toBe(1);
    expect(await offerUnsubscribes(db, userId)).toBe(0);

    // A day later: the other list, never the first one again.
    await db
      .updateTable('users')
      .set({ defaults: JSON.stringify({ unsubscribe_offered: { 'offers@valpak.example': new Date(Date.now() - 2 * DAY).toISOString() } }) as never })
      .where('id', '=', userId)
      .execute();
    expect(await offerUnsubscribes(db, userId)).toBe(1);
    const senders = (await listProposalsForGroup(db, personalId)).map((p) => (JSON.parse(p.argsJson) as { senderEmail: string }).senderEmail);
    expect(senders.sort()).toEqual(['email@crocs.example', 'offers@valpak.example']);
    expect(await offerUnsubscribes(db, userId)).toBe(0);
  });

  it('two syncs at once stage one card, not two', async () => {
    // Audit: the once-a-day check and the write after staging were separate
    // reads, so two overlapping syncs both passed and staged a card each.
    await seed({ fromName: 'Valpak', fromEmail: 'offers@valpak.example', count: 5 });
    await seed({ fromName: 'Crocs', fromEmail: 'email@crocs.example', count: 4 });
    const par = openParallelHandle(db);
    try {
      const out = await Promise.all([offerUnsubscribes(par, userId), offerUnsubscribes(par, userId)]);
      expect(out.reduce((a, b) => a + b, 0)).toBe(1);
    } finally {
      await closeParallelHandle(par);
    }
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(1);
  });

  it('a look that found nothing waits a day too, instead of scanning every sync', async () => {
    expect(await offerUnsubscribes(db, userId)).toBe(0);
    await seed({ fromName: 'Valpak', fromEmail: 'offers@valpak.example', count: 5 });
    expect(await offerUnsubscribes(db, userId)).toBe(0);

    const row = await db.selectFrom('users').select('defaults').where('id', '=', userId).executeTakeFirstOrThrow();
    const checked = (row.defaults as Record<string, string>)['unsubscribe_offer_checked']!;
    await db
      .updateTable('users')
      .set({ defaults: JSON.stringify({ unsubscribe_offer_checked: new Date(Date.parse(checked) - 2 * DAY).toISOString() }) as never })
      .where('id', '=', userId)
      .execute();
    expect(await offerUnsubscribes(db, userId)).toBe(1);
  });
});
