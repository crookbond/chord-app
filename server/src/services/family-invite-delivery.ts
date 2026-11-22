/**
 * ADR 0237 — telling someone about a family invite, in the ways Chord can.
 *
 * Two channels, both best-effort (a failed notification never undoes a seat):
 *
 *   - EMAIL, sent from the OWNER's own mailbox through the same draft + outbox
 *     path as any message they compose (ADR 0113/0115/0214), so it arrives from
 *     them, appears in their Sent, and has the undo window. If they have no
 *     mailbox Chord may send from, the answer is `no_mailbox` and the caller says
 *     so rather than implying it went.
 *   - IN-APP, when the person already has an account: a message from Chord in
 *     their personal chat, which the existing push publisher turns into a push.
 *
 * A TEXT is deliberately not sent from here: Chord has no SMS sender (Twilio is
 * used only to verify numbers), and a WhatsApp message to a stranger outside the
 * 24h window needs an approved template. A text comes from the owner's own phone
 * (the share sheet / `sms:` card), which is also who the recipient expects it from.
 */
import { SSE } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.js';
import { queueComposedEmail } from './bot/email-actions.js';
import { ensurePersonalGroup } from './groups.service.js';
import { postMessage } from './messages.service.js';
import { sseHub } from './sse.hub.js';

export type InviteEmailOutcome = 'queued' | 'no_mailbox' | 'failed';

export async function emailFamilyInvite(
  db: Kysely<DB>,
  ownerId: string,
  to: string,
  content: { subject: string; body: string },
): Promise<InviteEmailOutcome> {
  try {
    const out = await queueComposedEmail(db, ownerId, { to: [to], subject: content.subject, body: content.body });
    return out.ok ? 'queued' : 'no_mailbox';
  } catch (err) {
    logger.warn('family invite email failed', { ownerId, err: (err as Error).message });
    return 'failed';
  }
}

/** A message from Chord in the new member's personal chat: they are covered, and
 *  by whom. Posted rather than pushed directly so it is also there to read later. */
export async function tellMemberTheyAreCovered(
  db: Kysely<DB>,
  userId: string,
  ownerName: string,
): Promise<void> {
  try {
    const personal = await ensurePersonalGroup(db, userId);
    const message = await postMessage(db, {
      groupId: personal.id,
      senderId: null,
      body:
        `${ownerName} added you to their family plan, so your Chord is covered and shares their token pool. ` +
        'You are also in their family chat. You can leave the plan any time in Settings.',
      mentionsBot: false,
    });
    sseHub.broadcast(personal.id, SSE.message, message);
  } catch (err) {
    logger.warn('family member notice failed', { userId, err: (err as Error).message });
  }
}
