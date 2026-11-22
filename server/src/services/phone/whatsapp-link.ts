/**
 * Claim the WhatsApp identity behind a freshly verified phone number — the
 * reverse direction of `backfillWhatsappPhones` (ADR 0064).
 *
 * WhatsApp proves ownership of a number by messaging that same line, so an
 * SMS-OTP verification is the same evidence arriving the other way round.
 * Without this, someone who verified their number in the app still has to
 * spend their taster allowance and tap a referrer link before WhatsApp knows
 * who they are (ADR 0053); with it, `maybeAutoBindForPairedSender` binds
 * their DM to their personal group on the very first message.
 *
 * Deliberately NOT reached from the mock OTP provider: its fixed code proves
 * nothing, so auto-claiming there would let any signed-in user absorb the
 * shadow account — and the personal-group history behind it — for any number
 * no real user has claimed yet. `verifyPhone` enforces that gate.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { mergeOrLinkExternalIdentity } from '../connectors/pairing.service.js';

export type WhatsappLinkOutcome =
  /** No identity existed — created one pointing at this user. */
  | 'linked'
  /** A taster shadow held the number — folded into this user. */
  | 'merged'
  /** This user already owns it; nothing to do. */
  | 'already_linked'
  /** A different *real* account owns it — left untouched. */
  | 'conflict';

/** WhatsApp stores the channel id as `whatsapp:+E164` (ADR 0090). */
export function whatsappExternalId(phone: string): string {
  return `whatsapp:${phone}`;
}

export async function linkWhatsappIdentityForPhone(
  db: Kysely<DB>,
  userId: string,
  phone: string,
  displayName: string | null = null,
): Promise<WhatsappLinkOutcome> {
  const externalId = whatsappExternalId(phone);

  const existing = await db
    .selectFrom('external_identities')
    .innerJoin('users', 'users.id', 'external_identities.user_id')
    .select(['external_identities.user_id as userId', 'users.shadow as shadow'])
    .where('external_identities.platform', '=', 'whatsapp')
    .where('external_identities.external_id', '=', externalId)
    .executeTakeFirst();

  if (existing?.userId === userId) return 'already_linked';
  if (existing && existing.shadow !== 1) {
    // `mergeOrLinkExternalIdentity` would refuse this too, but returning
    // early keeps the outcome honest instead of reporting a merge that
    // silently didn't happen.
    logger.warn('phone: whatsapp identity belongs to another account', {
      userId,
      owner: existing.userId,
    });
    return 'conflict';
  }

  // One transaction: the merge re-points memberships, message attribution,
  // and every user FK before deleting the shadow. A partial apply would
  // orphan those rows or trip the FK on the delete.
  await db.transaction().execute((tx) =>
    mergeOrLinkExternalIdentity(tx, {
      platform: 'whatsapp',
      externalUserId: externalId,
      externalUserDisplay: displayName,
      ownerUserId: userId,
      now: new Date().toISOString(),
    }),
  );

  const outcome: WhatsappLinkOutcome = existing ? 'merged' : 'linked';
  logger.info('phone: verified number claimed its whatsapp identity', {
    userId,
    outcome,
  });
  return outcome;
}

/**
 * Undo `linkWhatsappIdentityForPhone` for a number this user is giving up —
 * on release, or when the number transfers to whoever can prove current
 * control of the line.
 *
 * Drops the DM binding as well as the identity. The inbound pipeline resolves
 * the channel BEFORE the sender, so an orphaned `group_external_channels` row
 * would keep routing that number's WhatsApp into a group whose owner no
 * longer claims it — and mint a fresh shadow for every message on the way in.
 *
 * Scoped to `user_id`: a number owned by someone else is never touched.
 */
export async function unlinkWhatsappIdentityForPhone(
  db: Kysely<DB>,
  userId: string,
  phone: string,
): Promise<boolean> {
  const externalId = whatsappExternalId(phone);
  const deleted = await db
    .deleteFrom('external_identities')
    .where('platform', '=', 'whatsapp')
    .where('external_id', '=', externalId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (Number(deleted.numDeletedRows ?? 0) === 0) return false;

  await db
    .deleteFrom('group_external_channels')
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', externalId)
    .execute();

  logger.info('phone: released whatsapp identity with the number', {
    userId,
  });
  return true;
}
