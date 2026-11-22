/**
 * ADR 0228 — which of a user's Outlook mailboxes also carry a calendar, and
 * how to talk to one.
 *
 * A mailbox carries a calendar when its grant includes `Calendars.ReadWrite`
 * (`email_accounts.calendar_enabled`, set at connect). A mailbox connected
 * before calendars existed has mail only until it is reconnected.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { upsertCalendarSource } from '../calendar-sources.service.js';
import { AccountAuthError, type AccountRow } from '../email-accounts/account-utils.js';
import { getOutlookAccessToken } from '../email-accounts/outlook-oauth.js';
import { googleCalendarConnection } from '../google/calendar-write.service.js';
import { outlookAccountKeyPrefix, outlookCalendarKey, parseOutlookCalendarKey } from './ids.js';
import { parseGmailCalendarKey } from '../gmail-calendar/ids.js';
import { gmailCalendarAccounts } from '../gmail-calendar/enabled.js';
import { calendarsOn, outlookCalendarAccounts } from './enabled.js';
import { graphCalendarRole } from './map.js';
import { outlookCalendarApi, type OutlookCalendarApi } from './transport.js';

// An access token is good for about an hour. Without this every event write
// would spend a refresh, and Microsoft rotates the refresh token on each one.
const TOKEN_TTL_MS = 20 * 60 * 1000;
const tokenCache = new Map<string, { token: string; until: number }>();

export function __resetOutlookCalendarTokens(): void {
  tokenCache.clear();
}

async function accessTokenFor(db: Kysely<DB>, account: AccountRow): Promise<string> {
  const hit = tokenCache.get(account.id);
  if (hit && hit.until > Date.now()) return hit.token;
  const token = await getOutlookAccessToken(db, account);
  tokenCache.set(account.id, { token, until: Date.now() + TOKEN_TTL_MS });
  return token;
}

/**
 * The Graph calendar client for one mailbox, or null when that mailbox cannot
 * be used for calendars right now: unknown, not the user's, needing a
 * reconnect, or connected without calendar access. A dead refresh token is
 * null too — `getOutlookAccessToken` has already flagged the mailbox.
 */
