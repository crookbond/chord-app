/**
 * ADR 0328 — a family member answers the invitation to a group event from
 * inside Chord (the event sheet, or `answer_invitation` in chat).
 *
 * The answer travels the way any invitation is answered (ADR 0104): on the
 * member's own calendar when it holds the invitation, else as an iTIP reply
 * mailed to the organizer, from the address they were invited at. Only once
 * that worked is it recorded on the organizer's copy, so "who is coming"
 * never shows an answer the organizer's calendar did not get. A "no" takes
 * the event off the member's calendar in Chord, as a decline in Google does.
 */
import type { Kysely } from 'kysely';

import type { GuestResponse } from '@chord/kernel';
import type { DB } from '../../db/schema.js';
import { resolveSendMailbox } from '../email/default-mailbox.js';
import { respondToInvite, type RsvpResponse } from '../google/rsvp.service.js';
import { setGuestAnswer } from './guest-answers.js';

export type AnswerInviteResult =
  | { ok: true; response: GuestResponse; via: 'calendar' | 'email'; removed: boolean }
  | { ok: false; reason: 'not_found' | 'not_invited' | 'no_route' | 'send_failed' };

export async function answerFamilyInvite(
  db: Kysely<DB>,
  args: { eventId: string; userId: string; response: RsvpResponse },
): Promise<AnswerInviteResult> {
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('id', '=', args.eventId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row || row.owner_user_id !== args.userId) return { ok: false, reason: 'not_found' };
  if (!row.invite_email || !row.organizer_user_id || !row.ical_uid) return { ok: false, reason: 'not_invited' };

  const org = await db
    .selectFrom('events')
    .select(['id', 'sequence', 'title', 'ical_uid'])
    .where('ical_uid', '=', row.ical_uid)
    .where('owner_user_id', '=', row.organizer_user_id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!org) return { ok: false, reason: 'not_found' };

  // Where the organizer reads replies: the mailbox a mailed invitation went
  // out from, else their sign-in address.
  const organizer = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', row.organizer_user_id)
    .executeTakeFirst();
  const organizerEmail =
    row.invite_via === 'mail'
      ? ((await resolveSendMailbox(db, row.organizer_user_id))?.address ?? organizer?.email ?? null)
      : (organizer?.email ?? null);

  // Answer as the address they were invited at.
  const me = await db.selectFrom('users').select('email').where('id', '=', args.userId).executeTakeFirst();
  const invitedAt = row.invite_email.toLowerCase();
  const accountId =
    me?.email?.toLowerCase() === invitedAt
      ? null
      : ((
          await db
            .selectFrom('email_accounts')
            .select('id')
            .where('user_id', '=', args.userId)
            .where('email_address', '=', invitedAt)
            .executeTakeFirst()
        )?.id ?? null);

  const sent = await respondToInvite(db, args.userId, {
    icalUid: row.invite_uid ?? row.ical_uid,
    response: args.response,
    organizerEmail,
    title: org.title,
    sequence: org.sequence,
    accountId,
  });
  if (!sent.ok || !sent.via) {
    return { ok: false, reason: sent.reason === 'send_failed' ? 'send_failed' : 'no_route' };
  }

  await setGuestAnswer(db, {
    organizerId: row.organizer_user_id,
    icalUid: org.ical_uid!,
    email: invitedAt,
    response: args.response,
  });

  let removed = false;
  if (args.response === 'declined') {
    const { deleteEvent } = await import('../events.service.js');
    await deleteEvent(db, row.id);
    removed = true;
  }
  return { ok: true, response: args.response, via: sent.via, removed };
}
