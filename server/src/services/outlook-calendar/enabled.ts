/**
 * ADR 0228 — is Outlook calendar sync on, and for which mailboxes. Kept free
 * of other calendar imports so both the sources service and the sync engine
 * can ask.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import type { AccountRow } from '../email-accounts/account-utils.js';

/** The scope that makes a mailbox's calendar readable and writable. */
export const OUTLOOK_CALENDAR_SCOPE = 'Calendars.ReadWrite';

export function grantsOutlookCalendar(grantedScopes: string): boolean {
  return /(?:^|[\s/])Calendars\.ReadWrite(?:$|\s)/i.test(grantedScopes);
}

export function calendarsOn(): boolean {
  // The mock mailbox has no calendar behind it.
  return env.OUTLOOK_CALENDAR_ENABLED && env.OUTLOOK_PROVIDER !== 'mock';
}

/** The user's Outlook mailboxes whose calendar can be synced right now. */
export async function outlookCalendarAccounts(db: Kysely<DB>, userId: string): Promise<AccountRow[]> {
  if (!calendarsOn()) return [];
  return (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .where('provider', '=', 'outlook')
    .where('status', '=', 'ok')
    .where('calendar_enabled', '=', 1)
    .orderBy('created_at', 'asc')
    .execute()) as AccountRow[];
}

/** The default calendar of the user's first calendar-carrying mailbox. */
export async function outlookDefaultCalendarKey(db: Kysely<DB>, userId: string): Promise<string | null> {
  const accounts = await outlookCalendarAccounts(db, userId);
  return accounts.find((a) => !!a.calendar_default_id)?.calendar_default_id ?? null;
}
