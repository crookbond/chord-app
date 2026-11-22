/**
 * ADR 0064 — phone verification flow (mock OTP provider) + WhatsApp backfill.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import {
  getPhoneStatus,
  releasePhone,
  startPhoneVerification,
  verifyPhone,
} from '@/services/phone/phone.service.js';
import {
  adoptPhoneFromWhatsapp,
  backfillWhatsappPhones,
} from '@/services/phone/backfill.js';
import {
  consumeSignupIntent,
  mintSignupIntent,
} from '@/services/connectors/signup-intents.service.js';
import { hashPhone } from '@/services/phone/normalize.js';
import { linkWhatsappIdentityForPhone } from '@/services/phone/whatsapp-link.js';
import type { OtpProvider } from '@/services/phone/otp.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  closeTestDb,
  createUser,
  insertMessage,
  openTestDb,
} from '@/__test-helpers__/db.js';

const CODE = '424242';

/**
 * Stands in for Twilio Verify. The fixed-code mock provider was removed
 * (ADR 0064 addendum), so tests inject their own through the `provider`
 * parameter rather than relying on a shipped one.
 */
const otp: OtpProvider = {
  name: 'twilio',
  start: async () => ({ ok: true }),
  check: async (_db, _phone, code) =>
    code === CODE ? { ok: true } : { ok: false, reason: 'invalid_code' },
};

async function addWhatsappIdentity(
  db: Kysely<DB>,
  userId: string,
  externalId: string,
): Promise<void> {
  await db
    .insertInto('external_identities')
    .values({
      platform: 'whatsapp',
      external_id: externalId,
      external_display: null,
      user_id: userId,
      created_at: new Date().toISOString(),
    })
    .execute();
}

