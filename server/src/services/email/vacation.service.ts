/**
 * The vacation responder (ADR 0124).
 *
 * Ours rather than the provider's: Gmail and Graph both have one behind an
 * OAuth scope we do not hold, and IMAP has none at all, so a Chord-side
 * responder is the only shape that works the same on all three mailboxes.
 *
 * Every rule about WHO gets answered lives in the kernel, tested. This file is
 * the pass that finds the mail and sends the reply.
 */
import type { Kysely } from 'kysely';
import {
  autoReplySkipReason,
  autoReplySubject,
  vacationActive,
  type AutoReplyCandidate,
} from '@chord/kernel';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { sendAccountReply } from '../email-accounts/accounts.service.js';
import { signedBody } from './signature.js';

/**
 * A burst cap, not a budget. Someone switching the responder on mid-holiday
 * has a full inbox, and answering all of it in one tick looks like a mail
 * storm to every receiving server.
 */
const MAX_PER_TICK = 20;

export interface VacationSettings {
  enabled: boolean;
  subject: string | null;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

export async function getVacation(
  db: Kysely<DB>,
  userId: string,
): Promise<VacationSettings> {
  const row = await db
    .selectFrom('users')
    .select([
      'vacation_enabled',
      'vacation_subject',
      'vacation_body',
      'vacation_starts_at',
      'vacation_ends_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  return {
    enabled: row?.vacation_enabled === 1,
    subject: row?.vacation_subject ?? null,
    body: row?.vacation_body ?? null,
    startsAt: row?.vacation_starts_at ?? null,
    endsAt: row?.vacation_ends_at ?? null,
  };
}

/**
 * Save the settings.
 *
 * Switching the responder ON starts a fresh holiday: `vacation_since` bounds
 * what gets answered (so turning it on does not reply to a week of mail that
 * has already been read), and the record of who has been told is cleared, so
 * a second trip tells them again.
 */
export async function setVacation(
  db: Kysely<DB>,
  userId: string,
  input: VacationSettings,
): Promise<VacationSettings> {
  const before = await getVacation(db, userId);
  const now = new Date().toISOString();
  const turningOn = input.enabled && !before.enabled;

  await db
    .updateTable('users')
    .set({
      vacation_enabled: input.enabled ? 1 : 0,
      vacation_subject: input.subject?.trim() || null,
      vacation_body: input.body?.trim() || null,
      vacation_starts_at: input.startsAt || null,
      vacation_ends_at: input.endsAt || null,
      ...(turningOn ? { vacation_since: input.startsAt || now } : {}),
    })
    .where('id', '=', userId)
    .execute();

  if (turningOn) {
    await db.deleteFrom('email_auto_replies').where('user_id', '=', userId).execute();
  }
  return getVacation(db, userId);
}

interface Candidate extends AutoReplyCandidate {
  threadId: string;
  accountId: string | null;
  messageSubject: string | null;
}

/**
 * Send one vacation reply per new sender.
 *
 * Runs off the mirror, like ADR 0117's notifier, which is what makes it
 * identical on all three providers.
 */
export async function runVacationReplies(db: Kysely<DB>, userId: string): Promise<number> {
  const me = await db
    .selectFrom('users')
    .select([
      'email',
      'vacation_enabled',
      'vacation_subject',
      'vacation_body',
      'vacation_starts_at',
      'vacation_ends_at',
      'vacation_since',
      'email_signature',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!me) return 0;

  const now = new Date().toISOString();
  const active = vacationActive(
    {
      enabled: me.vacation_enabled === 1,
      startsAt: me.vacation_starts_at,
      endsAt: me.vacation_ends_at,
    },
    now,
  );
  if (!active) return 0;

  const body = me.vacation_body?.trim();
  // Nothing to say is not a holiday. Refusing here beats sending an empty mail.
  if (!body) return 0;
  // Nobody types an auto-reply, so it carries the signature the way the
  // composer would have opened (the send path adds nothing): the one of the
  // mailbox it answers from.
  const signedFor = new Map<string, Promise<string>>();
  const signed = (accountId: string | null) => {
    const key = accountId ?? '';
    if (!signedFor.has(key)) signedFor.set(key, signedBody(db, userId, body, accountId));
    return signedFor.get(key)!;
  };

  const since = me.vacation_since ?? me.vacation_starts_at ?? now;

  const rows = await db
    .selectFrom('email_messages as m')
    .innerJoin('email_threads as t', 't.id', 'm.thread_id')
    .select([
      'm.thread_id as thread_id',
      'm.from_email as from_email',
      'm.to_emails as to_emails',
      'm.cc_emails as cc_emails',
      'm.subject as subject',
      'm.list_unsubscribe as list_unsubscribe',
      't.account_id as account_id',
      't.bulk as bulk',
      'm.internal_date as internal_date',
    ])
    .where('m.user_id', '=', userId)
    .where('m.internal_date', '>=', since)
    .where('t.is_archived', '=', 0)
    .orderBy('m.internal_date', 'asc')
    .limit(MAX_PER_TICK * 5)
    .execute();
  if (rows.length === 0) return 0;

  const replied = await db
    .selectFrom('email_auto_replies')
    .select('sender_email')
    .where('user_id', '=', userId)
    .execute();
  const repliedSenders = new Set(replied.map((r) => r.sender_email));
  const myEmails = [me.email ?? ''].filter(Boolean);
  const accounts = await db
    .selectFrom('email_accounts')
    .select(['id', 'email_address'])
    .where('user_id', '=', userId)
    .execute();
  myEmails.push(...accounts.map((a) => a.email_address).filter(Boolean));

  let sentCount = 0;
  // The scan's lower bound moves forward with every message looked at. Kept
  // at the holiday's start, each tick re-read the same oldest 100 messages -
  // skipped senders, bulk, mail to others - and once those filled the window,
  // nobody new was ever answered.
  let examinedThrough: string | null = null;
  for (const r of rows) {
    if (sentCount >= MAX_PER_TICK) break;
    examinedThrough = r.internal_date;

    const candidate: Candidate = {
      threadId: r.thread_id,
      accountId: r.account_id,
      fromEmail: r.from_email,
      toEmails: r.to_emails ?? [],
      ccEmails: r.cc_emails ?? [],
      subject: r.subject,
      messageSubject: r.subject,
      listUnsubscribe: r.list_unsubscribe,
      bulk: r.bulk === 1,
    };

    const skip = autoReplySkipReason(candidate, { myEmails, repliedSenders });
    if (skip) continue;

    const sender = (candidate.fromEmail ?? '').toLowerCase();
    // Claimed BEFORE sending: a send that throws must not be retried into a
    // second copy on the next tick.
    repliedSenders.add(sender);
    await db
      .insertInto('email_auto_replies')
      .values({ user_id: userId, sender_email: sender, sent_at: now })
      .onConflict((oc) => oc.columns(['user_id', 'sender_email']).doNothing())
      .execute();

    try {
      const message = {
        threadRowId: candidate.threadId,
        body: await signed(candidate.accountId ?? null),
        // RFC 3834: to the sender, not to a Reply-To.
        to: [candidate.fromEmail!],
        // An auto-reply is not reading (ADR 0124).
        markRead: false,
        // ...and not the user answering (ADR 0314).
        autoReply: true,
      };
      if (candidate.accountId) {
        await sendAccountReply(db, userId, candidate.accountId, message);
      } else {
        // Reached at call time, not import time: gmail.service imports THIS
        // module for the afterSync pass, and the ADR 0116 cycle is real.
        const { sendReply } = await import('../google/gmail.service.js');
        await sendReply(db, userId, message);
      }
      sentCount += 1;
    } catch (err) {
      logger.warn('vacation reply failed', { userId, err: (err as Error).message });
    }
  }

  // Guarded on the value we read, so a responder switched off and on during
  // this tick keeps its fresh start.
  if (examinedThrough && examinedThrough > since) {
    await db
      .updateTable('users')
      .set({ vacation_since: examinedThrough })
      .where('id', '=', userId)
      .where('vacation_since', me.vacation_since == null ? 'is' : '=', me.vacation_since ?? null)
      .execute();
  }

  if (sentCount > 0) {
    logger.info('vacation replies sent', { userId, sentCount });
  }
  return sentCount;
}

/** The subject a reply would carry, exposed for the settings preview. */
export function vacationReplySubject(
  configured: string | null,
  originalSubject: string | null,
): string {
  return configured?.trim() || autoReplySubject(originalSubject);
}
