/**
 * Phone-as-identity service (ADR 0064).
 *
 * Google stays the login/calendar anchor; this attaches a *verified* phone
 * number to the account. The number is the deterministic key contact
 * resolution (ADR 0065) matches on. Ownership is proven by SMS OTP (or the
 * WhatsApp backfill, which trusts WhatsApp's own prior verification).
 *
 * Expected failures are returned as a result union (not thrown) so the route
 * maps each to the right status without string-matching error messages.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { claimFamilyInvitesFor } from '../family-plan.service.js';
import { hashPhone, normalizeE164 } from './normalize.js';
import { getOtpProvider, type OtpProvider } from './otp.js';
import {
  linkWhatsappIdentityForPhone,
  unlinkWhatsappIdentityForPhone,
} from './whatsapp-link.js';

export interface PhoneStatus {
  /** E.164, or null if the user has no verified number. */
  phone: string | null;
  verified: boolean;
  /** Shared pepper the client folds into contact hashes (ADR 0065). Served
   *  (not baked into the app build) so it stays rotatable and out of git. */
  contactHashPepper: string;
}

export type StartVerificationResult =
  | { ok: true; phone: string }
  | { ok: false; reason: 'invalid_phone' | 'taken' | 'too_many_attempts' | 'unavailable' };

export type VerifyResult =
  | { ok: true; phone: string }
  | {
      ok: false;
      reason:
        | 'invalid_phone'
        | 'taken'
        | 'invalid_code'
        | 'expired'
        | 'too_many_attempts'
        | 'not_found'
        | 'unavailable';
    };

export async function getPhoneStatus(db: Kysely<DB>, userId: string): Promise<PhoneStatus> {
  const row = await db
    .selectFrom('users')
    .select(['phone_number', 'phone_verified'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return {
    phone: row?.phone_number ?? null,
    verified: Number(row?.phone_verified ?? 0) === 1,
    contactHashPepper: env.CONTACT_HASH_PEPPER,
  };
}

/**
 * The *other* user holding this E.164 number, if any. A number already owned
 * by the caller is not a conflict (re-verification is fine).
 */
async function otherOwnerOf(
  db: Kysely<DB>,
  phone: string,
  userId: string,
): Promise<string | null> {
  const owner = await db
    .selectFrom('users')
    .select('id')
    .where('phone_number', '=', phone)
    .where('id', '!=', userId)
    .executeTakeFirst();
  return owner?.id ?? null;
}

/*
 * Note on transfer + the WhatsApp claim below: both used to be gated on the
 * provider not being the mock, because a fixed code would have turned them
 * into identity theft. That gate is gone with the mock itself — no provider
 * can issue a guessable code any more, and an unconfigured deploy can't
 * verify at all. The protection is structural now rather than a runtime check.
 */

/** Begin verification: normalize, guard uniqueness, ask the provider to send a code. */
export async function startPhoneVerification(
  db: Kysely<DB>,
  userId: string,
  rawPhone: string,
  provider: OtpProvider | null = getOtpProvider(),
): Promise<StartVerificationResult> {
  if (!provider) return { ok: false, reason: 'unavailable' };
  const phone = normalizeE164(rawPhone);
  if (!phone) return { ok: false, reason: 'invalid_phone' };
  const started = await provider.start(db, phone);
  if (!started.ok) return { ok: false, reason: started.reason };
  return { ok: true, phone };
}

/**
 * Complete verification: check the code, then — only on success — write the
 * verified number + its hash onto the user row. The uniqueness guard runs again
 * here (a race could have let two users verify the same number), and the DB's
 * partial-unique index is the backstop.
 */
export async function verifyPhone(
  db: Kysely<DB>,
  userId: string,
  rawPhone: string,
  code: string,
  provider: OtpProvider | null = getOtpProvider(),
): Promise<VerifyResult> {
  if (!provider) return { ok: false, reason: 'unavailable' };
  const phone = normalizeE164(rawPhone);
  if (!phone) return { ok: false, reason: 'invalid_phone' };

  const priorOwner = await otherOwnerOf(db, phone, userId);

  const checked = await provider.check(db, phone, code);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  try {
    // One transaction: the prior owner must lose the number in the same
    // step the new one gains it, or the partial-unique index rejects the
    // write and we'd have stripped someone for nothing.
    await db.transaction().execute(async (tx) => {
      if (priorOwner) {
        await tx
          .updateTable('users')
          .set({ phone_number: null, phone_hash: null, phone_verified: 0 })
          .where('id', '=', priorOwner)
          .execute();
        // Their WhatsApp goes with it — see `unlinkWhatsappIdentityForPhone`.
        // Also clears the way for the new owner's claim below, which refuses
        // to take an identity a real account still holds.
        await unlinkWhatsappIdentityForPhone(tx, priorOwner, phone);
      }
      await tx
        .updateTable('users')
        .set({
          phone_number: phone,
          phone_hash: hashPhone(phone),
          phone_verified: 1,
        })
        .where('id', '=', userId)
        .execute();
    });
  } catch (err) {
    // Partial-unique-index backstop for a verification race.
    logger.warn('phone: verified-number write conflicted', { err, userId });
    return { ok: false, reason: 'taken' };
  }

  if (priorOwner) {
    // Security-relevant: an account silently lost a verified identity
    // attribute (and with it contact discovery — ADR 0065).
    logger.warn('phone: number transferred to a new owner on fresh proof', {
      from: priorOwner,
      to: userId,
    });
  }
  // The same number is what WhatsApp verifies, so claim its identity now
  // rather than making the user burn a taster and tap a referrer link
  // (ADR 0053). Best-effort — a failure here must not undo a verification
  // the user completed.
  await linkWhatsappIdentityForPhone(db, userId, phone).catch((err) => {
    logger.warn('phone: whatsapp auto-link failed', { userId, err });
  });
  // ADR 0237 — a family invite sent to this number covers them now that it is proven.
  await claimFamilyInvitesFor(db, userId).catch((err) => {
    logger.warn('phone: family invite claim failed', { userId, err });
  });

  logger.info('phone: number verified', { userId });
  return { ok: true, phone };
}

/**
 * Detach the caller's verified number.
 *
 * The only self-service correction there is: without it a mistyped number —
 * or one a carrier recycled onto this account — stays pinned until the whole
 * account is deleted, and its real owner can never claim it. Idempotent;
 * releasing when nothing is attached is a no-op.
 *
 * The WhatsApp identity + DM binding go too. An account that has disclaimed a
 * number must not keep receiving that number's chats.
 */
export async function releasePhone(
  db: Kysely<DB>,
  userId: string,
): Promise<{ released: string | null }> {
  const row = await db
    .selectFrom('users')
    .select('phone_number')
    .where('id', '=', userId)
    .executeTakeFirst();
  const phone = row?.phone_number ?? null;
  if (!phone) return { released: null };

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('users')
      .set({ phone_number: null, phone_hash: null, phone_verified: 0 })
      .where('id', '=', userId)
      .execute();
    await unlinkWhatsappIdentityForPhone(tx, userId, phone);
  });

  logger.info('phone: number released', { userId });
  return { released: phone };
}
