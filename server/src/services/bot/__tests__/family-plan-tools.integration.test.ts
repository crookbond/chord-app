/**
 * ADR 0231 — the family plan and checkout, said in chat. The tools call the
 * same service functions the Settings routes do; what is worth pinning here
 * is the part that is only true of chat: nothing is claimed that did not
 * happen, a shared group can't read or change a family roster, and the model
 * is handed a link to deliver but never one to recite.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES, READONLY_TOOL_NAMES, toolSchemas } from '@/services/bot/tools.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { generatePromoCodes } from '@/services/promo.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('family plan + checkout tools', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John Doe');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => closeTestDb(db));

  const call = (name: string, args: Record<string, unknown>, groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      call: { name, args } as never,
    });

  it('are personal-only, and the read-only ones are marked read-only', () => {
    for (const n of ['add_family_member', 'remove_family_member', 'list_family_members', 'get_checkout_link'] as const) {
      expect(toolSchemas[n]).toBeDefined();
      expect(PERSONAL_ONLY_TOOL_NAMES.has(n)).toBe(true);
    }
    expect(READONLY_TOOL_NAMES.has('list_family_members')).toBe(true);
    expect(READONLY_TOOL_NAMES.has('add_family_member')).toBe(false);
    expect(READONLY_TOOL_NAMES.has('remove_family_member')).toBe(false);
  });

  it('adds a child as a profile: no invite, no link, no seat', async () => {
    const r = await call('add_family_member', { name: 'Aarav', relationship: 'son' });
    expect(r.data).toMatchObject({ ok: true, member: { name: 'Aarav', status: 'profile' } });
    expect((r.data as { inviteLink?: string }).inviteLink).toBeUndefined();
    expect(r.card).toBeUndefined();
  });

  it('an email invite returns the link and message, and emails it from the owner mailbox (ADR 0237)', async () => {
    const prior = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    try {
      const r = await call('add_family_member', {
        name: 'Priya',
        email: 'priya@example.com',
        chordinator: true,
        invite: true,
      });
      const data = r.data as {
        ok: boolean;
        inviteLink: string;
        message: string;
        joined: boolean;
        delivery: { email: string };
      };
      expect(data).toMatchObject({ ok: true, joined: false, delivery: { email: 'queued' } });
      expect(data.inviteLink).toContain('/join/FAM');
      expect(data.message).toContain(data.inviteLink);
      expect(r.card).toBeUndefined(); // no phone, so no text card
      const outbox = await db.selectFrom('email_drafts').select(['to_emails', 'subject', 'send_after']).execute();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.to_emails).toEqual(['priya@example.com']);
      expect(outbox[0]!.send_after).not.toBeNull();
    } finally {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = prior;
    }
  });

  it('without a mailbox Chord may send from, says it was NOT emailed rather than implying it was', async () => {
    const r = await call('add_family_member', { name: 'Priya', email: 'priya@example.com', invite: true });
    expect(r.data).toMatchObject({ ok: true, joined: false, delivery: { email: 'no_mailbox' } });
    expect(await db.selectFrom('email_drafts').selectAll().execute()).toHaveLength(0);
  });

  it('a phone-only invite attaches a Text card carrying the link', async () => {
    const r = await call('add_family_member', { name: 'Mom', phone: '+15551234567', invite: true });
    expect(r.card).toMatchObject({ kind: 'action', title: 'Text Mom the invite' });
    expect(r.card?.url).toContain('/join/FAM');
    expect(r.card?.appUrl).toMatch(/^sms:\+15551234567\?&body=/);
  });

  it('says why instead of pretending: bad email, nothing to reach them on, full plan', async () => {
    expect((await call('add_family_member', { name: 'X', email: 'nope' })).data).toMatchObject({
      ok: false,
      reason: 'invalid_email',
    });
    expect((await call('add_family_member', { name: 'Y', invite: true })).data).toMatchObject({
      ok: false,
      reason: 'need_contact',
    });
    for (const n of ['A', 'B', 'C']) {
      await call('add_family_member', { name: `Seat ${n}`, email: `${n}@example.com`, invite: true });
    }
    expect((await call('add_family_member', { name: 'Fifth', email: 'f@example.com', invite: true })).data).toMatchObject({
      ok: false,
      reason: 'no_seats',
    });
  });

  it('lists the roster without handing the model invite links to recite', async () => {
    await call('add_family_member', { name: 'Priya', email: 'p@example.com', invite: true });
    const r = await call('list_family_members', {});
    const data = r.data as { seatsUsed: number; members: Array<Record<string, unknown>> };
    expect(data.seatsUsed).toBe(2);
    expect(data.members[0]).toMatchObject({ name: 'Priya', status: 'invited', hasEmail: true });
    expect(JSON.stringify(data)).not.toContain('/join/');
  });

  it('removal asks when the name is ambiguous, and removes when it is not', async () => {
    await call('add_family_member', { name: 'Priya Doe' });
    await call('add_family_member', { name: 'Priya Rao' });
    const amb = await call('remove_family_member', { name: 'Priya' });
    expect(amb.data).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect((amb.data as { candidates: string[] }).candidates.sort()).toEqual(['Priya Doe', 'Priya Rao']);
    expect((await call('remove_family_member', { name: 'Priya Rao' })).data).toMatchObject({ ok: true });
    expect((await call('remove_family_member', { name: 'Nobody' })).data).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('a shared group turn can neither read nor change the roster', async () => {
    const gid = (await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: userId })).id;
    for (const [name, args] of [
      ['add_family_member', { name: 'Leak' }],
      ['list_family_members', {}],
      ['remove_family_member', { name: 'Leak' }],
      ['get_checkout_link', { plan: 'family' }],
    ] as const) {
      expect((await call(name, args, gid)).data).toMatchObject({ ok: false, reason: 'personal_only' });
    }
    expect(await db.selectFrom('family_members').selectAll().execute()).toHaveLength(0);
  });

  describe('get_checkout_link', () => {
    beforeEach(() => {
      (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    });
    afterEach(() => {
      (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
      (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
      (env as { STRIPE_PRICE_ID_FAMILY: string }).STRIPE_PRICE_ID_FAMILY = '';
    });

    it('is honest when purchasing is not set up', async () => {
      expect((await call('get_checkout_link', { plan: 'family' })).data).toMatchObject({
        ok: false,
        reason: 'billing_unavailable',
      });
    });

    it('the base plan is its own plan: a configured family price does not stand in for it (ADR 0238)', async () => {
      (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
      (env as { STRIPE_PRICE_ID_FAMILY: string }).STRIPE_PRICE_ID_FAMILY = 'price_fam';
      // ...so asking for it is answered from ITS price (unset here), never by selling family.
      const r = await call('get_checkout_link', { plan: 'base' });
      expect(r.data).toMatchObject({ ok: false, reason: 'billing_unavailable' });
      expect(r.card).toBeUndefined();
      // There is no annual base price, so an annual request must be read as
      // monthly: it reaches the already-subscribed answer instead of dying as
      // "billing_unavailable" against a price that does not exist.
      (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = 'price_byok';
      try {
        await db
          .updateTable('users')
          .set({ subscription_plan: 'byok_base', subscription_source: 'stripe',
                 subscription_current_period_end: new Date(Date.now() + 86_400_000).toISOString() })
          .where('id', '=', userId)
          .execute();
        expect((await call('get_checkout_link', { plan: 'base', interval: 'year' })).data).toMatchObject({
          ok: false,
          reason: 'already_subscribed',
        });
      } finally {
        (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = '';
      }
    });

    it('refuses a code that does not work before building any link', async () => {
      (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
      (env as { STRIPE_PRICE_ID_FAMILY: string }).STRIPE_PRICE_ID_FAMILY = 'price_fam';
      const r = await call('get_checkout_link', { plan: 'family', code: 'CHORD-ZZZZ-ZZZZ' });
      expect(r.data).toMatchObject({ ok: false, reason: 'invalid_code' });
      expect(r.card).toBeUndefined();
      const [used] = await generatePromoCodes(db, { count: 1 });
      await db.updateTable('promo_codes').set({ redeemed_at: new Date().toISOString() }).where('code', '=', used!).execute();
      expect((await call('get_checkout_link', { plan: 'family', code: used })).data).toMatchObject({
        reason: 'code_used',
      });
    });
  });
});
