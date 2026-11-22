/**
 * ADR 0237 — an invite to someone who is already on Chord seats them at once,
 * and one sent before they had an account seats them when they prove the
 * address or number. The case this is built from is the real one: the owner
 * typed a Yahoo address for his wife, whose Chord account signs in with Gmail -
 * the ONLY thing tying the invite to her account was the phone number she had
 * verified. The old flow needed her to find and tap an emailed link that was
 * never sent.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { familyGroupIdFor } from '@/services/family-group.service.js';
import {
  addFamilyMember,
  claimFamilyInvitesFor,
  getFamilyOverview,
  inviteFamilyMember,
} from '@/services/family-plan.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;

describe('a family invite seats someone who is already on Chord', () => {
  let db: Kysely<DB>;
  let owner: string;
  let alice: string;
  let priorProvider: string;

  const setUser = (id: string, v: Record<string, unknown>) =>
    db.updateTable('users').set(v as never).where('id', '=', id).execute();

  const invite = (args: Record<string, unknown>) =>
    addFamilyMember(db, owner, { name: 'Alice Stone', invite: true, ...args } as never);

  const member = () =>
    db
      .selectFrom('family_members')
      .select(['status', 'user_id', 'invite_code'])
      .where('owner_user_id', '=', owner)
      .executeTakeFirstOrThrow();

  const queued = () =>
    db
      .selectFrom('email_drafts')
      .select(['to_emails', 'subject', 'body', 'send_after'])
      .where('user_id', '=', owner)
      .execute();

  beforeEach(async () => {
    priorProvider = env.GMAIL_PROVIDER;
    db = await openTestDb();
    owner = await createUser(db, 'ownertest', 'John Doe');
    await setUser(owner, {
      email: 'ownertest@gmail.com',
      first_name: 'John',
      last_name: 'Doe',
      subscription_plan: 'family',
      subscription_current_period_end: new Date(Date.now() + 20 * DAY).toISOString(),
    });
    // The real shape: she signs in with Gmail, and her VERIFIED phone is the
    // only thing the invite (typed with a Yahoo address) has in common.
    alice = await createUser(db, 'alice.dr.stone', 'Alice Stone');
    await setUser(alice, {
      email: 'spouse.test@gmail.com',
      phone_number: '+17735550223',
      phone_verified: 1,
    });
    await ensurePersonalGroup(db, alice);
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  it('matches on a verified phone even though the typed email is a different address', async () => {
    const out = await invite({ email: 'spouse.test@yahoo.com', phone: '773-555-0223' });

    expect(out.ok && out.invite?.joined).toBe(true);
    expect(await member()).toEqual({ status: 'active', user_id: alice, invite_code: null });
    // Seated for real: counted on the plan, covered, and in the family chat.
    expect((await getFamilyOverview(db, owner)).seatsUsed).toBe(2);
    expect(await getFamilyOverview(db, alice)).toMatchObject({ role: 'member', planActive: true });
    expect(await familyGroupIdFor(db, alice)).not.toBeNull();
  });

  // The owner types a number however it comes to hand; none of these should
  // leave a person who is already on Chord waiting on a link.
  it.each(['+17735550223', '+1 (773) 555-0223', '773-555-0223', '7735550223', '1-773-555-0223'])(
    'a phone-only invite (%s) seats the verified account in the same call, with no email involved',
    async (typed) => {
      const out = await invite({ name: 'Alice', phone: typed });

      expect(out.ok && out.invite?.joined).toBe(true);
      expect(out.ok && out.invite?.delivery).toEqual({ email: 'no_email' });
      expect(await member()).toEqual({ status: 'active', user_id: alice, invite_code: null });
      expect(await getFamilyOverview(db, alice)).toMatchObject({ role: 'member', planActive: true });
    },
  );

  it('a number she has NOT verified does not seat her, and a different number does not either', async () => {
    await setUser(alice, { phone_verified: 0 });
    const unverified = await invite({ name: 'Alice', phone: '773-555-0223' });
    expect(unverified.ok && unverified.invite?.joined).toBe(false);

    await setUser(alice, { phone_verified: 1 });
    await db.deleteFrom('family_members').where('owner_user_id', '=', owner).execute();
    const other = await invite({ name: 'Alice', phone: '773-555-9999' });
    expect(other.ok && other.invite?.joined).toBe(false);
  });

  it('tells her in the app, with no link to find', async () => {
    await invite({ email: 'spouse.test@yahoo.com', phone: '773-555-0223' });
    const personal = await ensurePersonalGroup(db, alice);
    const msgs = await db
      .selectFrom('messages')
      .select(['body', 'sender_id'])
      .where('group_id', '=', personal.id)
      .execute();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender_id).toBeNull();
    expect(msgs[0]!.body).toContain('John Doe added you to their family plan');
  });

  it('also emails her, from the owner mailbox, and says what happened', async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    const out = await invite({ email: 'spouse.test@yahoo.com', phone: '773-555-0223' });

    expect(out.ok && out.invite?.delivery).toEqual({ email: 'queued' });
    const [mail] = await queued();
    expect(mail!.to_emails).toEqual(['spouse.test@yahoo.com']);
    expect(mail!.subject).toBe('John Doe added you to their Chord family plan');
    expect(mail!.send_after).not.toBeNull();
  });

  it('says plainly when the owner has no mailbox Chord may send from', async () => {
    const out = await invite({ email: 'spouse.test@yahoo.com', phone: '773-555-0223' });
    expect(out.ok && out.invite?.joined).toBe(true);
    expect(out.ok && out.invite?.delivery).toEqual({ email: 'no_mailbox' });
    expect(await queued()).toHaveLength(0);
  });

  it('matches on the sign-in email, and on a mailbox she connected', async () => {
    const byLogin = await invite({ name: 'Alice', email: 'Spouse.tEst@gmail.com' });
    expect(byLogin.ok && byLogin.invite?.joined).toBe(true);

    // a second person, matched only through a mailbox she attached
    const ada = await createUser(db, 'ada', 'Ada Rao');
    const now = new Date().toISOString();
    await db
      .insertInto('email_accounts')
      .values({
        id: newId('acct'),
        user_id: ada,
        provider: 'imap',
        email_address: 'guest.six@yahoo.com',
        display_name: null,
        preset_key: 'yahoo',
        auth_ciphertext: null,
        auth_iv: null,
        auth_tag: null,
        sync_cursor: null,
        synced_at: null,
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
    const byMailbox = await invite({ name: 'Ada Rao', email: 'guest.six@yahoo.com' });
    expect(byMailbox.ok && byMailbox.invite?.joined).toBe(true);
  });

  it('keeps the link and the old behaviour when nobody matches', async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    const out = await invite({ name: 'Nani', email: 'nani@example.com', phone: '+919876543210' });
    expect(out.ok && out.invite?.joined).toBe(false);
    expect(out.ok && out.invite?.inviteLink).toContain('/join/FAM');
    expect(out.ok && out.invite?.delivery).toEqual({ email: 'queued' });
    const [mail] = await queued();
    expect(mail!.body).toContain('/join/FAM');
    expect((await member()).status).toBe('invited');
  });

  it('does not guess when the email and the phone point at two different accounts', async () => {
    const other = await createUser(db, 'someone.else', 'Someone Else');
    await setUser(other, { email: 'spouse.test@yahoo.com' });
    const out = await invite({ email: 'spouse.test@yahoo.com', phone: '773-555-0223' });
    expect(out.ok && out.invite?.joined).toBe(false);
    expect((await member()).status).toBe('invited');
  });

  it('ignores a phone number that was never verified', async () => {
    await setUser(alice, { phone_verified: 0 });
    const out = await invite({ email: 'spouse.test@yahoo.com', phone: '773-555-0223' });
    expect(out.ok && out.invite?.joined).toBe(false);
  });

  it('does not seat someone who is already on another family plan, or who pays for their own', async () => {
    const otherOwner = await createUser(db, 'priya', 'Priya Rao');
    await db
      .insertInto('family_members')
      .values({
        id: newId('fam'),
        owner_user_id: otherOwner,
        user_id: alice,
        name: 'Alice',
        email: null,
        phone: null,
        relationship: null,
        status: 'active',
        chordinator: 0,
        invite_code: null,
        person_id: null,
        created_at: new Date().toISOString(),
      } as never)
      .execute();
    const out = await invite({ phone: '773-555-0223' });
    expect(out.ok && out.invite?.joined).toBe(false);
    expect((await member()).status).toBe('invited');
  });

  describe('an invite sent before she had an account', () => {
    it('seats her when she signs in with the address it used', async () => {
      const out = await invite({ name: 'Ravi', email: 'ravi@example.com' });
      expect(out.ok && out.invite?.joined).toBe(false);

      const ravi = await createUser(db, 'ravi', 'Ravi Nair');
      expect(await claimFamilyInvitesFor(db, ravi)).toBe(0);
      await setUser(ravi, { email: 'ravi@example.com' });
      expect(await claimFamilyInvitesFor(db, ravi)).toBe(1);
      expect(await member()).toMatchObject({ status: 'active', user_id: ravi });
      expect(await claimFamilyInvitesFor(db, ravi)).toBe(0);
    });

    it('seats her when she later verifies the phone number it used', async () => {
      await invite({ name: 'Ravi', phone: '312-555-0100' });
      const ravi = await createUser(db, 'ravi', 'Ravi Nair');
      await setUser(ravi, { phone_number: '+13125550100', phone_verified: 0 });
      expect(await claimFamilyInvitesFor(db, ravi)).toBe(0);
      await setUser(ravi, { phone_verified: 1 });
      expect(await claimFamilyInvitesFor(db, ravi)).toBe(1);
      expect((await member()).status).toBe('active');
    });

    it('re-sending an invite to someone who has since signed up seats them', async () => {
      const out = await invite({ name: 'Ravi', email: 'ravi@example.com' });
      const memberId = out.ok ? out.member.id : '';
      const ravi = await createUser(db, 'ravi', 'Ravi Nair');
      await setUser(ravi, { email: 'ravi@example.com' });
      const resent = await inviteFamilyMember(db, owner, memberId);
      expect(resent.ok && resent.joined).toBe(true);
    });
  });
});
