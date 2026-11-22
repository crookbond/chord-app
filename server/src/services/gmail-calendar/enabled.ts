/**
 * ADR 0313 — is an attached Gmail's calendar on, and for which mailboxes. Kept
 * free of other calendar imports so the sources service and the sync engine
 * can both ask.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import type { AccountRow } from '../email-accounts/account-utils.js';

/** The scope that makes an attached Gmail's calendar readable and writable. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

export function grantsGoogleCalendar(grantedScopes: string): boolean {
  return grantedScopes.split(/\s+/).includes(GOOGLE_CALENDAR_SCOPE);
}

/** The mock mailbox has no calendar behind it. */
export function gmailCalendarsOn(): boolean {
  return env.GMAIL_PROVIDER !== 'mock';
}

/** The user's attached Gmail mailboxes whose calendar can be synced now. */
export async function gmailCalendarAccounts(db: Kysely<DB>, userId: string): Promise<AccountRow[]> {
  if (!gmailCalendarsOn()) return [];
  return (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .where('provider', '=', 'gmail')
    .where('status', '=', 'ok')
    .where('calendar_enabled', '=', 1)
    .orderBy('created_at', 'asc')
    .execute()) as AccountRow[];
}

