/**
 * ADR 0313 — an attached (secondary) Gmail mailbox carries its own Google
 * calendar when its grant includes the calendar scope
 * (`email_accounts.calendar_enabled`, set at connect, as for Outlook in ADR
 * 0228). Everything here talks to Google with THAT account's token; the login
 * account's token is never used for a `gacct:` calendar, and this token never
 * for any other.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import { runInBackground } from '../../utils/background.js';
import type { DB } from '../../db/schema.js';
import { upsertCalendarSource } from '../calendar-sources.service.js';
import {
  AccountAuthError,
  markAccountReconnect,
  openAuthBlob,
  type AccountRow,
} from '../email-accounts/account-utils.js';
import { googleCalendarTransport, gfetch, type CalendarTransport } from '../google/calendar-transport.js';
import { GoogleAuthError, refreshAccessTokenWith } from '../google/oauth.service.js';
import { forgetCalendarsByKey } from '../outlook-calendar/accounts.js';
import { gmailCalendarsOn } from './enabled.js';
import { gmailAccountKeyPrefix, gmailCalendarKey, parseGmailCalendarKey } from './ids.js';

export { GOOGLE_CALENDAR_SCOPE, gmailCalendarAccounts, gmailCalendarsOn, grantsGoogleCalendar } from './enabled.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

async function calendarAccount(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<AccountRow | null> {
  if (!gmailCalendarsOn()) return null;
  const account = (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) as AccountRow | undefined;
  if (
    !account ||
    account.provider !== 'gmail' ||
    account.status !== 'ok' ||
    Number(account.calendar_enabled) !== 1
  ) {
    return null;
  }
  return account;
}

/**
 * The access token of one attached Gmail whose calendar is connected, or
 * null when it cannot be used for calendars right now. A dead refresh token
 * flags the mailbox for a reconnect, as the mail path does.
 */
export async function gmailCalendarAccessToken(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<string | null> {
  const account = await calendarAccount(db, userId, accountId);
  if (!account) return null;
  try {
    const auth = openAuthBlob<{ refreshToken: string; clientId: string }>(account);
    return await refreshAccessTokenWith(auth.refreshToken, auth.clientId, (scopes) =>
      runInBackground(
        import('./grant.js')
          .then((m) => m.noteGmailCalendarGrant(db, account, scopes))
          .catch((err) =>
            logger.warn('gmail account calendar grant check failed', {
              accountId: account.id,
              err: (err as Error).message,
            }),
          ),
      ),
    );
  } catch (err) {
    if (err instanceof GoogleAuthError && err.needsReconnect) {
      await markAccountReconnect(db, account.id);
      return null;
    }
    if (err instanceof AccountAuthError) return null;
    throw err;
  }
}

/**
 * The Google transport for one account, speaking `gacct:` keys. A key of any
 * other account (or a bare id) is refused before anything is sent, so a write
 * cannot cross accounts through this client.
 */
export function gmailAccountTransport(accountId: string, accessToken: string): CalendarTransport {
  const inner = googleCalendarTransport(accessToken);
  const native = (key: string): string => {
    const parsed = parseGmailCalendarKey(key);
    if (!parsed || parsed.accountId !== accountId) {
      throw new Error(`calendar ${key} is not on gmail account ${accountId}`);
    }
    return parsed.calendarId;
  };
  return {
    insert: async (key, body, notify) => inner.insert(native(key), body, notify),
    patch: async (key, eventId, body, opts) => inner.patch(native(key), eventId, body, opts),
    get: async (key, eventId) => inner.get(native(key), eventId),
    remove: async (key, eventId, etag) => inner.remove(native(key), eventId, etag),
    listChanges: async (key, syncToken) => inner.listChanges(native(key), syncToken),
    addOnlineMeeting: async (key, eventId, opts) => inner.addOnlineMeeting(native(key), eventId, opts),
  };
}

export async function gmailCalendarApiFor(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<CalendarTransport | null> {
  const token = await gmailCalendarAccessToken(db, userId, accountId);
  return token ? gmailAccountTransport(accountId, token) : null;
}

/** The client for the calendar a `gacct:` key names. */
export async function gmailCalendarApiForKey(
  db: Kysely<DB>,
  userId: string,
  calendarKey: string,
): Promise<CalendarTransport | null> {
  const parsed = parseGmailCalendarKey(calendarKey);
  return parsed ? gmailCalendarApiFor(db, userId, parsed.accountId) : null;
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

/**
 * Refresh `calendar_sources` from one account's calendar list and return the
 * keys to pull. The account's primary calendar becomes its
 * `calendar_default_id` (where its mail's events go, ADR 0312). A calendar it
 * no longer lists is forgotten with what was pulled from it.
 */
export async function discoverGmailAccountCalendars(
  db: Kysely<DB>,
  userId: string,
  account: AccountRow,
  accessToken: string,
): Promise<string[]> {
  const entries: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ maxResults: '250' });
    if (pageToken) p.set('pageToken', pageToken);
    const res = await gfetch(`${CAL_BASE}/users/me/calendarList?${p.toString()}`, accessToken);
    if (!res.ok) throw new Error(`calendarList.list ${res.status}`);
    const json = (await res.json()) as { items?: CalendarListEntry[]; nextPageToken?: string };
    entries.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  const keys: string[] = [];
  let defaultKey: string | null = null;
  for (const c of entries) {
    const role = c.accessRole;
    if (role !== 'reader' && role !== 'writer' && role !== 'owner') continue;
    const key = gmailCalendarKey(account.id, c.id);
    keys.push(key);
    if (c.primary) defaultKey = key;
    await upsertCalendarSource(db, userId, {
      provider: 'google',
      googleCalendarId: key,
      summary: c.summary ?? null,
      ...(c.backgroundColor ? { color: c.backgroundColor } : {}),
      accessRole: role,
      // `is_primary` is the login account's primary alone.
      isPrimary: false,
      selectedInGoogle: c.selected !== false,
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
    .where('google_calendar_id', 'like', `${gmailAccountKeyPrefix(account.id)}%`)
    .execute();
  for (const k of known) {
    if (!keys.includes(k.google_calendar_id)) {
      await forgetCalendarsByKey(db, userId, k.google_calendar_id, false);
    }
  }
  return keys;
}

/** A mailbox was disconnected: everything its calendars put in Chord goes. */
export async function forgetGmailAccountCalendars(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<void> {
  try {
    await forgetCalendarsByKey(db, userId, gmailAccountKeyPrefix(accountId), true);
  } catch (err) {
    logger.warn('gmail account calendar cleanup failed', { accountId, err: (err as Error).message });
  }
}

/** Readable calendars of one account, as native Google ids, primary first. */
export async function gmailAccountCalendarIds(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom('calendar_sources')
    .select('google_calendar_id')
    .where('user_id', '=', userId)
    .where('google_calendar_id', 'like', `${gmailAccountKeyPrefix(accountId)}%`)
    .execute();
  const account = await db
    .selectFrom('email_accounts')
    .select('calendar_default_id')
    .where('id', '=', accountId)
    .executeTakeFirst();
  const keys = rows.map((r) => r.google_calendar_id);
  const def = account?.calendar_default_id;
  keys.sort((a, b) => (a === def ? -1 : b === def ? 1 : 0));
  const ids = keys.map((k) => parseGmailCalendarKey(k)?.calendarId).filter((x): x is string => !!x);
  // Before the first discovery, the account's own primary is still there.
  return ids.length > 0 ? ids : ['primary'];
}