describe('phone verification', () => {
  let db: Kysely<DB>;
  let uid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('start → verify sets the number, hash, and verified flag', async () => {
    const start = await startPhoneVerification(db, uid, '+1 (555) 111-2222', otp);
    expect(start).toEqual({ ok: true, phone: '+15551112222' });

    expect(await getPhoneStatus(db, uid)).toEqual({
      phone: null,
      verified: false,
      contactHashPepper: env.CONTACT_HASH_PEPPER,
    });

    const v = await verifyPhone(db, uid, '+15551112222', CODE, otp);
    expect(v).toEqual({ ok: true, phone: '+15551112222' });

    expect(await getPhoneStatus(db, uid)).toEqual({
      phone: '+15551112222',
      verified: true,
      contactHashPepper: env.CONTACT_HASH_PEPPER,
    });
    const row = await db
      .selectFrom('users')
      .select(['phone_hash', 'phone_verified'])
      .where('id', '=', uid)
      .executeTakeFirst();
    expect(row?.phone_hash).toBe(hashPhone('+15551112222'));
    expect(row?.phone_verified).toBe(1);
  });

  it('rejects an invalid phone before ever sending a code', async () => {
    expect(await startPhoneVerification(db, uid, '555-1234', otp)).toEqual({
      ok: false,
      reason: 'invalid_phone',
    });
  });

  it('a wrong code does not verify', async () => {
    await startPhoneVerification(db, uid, '+15551113333', otp);
    const v = await verifyPhone(db, uid, '+15551113333', '999999', otp);
    expect(v).toEqual({ ok: false, reason: 'invalid_code' });
    expect((await getPhoneStatus(db, uid)).verified).toBe(false);
  });

  it('surfaces an expired verification from the provider', async () => {
    const expired: OtpProvider = {
      name: 'twilio',
      start: async () => ({ ok: true }),
      check: async () => ({ ok: false, reason: 'expired' }),
    };
    await startPhoneVerification(db, uid, '+15551114444', expired);
    expect(await verifyPhone(db, uid, '+15551114444', CODE, expired)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect((await getPhoneStatus(db, uid)).verified).toBe(false);
  });

  it('surfaces a burned verification from the provider', async () => {
    const burned: OtpProvider = {
      name: 'twilio',
      start: async () => ({ ok: true }),
      check: async () => ({ ok: false, reason: 'not_found' }),
    };
    expect(await verifyPhone(db, uid, '+15551115555', CODE, burned)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('reports unavailable — never a weaker check — when Twilio is unconfigured', async () => {
    // The removed mock provider used to fill this gap silently, so a
    // half-configured deploy looked like it was verifying numbers.
    expect(await startPhoneVerification(db, uid, '+15551117000', null)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await verifyPhone(db, uid, '+15551117000', CODE, null)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect((await getPhoneStatus(db, uid)).verified).toBe(false);
  });

  it('start surfaces the provider rate limit as too_many_attempts', async () => {
    const limited = {
      name: 'twilio' as const,
      start: async () => ({ ok: false as const, reason: 'too_many_attempts' as const }),
      check: async () => ({ ok: true as const }),
    };
    expect(await startPhoneVerification(db, uid, '+15551119999', limited)).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
  });

  it('start does not refuse a held number — transfer is decided at verify', async () => {
    const bob = await createUser(db, 'bob');
    await startPhoneVerification(db, bob, '+15551116666', otp);
    expect((await verifyPhone(db, bob, '+15551116666', CODE, otp)).ok).toBe(true);

    // Alice can still request a code: proving control of the line is exactly
    // how a recycled number is reclaimed, so the guard belongs at verify.
    expect(await startPhoneVerification(db, uid, '+15551116666', otp)).toEqual({
      ok: true,
      phone: '+15551116666',
    });
  });

  it('lets the same user re-verify their own number', async () => {
    await startPhoneVerification(db, uid, '+15551117777', otp);
    await verifyPhone(db, uid, '+15551117777', CODE, otp);
    const again = await startPhoneVerification(db, uid, '+15551117777', otp);
    expect(again).toEqual({ ok: true, phone: '+15551117777' });
  });
});

describe('WhatsApp phone backfill', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('marks WhatsApp-linked numbers verified and is idempotent', async () => {
    const u = await createUser(db, 'wa-user');
    await addWhatsappIdentity(db, u, 'whatsapp:+15558880000');

    const first = await backfillWhatsappPhones(db);
    expect(first.scanned).toBe(1);
    expect(first.updated).toBe(1);

    const row = await db
      .selectFrom('users')
      .select(['phone_number', 'phone_hash', 'phone_verified'])
      .where('id', '=', u)
      .executeTakeFirst();
    expect(row?.phone_number).toBe('+15558880000');
    expect(row?.phone_hash).toBe(hashPhone('+15558880000'));
    expect(row?.phone_verified).toBe(1);

    // Re-run is a no-op (already has a number).
    const second = await backfillWhatsappPhones(db);
    expect(second.updated).toBe(0);
    expect(second.skippedHasPhone).toBe(1);
  });

  it('skips a number already owned by a different user', async () => {
    const owner = await createUser(db, 'owner');
    // Set the number directly: going through verifyPhone would also claim the
    // matching WhatsApp identity, which is what this test seeds by hand below.
    await db
      .updateTable('users')
      .set({
        phone_number: '+15559990000',
        phone_hash: hashPhone('+15559990000'),
        phone_verified: 1,
      })
      .where('id', '=', owner)
      .execute();

    const other = await createUser(db, 'wa-dupe');
    await addWhatsappIdentity(db, other, 'whatsapp:+15559990000');

    const result = await backfillWhatsappPhones(db);
    expect(result.skippedTaken).toBe(1);
    expect(result.updated).toBe(0);
    expect((await getPhoneStatus(db, other)).phone).toBeNull();
  });
});

describe('verified number claims its WhatsApp identity', () => {
  let db: Kysely<DB>;
  let uid: string;

  // A stand-in for Twilio Verify: same contract, but `name` marks it as a
  // provider whose proof we actually trust.
  const realProvider: OtpProvider = {
    name: 'twilio',
    start: async () => ({ ok: true }),
    check: async (_db, _phone, code) =>
      code === CODE ? { ok: true } : { ok: false, reason: 'invalid_code' },
  };

  async function whatsappIdentity(db: Kysely<DB>, externalId: string) {
    return db
      .selectFrom('external_identities')
      .select(['user_id', 'external_id'])
      .where('platform', '=', 'whatsapp')
      .where('external_id', '=', externalId)
      .executeTakeFirst();
  }

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('creates the identity when no WhatsApp account has used the number', async () => {
    await startPhoneVerification(db, uid, '+15552220001', realProvider);
    expect(await verifyPhone(db, uid, '+15552220001', CODE, realProvider)).toEqual({
      ok: true,
      phone: '+15552220001',
    });

    const row = await whatsappIdentity(db, 'whatsapp:+15552220001');
    expect(row?.user_id).toBe(uid);
  });

  it('folds a taster shadow — and its messages — into the verifying user', async () => {
    // A stranger who messaged WhatsApp first: shadow user, own personal
    // group, a few taster turns recorded against them.
    const shadow = await createUser(db, 'wa-shadow');
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', shadow).execute();
    const personal = await ensurePersonalGroup(db, shadow);
    await db
      .insertInto('external_identities')
      .values({
        platform: 'whatsapp',
        external_id: 'whatsapp:+15552220003',
        external_display: 'Alice',
        user_id: shadow,
        created_at: new Date().toISOString(),
      })
      .execute();
    const msg = await insertMessage(db, {
      groupId: personal.id,
      senderId: shadow,
      body: 'what is on my calendar tomorrow?',
    });

    await startPhoneVerification(db, uid, '+15552220003', realProvider);
    expect((await verifyPhone(db, uid, '+15552220003', CODE, realProvider)).ok).toBe(true);

    // Identity re-pointed, shadow gone, its message re-attributed.
    expect((await whatsappIdentity(db, 'whatsapp:+15552220003'))?.user_id).toBe(uid);
    const gone = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', shadow)
      .executeTakeFirst();
    expect(gone).toBeUndefined();
    const moved = await db
      .selectFrom('messages')
      .select('sender_id')
      .where('id', '=', msg.id)
      .executeTakeFirst();
    expect(moved?.sender_id).toBe(uid);
  });

  it('never takes an identity owned by another real account', async () => {
    const bob = await createUser(db, 'bob');
    await db
      .insertInto('external_identities')
      .values({
        platform: 'whatsapp',
        external_id: 'whatsapp:+15552220004',
        external_display: null,
        user_id: bob,
        created_at: new Date().toISOString(),
      })
      .execute();

    // Bob never verified the number in-app, so the uniqueness guard doesn't
    // fire — only the non-shadow check stands between Alice and Bob's chat.
    await startPhoneVerification(db, uid, '+15552220004', realProvider);
    expect((await verifyPhone(db, uid, '+15552220004', CODE, realProvider)).ok).toBe(true);

    expect((await whatsappIdentity(db, 'whatsapp:+15552220004'))?.user_id).toBe(bob);
  });

  it('is idempotent when the user already owns the identity', async () => {
    await startPhoneVerification(db, uid, '+15552220005', realProvider);
    await verifyPhone(db, uid, '+15552220005', CODE, realProvider);
    expect(await linkWhatsappIdentityForPhone(db, uid, '+15552220005')).toBe('already_linked');

    const rows = await db
      .selectFrom('external_identities')
      .select('user_id')
      .where('external_id', '=', 'whatsapp:+15552220005')
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('releasing and transferring a number', () => {
  let db: Kysely<DB>;
  let alice: string;
  let bob: string;

  const realProvider: OtpProvider = {
    name: 'twilio',
    start: async () => ({ ok: true }),
    check: async (_db, _phone, code) =>
      code === CODE ? { ok: true } : { ok: false, reason: 'invalid_code' },
  };

  async function waIdentityOwner(externalId: string): Promise<string | undefined> {
    const row = await db
      .selectFrom('external_identities')
      .select('user_id')
      .where('platform', '=', 'whatsapp')
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return row?.user_id;
  }

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
    bob = await createUser(db, 'bob');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('release frees the number for someone else to verify', async () => {
    await startPhoneVerification(db, alice, '+15553330001', otp);
    await verifyPhone(db, alice, '+15553330001', CODE, otp);

    expect(await releasePhone(db, alice)).toEqual({ released: '+15553330001' });
    expect(await getPhoneStatus(db, alice)).toEqual({
      phone: null,
      verified: false,
      contactHashPepper: env.CONTACT_HASH_PEPPER,
    });

    expect(await startPhoneVerification(db, bob, '+15553330001', otp)).toEqual({
      ok: true,
      phone: '+15553330001',
    });
    expect((await verifyPhone(db, bob, '+15553330001', CODE, otp)).ok).toBe(true);
  });

  it('release takes the WhatsApp identity and DM binding with it', async () => {
    await startPhoneVerification(db, alice, '+15553330002', realProvider);
    await verifyPhone(db, alice, '+15553330002', CODE, realProvider);
    expect(await waIdentityOwner('whatsapp:+15553330002')).toBe(alice);

    const personal = await ensurePersonalGroup(db, alice);
    await db
      .insertInto('group_external_channels')
      .values({
        platform: 'whatsapp',
        external_channel_id: 'whatsapp:+15553330002',
        group_id: personal.id,
        alias: 'whatsapp',
        created_at: new Date().toISOString(),
      })
      .execute();

    await releasePhone(db, alice);

    expect(await waIdentityOwner('whatsapp:+15553330002')).toBeUndefined();
    const binding = await db
      .selectFrom('group_external_channels')
      .select('group_id')
      .where('external_channel_id', '=', 'whatsapp:+15553330002')
      .executeTakeFirst();
    expect(binding).toBeUndefined();
  });

  it('release is a no-op when no number is attached', async () => {
    expect(await releasePhone(db, alice)).toEqual({ released: null });
  });

  it('a real provider transfers a held number to whoever proves the line', async () => {
    await startPhoneVerification(db, alice, '+15553330003', realProvider);
    await verifyPhone(db, alice, '+15553330003', CODE, realProvider);

    // Bob now holds the line — carrier recycled it, or Alice mistyped it.
    expect(await startPhoneVerification(db, bob, '+15553330003', realProvider)).toEqual({
      ok: true,
      phone: '+15553330003',
    });
    expect(await verifyPhone(db, bob, '+15553330003', CODE, realProvider)).toEqual({
      ok: true,
      phone: '+15553330003',
    });

    expect((await getPhoneStatus(db, bob)).phone).toBe('+15553330003');
    // Alice is stripped, not left as a duplicate holder.
    expect(await getPhoneStatus(db, alice)).toEqual({
      phone: null,
      verified: false,
      contactHashPepper: env.CONTACT_HASH_PEPPER,
    });
  });

  it('transfer moves the WhatsApp identity to the new owner', async () => {
    await startPhoneVerification(db, alice, '+15553330004', realProvider);
    await verifyPhone(db, alice, '+15553330004', CODE, realProvider);
    expect(await waIdentityOwner('whatsapp:+15553330004')).toBe(alice);

    await startPhoneVerification(db, bob, '+15553330004', realProvider);
    await verifyPhone(db, bob, '+15553330004', CODE, realProvider);

    expect(await waIdentityOwner('whatsapp:+15553330004')).toBe(bob);
  });

  it('a wrong code transfers nothing', async () => {
    await startPhoneVerification(db, alice, '+15553330005', realProvider);
    await verifyPhone(db, alice, '+15553330005', CODE, realProvider);

    expect(await verifyPhone(db, bob, '+15553330005', '999999', realProvider)).toEqual({
      ok: false,
      reason: 'invalid_code',
    });
    expect((await getPhoneStatus(db, alice)).phone).toBe('+15553330005');
    expect((await getPhoneStatus(db, bob)).phone).toBeNull();
    expect(await waIdentityOwner('whatsapp:+15553330005')).toBe(alice);
  });
});

describe('signing up through WhatsApp verifies the number', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a referrer link-up adopts the number — no SMS code needed', async () => {
    // The stranger messaged WhatsApp first, so a taster shadow holds the
    // identity; they then tap the signup link and sign in with Google.
    const shadow = await createUser(db, 'wa-shadow');
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', shadow).execute();
    await ensurePersonalGroup(db, shadow);
    await db
      .insertInto('external_identities')
      .values({
        platform: 'whatsapp',
        external_id: 'whatsapp:+15554440001',
        external_display: 'Alice',
        user_id: shadow,
        created_at: new Date().toISOString(),
      })
      .execute();

    const real = await createUser(db, 'alice');
    const token = await mintSignupIntent(db, 'whatsapp', 'whatsapp:+15554440001');
    const res = await consumeSignupIntent(db, {
      token,
      ownerUserId: real,
      ownerEmail: 'alice@example.test',
      ownerDisplay: 'Alice',
    });
    expect(res.ok).toBe(true);

    expect(await getPhoneStatus(db, real)).toEqual({
      phone: '+15554440001',
      verified: true,
      contactHashPepper: env.CONTACT_HASH_PEPPER,
    });
    const row = await db
      .selectFrom('users')
      .select('phone_hash')
      .where('id', '=', real)
      .executeTakeFirst();
    expect(row?.phone_hash).toBe(hashPhone('+15554440001'));
  });

  it('never overwrites a number the user already verified', async () => {
    const real = await createUser(db, 'has-phone');
    await startPhoneVerification(db, real, '+15554440002', otp);
    await verifyPhone(db, real, '+15554440002', CODE, otp);

    expect(await adoptPhoneFromWhatsapp(db, real, 'whatsapp:+15554449999')).toBe(
      'skipped_has_phone',
    );
    expect((await getPhoneStatus(db, real)).phone).toBe('+15554440002');
  });

  it('never takes a number another account holds — transfer needs fresh proof', async () => {
    // The WhatsApp identity may be months old, so it does not get to strip
    // someone; the deliberate /me/phone/verify path is where that happens.
    const owner = await createUser(db, 'owner');
    await startPhoneVerification(db, owner, '+15554440003', otp);
    await verifyPhone(db, owner, '+15554440003', CODE, otp);

    const other = await createUser(db, 'other');
    expect(await adoptPhoneFromWhatsapp(db, other, 'whatsapp:+15554440003')).toBe(
      'skipped_taken',
    );
    expect((await getPhoneStatus(db, other)).phone).toBeNull();
    expect((await getPhoneStatus(db, owner)).phone).toBe('+15554440003');
  });

  it('refuses to give a shadow a verified number', async () => {
    // A shadow isn't an account yet — a verified number would make it
    // resolvable in contact discovery as though it were a real person.
    const shadow = await createUser(db, 'still-shadow');
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', shadow).execute();
    expect(await adoptPhoneFromWhatsapp(db, shadow, 'whatsapp:+15554440004')).toBe(
      'skipped_no_number',
    );
    expect((await getPhoneStatus(db, shadow)).phone).toBeNull();
  });
});
