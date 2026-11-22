/**
 * WhatsApp-linked users already proved ownership of their phone number to
 * WhatsApp, so we trust that as verification and populate
 * `users.phone_number` / `phone_hash` / `phone_verified=1` from their
 * `external_identities` row (ADR 0064).
 *
 * `adoptPhoneFromWhatsapp` is the live path — every identity link runs it via
 * `mergeOrLinkExternalIdentity`. `backfillWhatsappPhones` is the same rule
 * swept over existing rows, for identities linked before that wiring existed.
 *
 * WhatsApp identities store the Twilio `From` value — `whatsapp:+15551234567` —
 * as `external_id`, so we strip the `whatsapp:` prefix before normalizing.
 * Idempotent: a user who already has a phone number is skipped, and a number
 * already claimed by another user is skipped (never clobbers).
 *
 * Extracted from the script so it can be unit-tested against seeded rows.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { logger } from '../../config/logging.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { hashPhone, normalizeE164 } from './normalize.js';

export interface BackfillResult {
  scanned: number;
  updated: number;
  skippedNoNumber: number;
  skippedHasPhone: number;
  skippedTaken: number;
}

export type AdoptPhoneOutcome =
  /** Number written to the user row and marked verified. */
  | 'set'
  /** User already has a number — never overwritten. */
  | 'skipped_has_phone'
  /** `external_id` didn't yield a usable E.164. */
  | 'skipped_no_number'
  /** Another account already holds this number — see the note below. */
  | 'skipped_taken';

/**
 * Adopt the number behind a `whatsapp:+E164` identity as a verified phone.
 *
 * Registering a WhatsApp account requires an OTP to that same line, so this is
 * the same proof Twilio Verify gives us, arriving by a different route — which
 * is why signing up through WhatsApp should not then ask for an SMS code.
 *
 * It deliberately does NOT take a number from another account, where the
 * explicit `/me/phone/verify` flow does. The evidence is equally strong but not
 * equally *fresh*: an OTP proves control a minute ago, while this identity row
 * may date from a taster months back (the referrer token alone lives 14 days).
 * Freshness only matters for the one operation that takes something away from
 * someone else, so transfer stays with the deliberate, real-time path.
 */
export async function adoptPhoneFromWhatsapp(
  db: Kysely<DB>,
  userId: string,
  whatsappExternalId: string,
): Promise<AdoptPhoneOutcome> {
  const current = await db
    .selectFrom('users')
    .select(['phone_number', 'shadow'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!current) return 'skipped_no_number';
  // A shadow isn't an account yet; giving it a verified number would make it
  // resolvable in contact discovery (ADR 0065) as if it were a real person.
  if (current.shadow === 1) return 'skipped_no_number';
  if (current.phone_number) return 'skipped_has_phone';

  const phone = normalizeE164(whatsappExternalId.replace(/^whatsapp:/i, ''));
  if (!phone) return 'skipped_no_number';

  const taken = await db
    .selectFrom('users')
    .select('id')
    .where('phone_number', '=', phone)
    .where('id', '!=', userId)
    .executeTakeFirst();
  if (taken) return 'skipped_taken';

  await db
    .updateTable('users')
    .set({ phone_number: phone, phone_hash: hashPhone(phone), phone_verified: 1 })
    .where('id', '=', userId)
    .execute();
  logger.info('phone: adopted verified number from whatsapp identity', { userId });
  return 'set';
}

export async function backfillWhatsappPhones(db: Kysely<DB>): Promise<BackfillResult> {
  const rows = await db
    .selectFrom('external_identities')
    .innerJoin('users', 'users.id', 'external_identities.user_id')
    .select([
      'external_identities.external_id as externalId',
      'external_identities.user_id as userId',
      'users.phone_number as phoneNumber',
    ])
    .where('external_identities.platform', '=', 'whatsapp')
    .execute();

  const result: BackfillResult = {
    scanned: rows.length,
    updated: 0,
    skippedNoNumber: 0,
    skippedHasPhone: 0,
    skippedTaken: 0,
  };

  // `external_identities` is keyed (platform, external_id), so every row
  // here carries a distinct WhatsApp number and a distinct userId — no two
  // rows can race for the same `phone_number`, so this is safe to run
  // concurrently rather than one round trip at a time.
  const outcomes = await mapConcurrent(rows, 5, (row) =>
    adoptPhoneFromWhatsapp(db, row.userId, row.externalId),
  );
  for (const outcome of outcomes) {
    if (outcome === 'set') result.updated++;
    else if (outcome === 'skipped_has_phone') result.skippedHasPhone++;
    else if (outcome === 'skipped_taken') result.skippedTaken++;
    else result.skippedNoNumber++;
  }

  logger.info('whatsapp phone backfill complete', { ...result });
  return result;
}
