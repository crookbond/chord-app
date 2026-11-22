/**
 * ADR 0231 — the family plan, annual billing, grandfathering and promo codes,
 * through the real entitlement function and the real tables. Everything that
 * decides "may this person use AI right now" is checked here, because that
 * decision is the one thing in billing that must never be wrong in either
 * direction: charging someone covered, or covering someone not paying.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FAMILY_SEATS, isFamilyInviteCode } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { allowanceWindowStart, nextAllowanceReset } from '@/services/billing-window.js';
import { familyTokenAllowance, getEntitlement } from '@/services/billing.service.js';
import { subscriptionCheckoutEnabled } from '@/services/stripe.service.js';
import {
  acceptFamilyInvite,
  addFamilyMember,
  getFamilyOverview,
  inviteFamilyMember,
  leaveFamily,
  removeFamilyMember,
  updateFamilyMember,
} from '@/services/family-plan.service.js';
import {
  grandfatherUsersCreatedBefore,
  previewGrandfather,
  setGrandfathered,
} from '@/services/grandfather.service.js';
import {
  checkPromoCode,
  generatePromoCodes,
  normalizePromoCode,
  redeemPromoCode,
} from '@/services/promo.service.js';
import { recordTokenUsage } from '@/services/tokens.service.js';
import { isTrusted } from '@/services/trust.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// ADR 0325 — these tests are about the plans' own rules (and back-date accounts
// to step past the old 30-day trial). The one-time free allowance would cover
// every gated case here, so it is switched off; billing-free-allowance covers it.
const savedFreeAllowance = env.FREE_TOKEN_ALLOWANCE;
beforeEach(() => {
  (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = 0;
});
afterEach(() => {
  (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = savedFreeAllowance;
});

const DAY = 86_400_000;

async function spend(db: Kysely<DB>, userId: string, tokens: number, at?: Date): Promise<void> {
  await recordTokenUsage(db, {
    userId,
    source: 'bot_turn',
    ref: `s-${Math.random()}`,
    model: 'gpt-x',
    promptTokens: tokens,
    completionTokens: 0,
  });
  if (at) {
    await db
      .updateTable('token_usage')
      .set({ created_at: at.toISOString() })
      .where('user_id', '=', userId)
      .where('prompt_tokens', '=', tokens)
      .execute();
  }
}

/** Past the 30-day trial, so the subscription/comp paths are what's exercised. */
async function pastTrial(db: Kysely<DB>, userId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ created_at: new Date(Date.now() - 90 * DAY).toISOString() })
    .where('id', '=', userId)
    .execute();
}

async function subscribe(
  db: Kysely<DB>,
  userId: string,
  plan: 'system' | 'family',
  interval: 'month' | 'year',
  startedDaysAgo: number,
  endsInDays: number,
): Promise<void> {
  await pastTrial(db, userId);
  await db
    .updateTable('users')
    .set({
      subscription_plan: plan,
      subscription_interval: interval,
      subscription_source: 'stripe',
      subscription_period_started_at: new Date(Date.now() - startedDaysAgo * DAY).toISOString(),
      subscription_current_period_end: new Date(Date.now() + endsInDays * DAY).toISOString(),
    })
    .where('id', '=', userId)
    .execute();
}

