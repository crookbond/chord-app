/**
 * May a file copied out of email (ADR 0071) be auto-filed into trips and the
 * calendar, and onto which calendar?
 *
 * The email-BODY path asks each of these before it stages anything; the
 * attachment filer writes directly (no card), so it must ask them too, from
 * the same functions, or the two paths disagree about the same email:
 *
 *  - Trash / Spam / archived (ADR 0073, 0294 addendum 2026-10-29): mail the
 *    user threw away, or filed before Chord saw it, feeds no AI pass.
 *  - A sender the code check calls dangerous (ADR 0294 addendum 2026-10-28):
 *    a phishing "booking" must not become a trip.
 *  - The mailbox's own calendar (ADR 0312), via `calendarForBooking`, the
 *    rule flight legs already follow. Null = no calendar of its own; the
 *    caller then uses the user default, as for flights.
 *
 * Past dates are the caller's (they need the parsed dates): `isBeforeDay`.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { calendarForBooking } from './source-mailbox.js';
import { isDangerousSender } from './sender-check/prompt.js';

export type EmailCopyFiling =
  | { file: true; calendarId: string | null }
  | { file: false; reason: 'thread_gone' | 'trashed' | 'spam' | 'archived' | 'dangerous_sender' };

export async function emailCopyFiling(
  db: Kysely<DB>,
  userId: string,
  emailThreadId: string,
): Promise<EmailCopyFiling> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['gmail_thread_id', 'gmail_label_ids', 'is_archived'])
    .where('id', '=', emailThreadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!thread) return { file: false, reason: 'thread_gone' };
  const labels = Array.isArray(thread.gmail_label_ids) ? thread.gmail_label_ids : [];
  if (labels.includes('TRASH')) return { file: false, reason: 'trashed' };
  if (labels.includes('SPAM')) return { file: false, reason: 'spam' };
  if (thread.is_archived === 1) return { file: false, reason: 'archived' };
  if (await isDangerousSender(db, userId, emailThreadId)) return { file: false, reason: 'dangerous_sender' };
  const calendarId = await calendarForBooking(db, userId, `gmail:${thread.gmail_thread_id}`, null);
  return { file: true, calendarId };
}
