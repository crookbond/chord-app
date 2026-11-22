/**
 * ADR 0246 — the two general mail query tools, and the coupon recipe.
 *
 * Pinned here: every count is the asker's own mail and nobody else's; mass
 * mail stays out of "who emails me" unless asked for; totals are kept per
 * currency and still come out right when the receipt is sealed at rest; and
 * the search query the coupon recipe tells the model to build returns the
 * store's coupon mail and nothing else.
 */
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  MAIL_QUESTION_RECIPES,
  PERSONAL_ONLY_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from '@/services/bot/tools.js';
import { sealThreadJson } from '@/services/email/content-seal.js';
import { keepReceipt, listReceipts, receiptsOverview } from '@/services/email/receipts.service.js';
import { senderStats } from '@/services/email/sender-stats.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('mail queries from chat (ADR 0246)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let otherId: string;
  let personalId: string;
  let sharedId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    otherId = await createUser(db, 'someone');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    sharedId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const call = (name: string, args: Record<string, unknown>, groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tz: 'America/New_York',
      call: { name, args } as never,
    });

  /** `count` one-message threads from a sender, the newest `daysAgo` old. */
  const mailFrom = async (
    fromEmail: string,
    fromName: string,
    o: { count?: number; daysAgo?: number; owner?: string; set?: Record<string, unknown>; msg?: Record<string, unknown> } = {},
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < (o.count ?? 1); i += 1) {
      const id = await seedPlainMail(db, o.owner ?? userId, {
        subject: `Note ${i} from ${fromName}`,
        fromEmail,
        fromName,
        at: ago((o.daysAgo ?? 1) + i),
      });
      if (o.set) await db.updateTable('email_threads').set(o.set as never).where('id', '=', id).execute();
      if (o.msg) await db.updateTable('email_messages').set(o.msg as never).where('thread_id', '=', id).execute();
      ids.push(id);
    }
    return ids;
  };

  it('registers both tools as read-only and personal-only, and the recipes name them', () => {
    for (const name of ['query_mail_senders', 'query_receipts'] as const) {
      expect(PERSONAL_ONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(READONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(MAIL_QUESTION_RECIPES).toContain(name);
    }
  });

  describe('query_mail_senders', () => {
    it('ranks who writes most from the asker’s own mail, leaving mass mail out unless asked', async () => {
      await mailFrom('chen@school.org', 'Ms Chen', { count: 3 });
      await mailFrom('dad@family.example', 'Dad', { count: 2 });
      await mailFrom('news@target.example', 'Target', { count: 9, set: { bulk: 1 } });
      await mailFrom('list@club.example', 'Club', { count: 6, msg: { list_unsubscribe: '<https://club.example/u>' } });
      await mailFrom('stranger@theirs.example', 'Stranger', { count: 30, owner: otherId });
      await db
        .insertInto('people')
        .values({
          id: newId('per'),
          owner_user_id: userId,
          display_name: 'Papa',
          email: 'Dad@Family.example',
          created_at: ago(0),
          updated_at: ago(0),
        } as never)
        .execute();

      const rows = await senderStats(db, userId, { rank: 'received' });
      expect(rows.map((r) => [r.email, r.name, r.count, r.inPeople])).toEqual([
        ['chen@school.org', 'Ms Chen', 3, false],
        // The name the user gave wins over the From header.
        ['dad@family.example', 'Papa', 2, true],
      ]);

      const withBulk = await senderStats(db, userId, { rank: 'received', includeBulk: true });
      expect(withBulk.map((r) => r.email).slice(0, 2)).toEqual(['news@target.example', 'list@club.example']);
    });

    it('counts who the user writes to from sent mail only', async () => {
      const sent = { gmail_label_ids: JSON.stringify(['SENT']) };
      await mailFrom('ro@example.com', 'Ro', {
        count: 3,
        msg: { ...sent, to_emails: JSON.stringify(['Coach@Club.example']) },
      });
      await mailFrom('ro@example.com', 'Ro', {
        msg: { ...sent, to_emails: JSON.stringify(['dad@family.example', 'coach@club.example']) },
      });
      // Received mail addressed to someone else is not the user writing to them.
      await mailFrom('chen@school.org', 'Ms Chen', { msg: { to_emails: JSON.stringify(['parents@school.org']) } });

      const rows = await senderStats(db, userId, { rank: 'written_to' });
      expect(rows.map((r) => [r.email, r.count])).toEqual([
        ['coach@club.example', 4],
        ['dad@family.example', 1],
      ]);
    });

    it('lists who is waiting on a reply, longest wait first', async () => {
      await mailFrom('chen@school.org', 'Ms Chen', { daysAgo: 2, set: { action: 'reply_needed' } });
      await mailFrom('dad@family.example', 'Dad', { count: 2, daysAgo: 9, set: { action: 'reply_needed' } });
      await mailFrom('done@x.example', 'Done', { set: { action: 'reply_needed', is_archived: 1 } });
      await mailFrom('fyi@x.example', 'Fyi', { set: { action: 'informational' } });

      const rows = await senderStats(db, userId, { rank: 'awaiting_reply' });
      expect(rows.map((r) => [r.email, r.count])).toEqual([
        ['dad@family.example', 2],
        ['chen@school.org', 1],
      ]);
      const week = await senderStats(db, userId, { rank: 'awaiting_reply', quietDays: 7 });
      expect(week.map((r) => r.email)).toEqual(['dad@family.example']);
    });

    it('reports a sender with real history who has gone quiet, not every one-off', async () => {
      await mailFrom('aunt@family.example', 'Aunt Mo', { count: 6, daysAgo: 90 });
      await mailFrom('once@x.example', 'Once', { count: 1, daysAgo: 200 });
      await mailFrom('chen@school.org', 'Ms Chen', { count: 6, daysAgo: 1 });

      const rows = await senderStats(db, userId, { rank: 'gone_quiet' });
      expect(rows.map((r) => r.email)).toEqual(['aunt@family.example']);
    });

    it('is refused in a shared group', async () => {
      await mailFrom('chen@school.org', 'Ms Chen', { count: 3 });
      const res = await call('query_mail_senders', { rank: 'received' }, sharedId);
      expect(res.data).toMatchObject({ rows: [] });
      const ok = await call('query_mail_senders', { rank: 'received' });
      expect((ok.data as { rows: unknown[] }).rows).toHaveLength(1);
    });
  });

  describe('query_receipts', () => {
    const receipt = async (
      merchant: string,
      amount: number,
      purchasedAt: string | null,
      o: { owner?: string; currency?: string | null; orderNumber?: string; labels?: string[]; seal?: boolean } = {},
    ): Promise<string> => {
      const owner = o.owner ?? userId;
      const id = await seedPlainMail(db, owner, {
        subject: `Your ${merchant} order`,
        fromEmail: `orders@${merchant.toLowerCase().replace(/\W/g, '')}.example`,
        fromName: merchant,
        at: purchasedAt ?? ago(3),
        labels: o.labels,
      });
      const value = {
        merchant,
        amount,
        currency: o.currency === undefined ? 'USD' : o.currency,
        purchasedAt,
        orderNumber: o.orderNumber ?? null,
      };
      const stored = o.seal ? await sealThreadJson(owner, 'receipt_json', value) : JSON.stringify(value);
      await sql`UPDATE email_threads SET receipt_json = ${stored}::jsonb WHERE id = ${id}`.execute(db);
      // ADR 0249 — the totals read the kept copy, which the pass writes too.
      await keepReceipt(db, id, value);
      return id;
    };

    it('totals per currency for the asker only, counting trashed mail and skipping repeat emails for one order', async () => {
      await receipt('Amazon', 40, '2026-09-10T15:00:00Z', { orderNumber: 'A-1' });
      await receipt('Amazon', 40, '2026-09-12T15:00:00Z', { orderNumber: 'A-1' });
      await receipt('Amazon', 10.5, '2026-09-20T15:00:00Z');
      await receipt('Amazon', 7, '2026-09-21T15:00:00Z', { currency: 'EUR' });
      await receipt('Target', 99, '2026-09-22T15:00:00Z', { labels: ['TRASH'] });
      await receipt('Amazon', 500, '2026-09-15T15:00:00Z', { owner: otherId });

      const { receipts } = await listReceipts(db, userId, { merchant: 'amazon' });
      expect(receipts.map((r) => [r.amount, r.currency])).toEqual([
        [7, 'EUR'],
        [10.5, 'USD'],
        [40, 'USD'],
      ]);

      const res = await call('query_receipts', { groupBy: 'merchant' });
      const data = res.data as {
        count: number;
        totals: Array<{ currency: string; total: number }>;
        groups: Array<{ key: string; currency: string; total: number }>;
        coverage: string;
      };
      // ADR 0249 — the trashed Target receipt still counts.
      expect(data.count).toBe(4);
      expect(data.totals).toEqual(
        expect.arrayContaining([
          { currency: 'USD', total: 149.5 },
          { currency: 'EUR', total: 7 },
        ]),
      );
      expect(data.groups).toEqual([
        { key: 'Target', currency: 'USD', total: 99, count: 1 },
        { key: 'Amazon', currency: 'USD', total: 50.5, count: 2 },
        { key: 'Amazon', currency: 'EUR', total: 7, count: 1 },
      ]);
      expect(data.coverage).toMatch(/Not total spending/);
      expect(res.cards?.[0]?.href).toMatch(/^\/email\//);
    });

    it('reads a date range in the user’s own days', async () => {
      // 11pm on 30 September in New York is already 1 October in UTC.
      await receipt('Late Shop', 5, '2026-10-01T03:00:00Z');
      await receipt('October Shop', 8, '2026-10-02T15:00:00Z');
      const sept = await call('query_receipts', { after: '2026-09-01', before: '2026-09-30' });
      expect((sept.data as { receipts: Array<{ merchant: string }> }).receipts.map((r) => r.merchant)).toEqual([
        'Late Shop',
      ]);
    });

    it('falls back to the email’s date when the receipt named none, and never guesses a currency', async () => {
      await receipt('Corner Cafe', 4.25, null, { currency: null });
      const { receipts } = await listReceipts(db, userId);
      expect(receipts[0]).toMatchObject({ merchant: 'Corner Cafe', currency: 'unspecified' });
      expect(Date.parse(receipts[0].at)).toBeGreaterThan(Date.now() - 4 * DAY);
    });

    it('still totals when the receipt is sealed at rest', async () => {
      setContentEncryption(true);
      const id = await receipt('Sealed Shop', 12.5, '2026-09-10T15:00:00Z', { seal: true });
      const stored = await sql<{ t: string }>`SELECT receipt_json::text AS t FROM email_threads WHERE id = ${id}`.execute(db);
      expect(stored.rows[0]!.t).not.toContain('Sealed Shop');

      const res = await call('query_receipts', { merchant: 'sealed' });
      expect(res.data).toMatchObject({ count: 1, totals: [{ currency: 'USD', total: 12.5 }] });
    });

    it('finds a repeating charge and offers its next expected date', async () => {
      for (const d of [65, 35, 5]) await receipt('Netflix', 15.49, ago(d));
      await receipt('Amazon', 20, ago(4));
      const res = await call('query_receipts', { recurring: true });
      const data = res.data as { recurring: Array<{ merchant: string; cadence: string; nextExpectedAt: string }> };
      expect(data.recurring).toHaveLength(1);
      expect(data.recurring[0]).toMatchObject({ merchant: 'Netflix', cadence: 'monthly' });
      expect(Date.parse(data.recurring[0].nextExpectedAt)).toBeGreaterThan(Date.now());
    });

    it('gives the Finance tab the same receipts, months in the user’s zone, and repeating charges', async () => {
      await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', userId).execute();
      for (const d of [65, 35, 5]) await receipt('Netflix', 15.49, ago(d));
      // Its own currency, so its month row holds this one purchase and nothing else.
      await receipt('Late Shop', 5, '2026-10-01T03:00:00Z', { currency: 'CAD' });
      await receipt('Theirs', 900, ago(2), { owner: otherId });

      const overview = await receiptsOverview(db, userId);
      expect(overview.receipts).toHaveLength(4);
      expect(overview.receipts.some((r) => r.merchant === 'Theirs')).toBe(false);
      expect(overview.months).toContainEqual({ month: '2026-09', currency: 'CAD', total: 5, count: 1 });
      expect(overview.recurring.map((c) => c.merchant)).toEqual(['Netflix']);
      expect(overview.truncated).toBe(false);
    });

    it('is refused in a shared group', async () => {
      await receipt('Amazon', 40, '2026-09-10T15:00:00Z');
      const res = await call('query_receipts', {}, sharedId);
      expect(res.data).toMatchObject({ count: 0, receipts: [] });
    });
  });

  describe('the coupon recipe', () => {
    it('“coupons from:<store> newer_than:30d” returns that store’s coupon mail on both search paths', async () => {
      const now = ago(0);
      const catId = `${userId}:mk:coupons`;
      await db
        .insertInto('email_categories')
        .values({
          id: catId,
          user_id: userId,
          parent_id: null,
          title: 'Coupons',
          depth: 0,
          sort_order: 0,
          color: null,
          icon: null,
          gmail_label_id: null,
          updated_at: now,
        })
        .execute();
      const [cvsCoupon] = await mailFrom('deals@cvs.example', 'CVS', { daysAgo: 2, set: { category_id: catId } });
      // Same store, not a coupon; a coupon from another store; an old coupon.
      await mailFrom('deals@cvs.example', 'CVS', { daysAgo: 3 });
      await mailFrom('offers@target.example', 'Target', { daysAgo: 2, set: { category_id: catId } });
      await mailFrom('deals@cvs.example', 'CVS', { daysAgo: 60, set: { category_id: catId } });

      const query = 'coupons from:cvs newer_than:30d';
      const everything = await searchEverything(db, {
        userId,
        groupId: personalId,
        crossGroup: true,
        query,
        categories: ['emails'],
      });
      expect(everything.emails.map((e) => e.href)).toEqual([`/email/${cvsCoupon}`]);

      const hits = await searchHits(db, { userId, groupId: personalId, crossGroup: true, query, limit: 20 });
      expect(hits.hits.filter((h) => h.entityType === 'email').map((h) => h.entityId)).toEqual([cvsCoupon]);
    });
  });
});