describe('allowanceWindowStart', () => {
  it('a monthly period is its own window', () => {
    const start = '2026-10-01T00:00:00.000Z';
    expect(allowanceWindowStart(start, new Date('2026-10-20T00:00:00.000Z'))).toBe(start);
  });

  it('an annual period resets on each monthly anniversary', () => {
    const start = '2026-01-15T10:00:00.000Z';
    expect(allowanceWindowStart(start, new Date('2026-04-14T09:00:00.000Z'))).toBe('2026-03-15T10:00:00.000Z');
    expect(allowanceWindowStart(start, new Date('2026-04-15T10:00:00.000Z'))).toBe('2026-04-15T10:00:00.000Z');
  });

  it('clamps a 31st-of-the-month anchor into short months without drifting', () => {
    const start = '2026-01-31T00:00:00.000Z';
    expect(allowanceWindowStart(start, new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-02-28T00:00:00.000Z');
    expect(allowanceWindowStart(start, new Date('2026-03-31T00:00:00.000Z'))).toBe('2026-03-31T00:00:00.000Z');
  });
});

describe('nextAllowanceReset', () => {
  it('is one month after the current window began, never past the paid period', () => {
    const start = '2026-01-15T10:00:00.000Z';
    expect(nextAllowanceReset(start, '2027-01-15T10:00:00.000Z', new Date('2026-04-20T00:00:00.000Z'))).toBe(
      '2026-05-15T10:00:00.000Z',
    );
    // A monthly plan's refill IS its renewal.
    expect(nextAllowanceReset(start, '2026-02-15T10:00:00.000Z', new Date('2026-01-20T00:00:00.000Z'))).toBe(
      '2026-02-15T10:00:00.000Z',
    );
  });
});

describe('entitlement under annual billing, family pooling and grandfathering', () => {
  let db: Kysely<DB>;
  const originalBilling = env.BILLING_ENABLED;

  beforeEach(async () => {
    db = await openTestDb();
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
  });
  afterEach(async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = originalBilling;
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = '';
    await closeTestDb(db);
  });

  it('an annual subscriber gets the MONTHLY allowance, not a year of it up front', async () => {
    const u = await createUser(db, 'annual');
    // Paid 100 days ago for a year: the window is the current month of it.
    await subscribe(db, u, 'system', 'year', 100, 265);
    // 4.9M spent in month 1 and 2 of the year — must not count now.
    await spend(db, u, 4_900_000, new Date(Date.now() - 80 * DAY));
    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: true, reason: 'tokens', plan: 'system', interval: 'year' });
    expect(ent.balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE);
    // Spending inside the current month does count.
    await spend(db, u, 1_000_000);
    expect((await getEntitlement(db, u)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE - 1_000_000);
  });

  it('a subscriber who has spent everything is still shown their plan, with when tokens return', async () => {
    const u = await createUser(db, 'spent');
    await subscribe(db, u, 'system', 'month', 5, 25);
    await spend(db, u, env.MONTHLY_TOKEN_ALLOWANCE);
    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: false, reason: 'none', plan: 'system', allowance: env.MONTHLY_TOKEN_ALLOWANCE });
    expect(Date.parse(ent.allowanceResetsAt!)).toBeGreaterThan(Date.now());
    // The Settings screen reads this: a plan, not a prompt to buy another.
    const status = await getBillingStatus(db, u);
    expect(status).toMatchObject({ entitlement: 'none', plan: 'system' });
    expect(status.tokensQuotaPerMonth).toBe(env.MONTHLY_TOKEN_ALLOWANCE);
    expect(status.allowanceResetsAt).toBe(ent.allowanceResetsAt);
  });

  it('a family shares ONE pool: anyone spending draws it down for everyone', async () => {
    const owner = await createUser(db, 'owner');
    const spouse = await createUser(db, 'spouse');
    await subscribe(db, owner, 'family', 'month', 5, 25);
    await pastTrial(db, spouse);

    const added = await addFamilyMember(db, owner, { name: 'Spouse', email: 'spouse@example.com', invite: true });
    expect(added.ok).toBe(true);
    const code = (added as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    expect((await acceptFamilyInvite(db, spouse, code)).ok).toBe(true);

    // Before anyone spends: both see the whole pool.
    expect((await getEntitlement(db, spouse)).balance).toBe(familyTokenAllowance());
    expect(await getEntitlement(db, spouse)).toMatchObject({ plan: 'family', family: { role: 'member' } });
    expect(await getEntitlement(db, owner)).toMatchObject({ plan: 'family', family: { role: 'owner' } });

    // The owner spends most of it; the spouse's number moves too.
    const pool = familyTokenAllowance();
    const ownerShare = pool - env.MONTHLY_TOKEN_ALLOWANCE - 1_000_000;
    await spend(db, owner, ownerShare);
    expect((await getEntitlement(db, spouse)).balance).toBe(pool - ownerShare);

    // The spouse can keep going past a single person's allowance - "until the family is done".
    await spend(db, spouse, env.MONTHLY_TOKEN_ALLOWANCE);
    expect((await getEntitlement(db, spouse)).entitled).toBe(true);
    // ...and when the family total is used up, both stop.
    await spend(db, spouse, 1_000_000);
    expect((await getEntitlement(db, spouse)).entitled).toBe(false);
    expect((await getEntitlement(db, owner)).entitled).toBe(false);
  });

  describe('the pool follows the individual allowance', () => {
    const saved = { monthly: env.MONTHLY_TOKEN_ALLOWANCE, family: env.FAMILY_TOKEN_ALLOWANCE };
    afterEach(() => {
      (env as { MONTHLY_TOKEN_ALLOWANCE: number }).MONTHLY_TOKEN_ALLOWANCE = saved.monthly;
      (env as { FAMILY_TOKEN_ALLOWANCE: number }).FAMILY_TOKEN_ALLOWANCE = saved.family;
    });

    async function familyMember(tag: string): Promise<string> {
      const owner = await createUser(db, `owner-${tag}`);
      const member = await createUser(db, `member-${tag}`);
      await subscribe(db, owner, 'family', 'month', 5, 25);
      await pastTrial(db, member);
      const added = await addFamilyMember(db, owner, { name: 'Member', email: `${tag}@example.com`, invite: true });
      const code = (added as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
      expect((await acceptFamilyInvite(db, member, code)).ok).toBe(true);
      return member;
    }

    it('with no override, raising the individual allowance raises the family pool to seats x it', async () => {
      (env as { FAMILY_TOKEN_ALLOWANCE: number }).FAMILY_TOKEN_ALLOWANCE = 0;
      (env as { MONTHLY_TOKEN_ALLOWANCE: number }).MONTHLY_TOKEN_ALLOWANCE = 10_000_000;
      const member = await familyMember('derive');
      const ent = await getEntitlement(db, member);
      expect(ent).toMatchObject({ plan: 'family', allowance: FAMILY_SEATS * 10_000_000, balance: 40_000_000 });
      // The Settings card shows the same number that is enforced.
      expect((await getBillingStatus(db, member)).tokensQuotaPerMonth).toBe(40_000_000);
    });

    it('an explicit FAMILY_TOKEN_ALLOWANCE still wins', async () => {
      (env as { FAMILY_TOKEN_ALLOWANCE: number }).FAMILY_TOKEN_ALLOWANCE = 30_000_000;
      (env as { MONTHLY_TOKEN_ALLOWANCE: number }).MONTHLY_TOKEN_ALLOWANCE = 10_000_000;
      const member = await familyMember('override');
      expect(await getEntitlement(db, member)).toMatchObject({ allowance: 30_000_000, balance: 30_000_000 });
    });
  });

  it('a lapsed owner stops covering the family — coverage is read from the owner every time', async () => {
    const owner = await createUser(db, 'owner2');
    const kid = await createUser(db, 'kid');
    await subscribe(db, owner, 'family', 'month', 40, -10); // ended 10 days ago
    await pastTrial(db, kid);
    const r = await addFamilyMember(db, owner, { name: 'Kid', phone: '+15551230000', invite: true });
    const code = (r as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    await acceptFamilyInvite(db, kid, code);
    expect((await getEntitlement(db, kid)).entitled).toBe(false);
  });

  it('removing a seated member ends their coverage immediately', async () => {
    const owner = await createUser(db, 'owner3');
    const member = await createUser(db, 'member3');
    await subscribe(db, owner, 'family', 'month', 5, 25);
    await pastTrial(db, member);
    const r = await addFamilyMember(db, owner, { name: 'Member Three', email: 'm3@example.com', invite: true });
    const code = (r as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    await acceptFamilyInvite(db, member, code);
    expect((await getEntitlement(db, member)).entitled).toBe(true);
    const id = (r as { member: { id: string } }).member.id;
    await removeFamilyMember(db, owner, id);
    expect((await getEntitlement(db, member)).entitled).toBe(false);
  });

  // ADR 0251 - BYOK just works: with no base price configured nobody is asked
  // for a base plan, at any age of the account.
  it('BYOK works past the trial and is never asked for a base plan while no base price is configured', async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    try {
      const u = await createUser(db, 'byok-free');
      await pastTrial(db, u);
      await db.updateTable('users').set({ model_key_ciphertext: Buffer.from('x') }).where('id', '=', u).execute();

      expect(await getEntitlement(db, u)).toMatchObject({ entitled: true, reason: 'byok' });
      expect(subscriptionCheckoutEnabled('byok_base')).toBe(false);
      // What the app is sent: no price and no Apple product, which is how the
      // plan card knows there is nothing to subscribe to or manage.
      const status = await getBillingStatus(db, u);
      expect(status.byokCheckoutAvailable).toBe(false);
      expect(status.byokPriceUsd).toBeUndefined();
      expect(status.appleByokProduct).toBeUndefined();

      // Configuring the base price is the one thing that makes it owed.
      (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = 'price_byok';
      expect((await getEntitlement(db, u)).reason).toBe('byok_unpaid');
      expect(subscriptionCheckoutEnabled('byok_base')).toBe(true);
      expect((await getBillingStatus(db, u)).byokPriceUsd).toBe(env.PRICE_BYOK_USD);
    } finally {
      (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
    }
  });

  it('a BYOK family member is covered by the plan when a base fee is required', async () => {
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = 'price_byok';
    const owner = await createUser(db, 'owner4');
    const byok = await createUser(db, 'byok4');
    await subscribe(db, owner, 'family', 'month', 5, 25);
    await pastTrial(db, byok);
    await db.updateTable('users').set({ model_key_ciphertext: Buffer.from('x') }).where('id', '=', byok).execute();
    expect((await getEntitlement(db, byok)).reason).toBe('byok_unpaid');
    const r = await addFamilyMember(db, owner, { name: 'Byok Four', email: 'b4@example.com', invite: true });
    const code = (r as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    await acceptFamilyInvite(db, byok, code);
    expect((await getEntitlement(db, byok)).reason).toBe('byok');
  });

  it('grandfathered users get the individual allowance free, permanently, on a calendar month', async () => {
    const u = await createUser(db, 'founder');
    await pastTrial(db, u);
    expect((await getEntitlement(db, u)).reason).toBe('none');
    await setGrandfathered(db, u, true);
    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: true, reason: 'grandfathered', allowance: env.GRANDFATHER_TOKEN_ALLOWANCE });
    // Spending is capped like anyone's, and last month's spend doesn't count.
    await spend(db, u, env.GRANDFATHER_TOKEN_ALLOWANCE, new Date(Date.now() - 45 * DAY));
    expect((await getEntitlement(db, u)).balance).toBe(env.GRANDFATHER_TOKEN_ALLOWANCE);
    await spend(db, u, env.GRANDFATHER_TOKEN_ALLOWANCE);
    expect((await getEntitlement(db, u)).entitled).toBe(false);
  });

  it('a grandfathered BYOK user owes no base fee even when one exists', async () => {
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = 'price_byok';
    const u = await createUser(db, 'founder-byok');
    await pastTrial(db, u);
    await db.updateTable('users').set({ model_key_ciphertext: Buffer.from('x'), grandfathered_at: new Date().toISOString() }).where('id', '=', u).execute();
    expect((await getEntitlement(db, u)).reason).toBe('byok');
  });

  it('a paid plan outranks the comp while it has room', async () => {
    const u = await createUser(db, 'founder-paid');
    await setGrandfathered(db, u, true);
    await subscribe(db, u, 'system', 'month', 5, 25);
    expect((await getEntitlement(db, u)).reason).toBe('tokens');
  });
});

describe('grandfather.service', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => closeTestDb(db));

  it('flags real accounts before the cutoff, never shadows or later signups, and is idempotent', async () => {
    const early = await createUser(db, 'early');
    const late = await createUser(db, 'late');
    const shadow = await createUser(db, 'shadow');
    await db.updateTable('users').set({ created_at: '2026-01-01T00:00:00.000Z' }).where('id', '=', early).execute();
    await db
      .updateTable('users')
      .set({ created_at: '2026-01-01T00:00:00.000Z', shadow: 1 })
      .where('id', '=', shadow)
      .execute();
    await db.updateTable('users').set({ created_at: '2026-12-01T00:00:00.000Z' }).where('id', '=', late).execute();

    const cutoff = '2026-06-01T00:00:00.000Z';
    expect(await previewGrandfather(db, cutoff)).toEqual({ eligible: 1, already: 0 });
    expect(await grandfatherUsersCreatedBefore(db, cutoff)).toBe(1);
    expect(await grandfatherUsersCreatedBefore(db, cutoff)).toBe(0);
    const flags = await db.selectFrom('users').select(['id', 'grandfathered_at']).execute();
    const by = Object.fromEntries(flags.map((r) => [r.id, r.grandfathered_at]));
    expect(by[early]).toBeTruthy();
    expect(by[late]).toBeNull();
    expect(by[shadow]).toBeNull();
  });
});

