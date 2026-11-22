/**
 * ADR 0313 — an attached Gmail's calendar follows what Google says its token
 * carries, read on every token refresh. The connect has always asked for the
 * calendar beside mail, so a mailbox connected before calendars existed
 * usually already holds the grant: it switches on at its next sync, with no
 * reconnect. Calendar access removed in Google switches it off.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import type { AccountRow } from '../email-accounts/account-utils.js';
import { runInBackground } from '../../utils/background.js';
import { forgetGmailAccountCalendars } from './accounts.js';
import { gmailCalendarsOn, grantsGoogleCalendar } from './enabled.js';

export async function noteGmailCalendarGrant(
  db: Kysely<DB>,
  account: Pick<AccountRow, 'id' | 'user_id' | 'provider' | 'calendar_enabled'>,
  grantedScopes: string,
): Promise<void> {
  if (account.provider !== 'gmail' || !gmailCalendarsOn()) return;
  const want = grantsGoogleCalendar(grantedScopes) ? 1 : 0;
  // Read the stored value, not the caller's copy: a refresh that ran on an
  // older row must not undo a switch another refresh already made.
  const row = await db
    .selectFrom('email_accounts')
    .select('calendar_enabled')
    .where('id', '=', account.id)
    .where('user_id', '=', account.user_id)
    .executeTakeFirst();
  if (!row || Number(row.calendar_enabled) === want) return;
  await db
    .updateTable('email_accounts')
    .set({ calendar_enabled: want, ...(want ? {} : { calendar_default_id: null }) })
    .where('id', '=', account.id)
    .execute();
  logger.info('gmail account calendar grant changed', { accountId: account.id, calendar: want === 1 });
  if (want) {
    runInBackground(
      import('../google/two-way-sync.service.js')
        .then((m) => m.syncTwoWay(db, account.user_id))
        .then(() => undefined)
        .catch((err) =>
          logger.warn('first gmail-account calendar sync failed', {
            accountId: account.id,
            err: (err as Error).message,
          }),
        ),
    );
  } else {
    await forgetGmailAccountCalendars(db, account.user_id, account.id);
  }
}
