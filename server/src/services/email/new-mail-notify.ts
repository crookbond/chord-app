/**
 * New mail reaches the phone (ADR 0117).
 *
 * The push publisher hooks `sseHub` and returns early unless the event is
 * `SSE.message`, so email never pushed at all. This is the other half: it runs
 * off the MIRROR rather than off a sync's counters, which is what makes it
 * provider-agnostic — Gmail, Outlook and IMAP all land rows in the same table,
 * so all three notify identically without any of them being special-cased.
 *
 * A high-water mark (`users.email_notified_at`) is what makes it exactly-once.
 * The alternatives are both wrong: a sync's `inserted` counts upserts rather
 * than new mail, and no mark at all re-notifies about the same thread on every
 * tick.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { eligibleTokens } from '../push/push-publisher.js';
import { sendPush } from '../push/expo.service.js';

/** Enough to say what arrived without turning the notification into a list. */
const NAMED_LIMIT = 1;

interface NewThread {
  id: string;
  subject: string;
  from_name: string | null;
  from_email: string | null;
  last_message_at: string;
}

/**
 * A push body travels through Expo and APNs/FCM, so a subject or sender in it
 * is mail content handed to third parties. Generic text unless the deployment
 * opts in with PUSH_EMAIL_PREVIEW.
 */
export function describeNewMail(
  threads: NewThread[],
  preview: boolean,
): { title: string; body: string } {
  if (!preview) {
    return threads.length <= NAMED_LIMIT
      ? { title: 'New mail', body: 'You have a new email' }
      : { title: `${threads.length} new emails`, body: '' };
  }
  if (threads.length <= NAMED_LIMIT) {
    const t = threads[0];
    const who = t.from_name || t.from_email || 'New mail';
    return { title: who, body: t.subject || '(no subject)' };
  }
  return {
    title: `${threads.length} new emails`,
    // The newest one named, so the notification says something even when it is
    // a count. A list of five senders does not fit and does not help.
    body: threads[0].from_name || threads[0].from_email || '',
  };
}

/**
 * Push about mail that arrived since the last time we pushed.
 *
 * Returns the number of threads the notification covered (0 when there was
 * nothing to say, or nobody to say it to).
 */
export async function notifyNewMail(db: Kysely<DB>, userId: string): Promise<number> {
  const user = await db
    .selectFrom('users')
    .select('email_notified_at')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return 0;

  const now = new Date().toISOString();

  // First pass after connecting a mailbox: adopt the current high-water mark
  // and say nothing. Otherwise attaching an account fires a push for every
  // message in the backfill window, which is how people learn to turn
  // notifications off.
  if (!user.email_notified_at) {
    await db
      .updateTable('users')
      .set({ email_notified_at: now })
      .where('id', '=', userId)
      .execute();
    return 0;
  }

  const threads = (await db
    .selectFrom('email_threads')
    .select(['id', 'subject', 'from_name', 'from_email', 'last_message_at'])
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .where('is_archived', '=', 0)
    // ADR 0109's signal, used for the thing it is most useful for: a push per
    // newsletter is indistinguishable from spam to the person holding the
    // phone.
    .where('bulk', '=', 0)
    .where('last_message_at', '>', user.email_notified_at)
    .orderBy('last_message_at', 'desc')
    .limit(50)
    .execute()) as NewThread[];

  // The mark moves whether or not anyone was notified. A user with pushes off
  // must not accumulate a backlog that fires the moment they turn them on.
  const highWater = threads[0]?.last_message_at ?? now;
  await db
    .updateTable('users')
    .set({ email_notified_at: highWater })
    .where('id', '=', userId)
    .execute();

  if (threads.length === 0) return 0;

  const tokens = await eligibleTokens(db, [userId], 'email');
  if (tokens.length === 0) return 0;

  const { title, body } = describeNewMail(threads, env.PUSH_EMAIL_PREVIEW);
  try {
    await sendPush(db, tokens, {
      title,
      body: body.slice(0, 180),
      // One thread → open it. Several → the Email tab, since there is no one
      // thread to open.
      data:
        threads.length === 1
          ? { kind: 'email', threadId: threads[0].id }
          : { kind: 'email' },
    });
  } catch (err) {
    logger.warn('new-mail push failed', { userId, err: (err as Error).message });
  }
  return threads.length;
}