describe('promo codes', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => closeTestDb(db));

  it('generates distinct, well-formed codes', async () => {
    const codes = await generatePromoCodes(db, { count: 25 });
    expect(new Set(codes).size).toBe(25);
    for (const c of codes) expect(c).toMatch(/^CHORD-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('accepts a code however it was typed', () => {
    expect(normalizePromoCode('chord-abcd-efgh')).toBe('CHORD-ABCD-EFGH');
    expect(normalizePromoCode(' chord abcd efgh ')).toBe('CHORD-ABCD-EFGH');
    expect(normalizePromoCode('CHORDABCDEFGH')).toBe('CHORD-ABCD-EFGH');
    expect(normalizePromoCode('abcdefgh')).toBe('CHORD-ABCD-EFGH');
  });

  it('checks without burning; only the first redemption wins; used and expired are refused', async () => {
    const [code] = await generatePromoCodes(db, { count: 1, trialDays: 30 });
    const u1 = await createUser(db, 'p1');
    const u2 = await createUser(db, 'p2');
    expect(await checkPromoCode(db, code!.toLowerCase())).toEqual({ ok: true, code, trialDays: 30 });
    // Checking twice doesn't spend it.
    expect((await checkPromoCode(db, code!)).ok).toBe(true);
    expect(await redeemPromoCode(db, code!, u1)).toBe(true);
    expect(await redeemPromoCode(db, code!, u2)).toBe(false);
    expect(await checkPromoCode(db, code!)).toEqual({ ok: false, reason: 'code_used' });
    expect(await checkPromoCode(db, 'CHORD-NOPE-NOPE')).toEqual({ ok: false, reason: 'invalid_code' });
    const [old] = await generatePromoCodes(db, { count: 1, expiresAt: new Date(Date.now() - DAY).toISOString() });
    expect(await checkPromoCode(db, old!)).toEqual({ ok: false, reason: 'code_expired' });
  });
});

describe('family-plan.service', () => {
  let db: Kysely<DB>;
  let owner: string;
  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'fam-owner', 'John Doe');
  });
  afterEach(async () => closeTestDb(db));

  it('adds a profile with no seat, mirrors it into People, and merges a repeat by name', async () => {
    const r = await addFamilyMember(db, owner, { name: 'Aarav', relationship: 'son' });
    expect(r).toMatchObject({ ok: true, member: { name: 'Aarav', status: 'profile', inviteLink: null } });
    expect((await getFamilyOverview(db, owner)).seatsUsed).toBe(1);
    const person = await db.selectFrom('people').select(['display_name']).where('owner_user_id', '=', owner).execute();
    expect(person.map((p) => p.display_name)).toEqual(['Aarav']);
    // "add his email" later fills the same entry rather than minting a second Aarav.
    await addFamilyMember(db, owner, { name: 'aarav', email: 'Aarav@Example.com' });
    const rows = await db.selectFrom('family_members').selectAll().where('owner_user_id', '=', owner).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('aarav@example.com');
  });

  it('refuses a malformed email rather than guessing', async () => {
    expect(await addFamilyMember(db, owner, { name: 'X', email: 'not-an-email' })).toEqual({
      ok: false,
      reason: 'invalid_email',
    });
  });

  it('an invite needs a way to reach the person, and reuses the same link when re-sent', async () => {
    const noContact = await addFamilyMember(db, owner, { name: 'Nobody', invite: true });
    expect(noContact).toEqual({ ok: false, reason: 'need_contact' });
    const a = await addFamilyMember(db, owner, { name: 'Priya', email: 'priya@example.com', invite: true });
    const link1 = (a as { invite: { inviteLink: string } }).invite.inviteLink;
    expect(link1).toContain('/join/FAM');
    const id = (a as { member: { id: string } }).member.id;
    const again = await inviteFamilyMember(db, owner, id);
    expect((again as { inviteLink: string }).inviteLink).toBe(link1);
  });

  it(`holds ${FAMILY_SEATS} seats including the owner; profiles don't count`, async () => {
    for (const n of ['A', 'B', 'C']) {
      const r = await addFamilyMember(db, owner, { name: `Person ${n}`, email: `${n}@example.com`.toLowerCase(), invite: true });
      expect(r.ok).toBe(true);
    }
    expect((await getFamilyOverview(db, owner)).seatsUsed).toBe(FAMILY_SEATS);
    const fourth = await addFamilyMember(db, owner, { name: 'Person D', email: 'd@example.com', invite: true });
    expect(fourth).toEqual({ ok: false, reason: 'no_seats' });
    // A profile (a child with no phone or email) still fits.
    expect((await addFamilyMember(db, owner, { name: 'Baby' })).ok).toBe(true);
  });

  it('accepting activates the seat, burns the code, and grants Chordinator trust only if the owner opted in', async () => {
    const yes = await createUser(db, 'accepts-yes');
    const no = await createUser(db, 'accepts-no');
    const a = await addFamilyMember(db, owner, { name: 'Yes', email: 'y@example.com', chordinator: true, invite: true });
    const b = await addFamilyMember(db, owner, { name: 'No', email: 'n@example.com', invite: true });
    const codeA = (a as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    const codeB = (b as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    const accepted = await acceptFamilyInvite(db, yes, codeA);
    expect(accepted).toMatchObject({ ok: true, ownerName: 'John Doe' });
    await acceptFamilyInvite(db, no, codeB);

    // The member can now assign tasks/events to the owner — and only the one who was allowed.
    expect(await isTrusted(db, owner, yes, 'task')).toBe(true);
    expect(await isTrusted(db, owner, yes, 'event')).toBe(true);
    expect(await isTrusted(db, owner, no, 'task')).toBe(false);
    // The code is single-use.
    const third = await createUser(db, 'late-comer');
    expect(await acceptFamilyInvite(db, third, codeA)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('flipping Chordinator on a seated member takes effect now, in both directions', async () => {
    const m = await createUser(db, 'flip');
    const r = await addFamilyMember(db, owner, { name: 'Flip', phone: '+15550001111', invite: true });
    const code = (r as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    await acceptFamilyInvite(db, m, code);
    const id = (r as { member: { id: string } }).member.id;
    expect(await isTrusted(db, owner, m, 'task')).toBe(false);
    await updateFamilyMember(db, owner, id, { chordinator: true });
    expect(await isTrusted(db, owner, m, 'task')).toBe(true);
    await updateFamilyMember(db, owner, id, { chordinator: false });
    expect(await isTrusted(db, owner, m, 'task')).toBe(false);
  });

  it('tells a family code from a group code even when a group code happens to start with FAM', () => {
    expect(isFamilyInviteCode('FAMXYZ')).toBe(false); // a six-character group code
    expect(isFamilyInviteCode('FAMABCDEF2345')).toBe(false); // too short
    expect(isFamilyInviteCode('FAMABCDEFGH23456')).toBe(false); // too long
    expect(isFamilyInviteCode('FAMABCDEFGH2345')).toBe(true);
    expect(isFamilyInviteCode(' famabcdefgh2345 ')).toBe(true);
  });

  it('refuses your own invite, a second family, and a stranger code', async () => {
    const a = await addFamilyMember(db, owner, { name: 'Self', email: 's@example.com', invite: true });
    const code = (a as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    expect(await acceptFamilyInvite(db, owner, code)).toEqual({ ok: false, reason: 'own_invite' });
    expect(await acceptFamilyInvite(db, owner, 'ABC123')).toEqual({ ok: false, reason: 'invalid_code' });

    const other = await createUser(db, 'other-owner');
    const second = await addFamilyMember(db, other, { name: 'Dual', email: 'dual@example.com', invite: true });
    const code2 = (second as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    const dual = await createUser(db, 'dual');
    await acceptFamilyInvite(db, dual, code);
    expect(await acceptFamilyInvite(db, dual, code2)).toEqual({ ok: false, reason: 'already_in_family' });
  });

  it('leaving frees the seat and revokes the Chordinator grant', async () => {
    const m = await createUser(db, 'leaver');
    const r = await addFamilyMember(db, owner, { name: 'Leaver', email: 'l@example.com', chordinator: true, invite: true });
    const code = (r as { invite: { inviteLink: string } }).invite.inviteLink.split('/join/')[1]!;
    await acceptFamilyInvite(db, m, code);
    expect(await isTrusted(db, owner, m, 'task')).toBe(true);
    expect((await leaveFamily(db, m)).ok).toBe(true);
    expect(await isTrusted(db, owner, m, 'task')).toBe(false);
    expect((await getFamilyOverview(db, owner)).seatsUsed).toBe(1);
    expect(await leaveFamily(db, m)).toEqual({ ok: false, reason: 'not_found' });
  });
});