export async function outlookCalendarApiFor(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<OutlookCalendarApi | null> {
  if (!calendarsOn()) return null;
  const account = (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) as AccountRow | undefined;
  if (
    !account ||
    account.provider !== 'outlook' ||
    account.status !== 'ok' ||
    Number(account.calendar_enabled) !== 1
  ) {
    return null;
  }
  let token: string;
  try {
    token = await accessTokenFor(db, account);
  } catch (err) {
    if (err instanceof AccountAuthError) {
      tokenCache.delete(account.id);
      return null;
    }
    throw err;
  }
  const user = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  return outlookCalendarApi(token, user?.last_tz ?? null);
}

/** The client for the calendar a namespaced id names. */
export async function outlookCalendarApiForKey(
  db: Kysely<DB>,
  userId: string,
  calendarKey: string,
): Promise<OutlookCalendarApi | null> {
  const parsed = parseOutlookCalendarKey(calendarKey);
  return parsed ? outlookCalendarApiFor(db, userId, parsed.accountId) : null;
}

/**
 * Refresh `calendar_sources` from one mailbox's calendar list and return the
 * ids to pull. A calendar the mailbox no longer has is forgotten, along with
 * the events that were pulled from it.
 */
export async function discoverOutlookCalendars(
  db: Kysely<DB>,
  userId: string,
  account: AccountRow,
  api: OutlookCalendarApi,
): Promise<string[]> {
  const calendars = await api.listCalendars();
  const keys: string[] = [];
  let defaultKey: string | null = null;
  for (const c of calendars) {
    const key = outlookCalendarKey(account.id, c.id);
    keys.push(key);
    if (c.isDefaultCalendar) defaultKey = key;
    await upsertCalendarSource(db, userId, {
      provider: 'outlook',
      googleCalendarId: key,
      summary: c.name ?? null,
      color: c.hexColor || null,
      accessRole: graphCalendarRole(c, account.email_address),
      // `is_primary` stays the Google primary's alone: readers of that flag
      // (legacy `gcal:` ids, the colour lookup) expect exactly one.
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
  }
  if (defaultKey && defaultKey !== account.calendar_default_id) {
    await db
      .updateTable('email_accounts')
      .set({ calendar_default_id: defaultKey })
      .where('id', '=', account.id)
      .execute();
  }

  const known = await db
    .selectFrom('calendar_sources')
    .select('google_calendar_id')
    .where('user_id', '=', userId)
    .where('provider', '=', 'outlook')
    .where('google_calendar_id', 'like', `${outlookAccountKeyPrefix(account.id)}%`)
    .execute();
  for (const k of known) {
    if (!keys.includes(k.google_calendar_id)) {
      await forgetCalendarsByKey(db, userId, k.google_calendar_id, false);
    }
  }
  return keys;
}

/**
 * Drop calendars and what was pulled from them. `keyOrPrefix` is one calendar
 * id, or (with `prefix`) the start every id of one mailbox shares. The key
 * prefix names the provider, so this serves Outlook and attached Gmail (ADR 0313).
 *
 * An event that only ever came FROM Outlook goes with its calendar. An event
 * Chord made and pushed there stays a Chord event: it loses its Outlook
 * identity and nothing else, so a family's shared plan does not vanish because
 * one member disconnected a mailbox.
 */
export async function forgetCalendarsByKey(
  db: Kysely<DB>,
  userId: string,
  keyOrPrefix: string,
  prefix: boolean,
): Promise<void> {
  const op = prefix ? 'like' : '=';
  const value = prefix ? `${keyOrPrefix}%` : keyOrPrefix;
  await db
    .deleteFrom('events')
    .where('owner_user_id', '=', userId)
    .where('google_calendar_id', op, value)
    .where('chord_uid', 'is', null)
    .where('series_id', 'is', null)
    .execute();
  await db
    .updateTable('events')
    .set({
      google_calendar_id: null,
      gcal_event_id: null,
      etag: null,
      recurring_event_id: null,
      gcal_sync_status: 'pending',
    })
    .where('owner_user_id', '=', userId)
    .where('google_calendar_id', op, value)
    .execute();
  await db
    .updateTable('event_series')
    .set({ google_calendar_id: null, gcal_event_id: null, etag: null })
    .where('owner_user_id', '=', userId)
    .where('google_calendar_id', op, value)
    .execute();
  await db
    .deleteFrom('calendar_sources')
    .where('user_id', '=', userId)
    .where('google_calendar_id', op, value)
    .execute();
  await db
    .updateTable('users')
    .set({ default_calendar_id: null })
    .where('id', '=', userId)
    .where('default_calendar_id', op, value)
    .execute();
}

/** A mailbox was disconnected: everything its calendars put in Chord goes. */
export async function forgetOutlookAccountCalendars(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<void> {
  tokenCache.delete(accountId);
  try {
    await forgetCalendarsByKey(db, userId, outlookAccountKeyPrefix(accountId), true);
  } catch (err) {
    logger.warn('outlook calendar cleanup failed', { accountId, err: (err as Error).message });
  }
}

/**
 * Whether an event saved now can reach the calendar it is headed for. An
 * Outlook calendar whose mailbox needs a reconnect, or was connected without
 * calendar access, reads `expired`: the event is queued and goes out after a
 * reconnect.
 */
export async function calendarConnection(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
): Promise<{ provider: 'google' | 'outlook'; state: 'connected' | 'expired' | 'never' }> {
  const gmailAccount = parseGmailCalendarKey(calendarId);
  if (gmailAccount) {
    // ADR 0313 — an attached Gmail's calendar is that mailbox's, not the login's.
    const ok = (await gmailCalendarAccounts(db, userId)).some((a) => a.id === gmailAccount.accountId);
    return { provider: 'google', state: ok ? 'connected' : 'expired' };
  }
  const parsed = parseOutlookCalendarKey(calendarId);
  if (!parsed) return { provider: 'google', state: await googleCalendarConnection(db, userId) };
  const ok = (await outlookCalendarAccounts(db, userId)).some((a) => a.id === parsed.accountId);
  return { provider: 'outlook', state: ok ? 'connected' : 'expired' };
}

export {
  grantsOutlookCalendar,
  OUTLOOK_CALENDAR_SCOPE,
  outlookCalendarAccounts,
  outlookDefaultCalendarKey,
} from './enabled.js';
