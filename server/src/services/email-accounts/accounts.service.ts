/**
 * Attached-mailbox orchestration (ADR 0080): connect (Outlook OAuth / IMAP
 * app-password), per-account sync dispatch, opportunistic throttled sync of
 * every account, thread-level provider dispatch for the reader routes, and
 * disconnect (FK cascade wipes the account's mirror).
 */
import { sql, type Kysely } from 'kysely';

import {
  IMAP_PRESETS,
  providerThreadLink,
  type ConnectGmailAccountRequest,
  type ConnectImapRequest,
  type ConnectOutlookRequest,
  type EmailAccountSummary,
  type EmailModifyRequest,
  type EmailSyncResult,
  type EmailThreadDetail,
  type EmailThreadSummary,
  normalizeMailboxNickname,
  type ProviderLink,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { runInBackground } from '../../utils/background.js';
import { newId } from '../../utils/ids.js';
import { assertPublicHost, BlockedHostError } from '../../utils/ssrf.js';
import { armMailbox } from '../email/mail-subscriptions.js';
import { primaryGmailAddress } from '../email/primary-gmail-address.js';
import type { ComposedBody } from '../email/signature.js';
import {
  accountKey,
  backoffRemainingMs,
  recordSyncFailure,
  recordSyncPause,
  recordSyncSuccess,
} from '../email/sync-backoff.js';
import {
  applyChordLabelPatch,
  chordLabelPatchRequested,
  providerModifyRequested,
} from '../email/chord-labels.js';
import {
  AccountAuthError,
  AccountValidationError,
  MailboxWriteUnsupportedError,
  accountToSummary,
  getAccount,
  listAccounts,
  markAccountReconnect,
  nativeId,
  sealAuthBlob,
  type AccountRow,
  type ImapAuth,
} from './account-utils.js';
import { exchangeCode } from '../google/oauth.service.js';
import {
  emitEmailThreadUpdated,
  hasGmailScope,
  maybeSyncGmail,
  threadRowToSummary,
  withMailSyncRound,
  type MailSyncDepth,
  type ReadWriteOpts,
} from '../google/gmail.service.js';
import {
  applyGmailAccountThreadModify,
  getGmailAccountThread,
  sendGmailAccountNew,
  sendGmailAccountReply,
  syncGmailAccount,
  type GmailAccountAuth,
} from './gmail-account.service.js';
import { getImapApi, mockImapApi } from './imap-api.js';
import { forgetOutlookAccountCalendars, grantsOutlookCalendar } from '../outlook-calendar/accounts.js';
import { forgetGmailAccountCalendars, grantsGoogleCalendar } from '../gmail-calendar/accounts.js';
import { exchangeOutlookCode, outlookAuthBlob, type OutlookExchangeResult } from './outlook-oauth.js';
import {
  applyImapThreadModify,
  getImapThread,
  sendImapNew,
  sendImapReply,
  syncImapAccount,
} from './imap.service.js';
import {
  applyOutlookThreadModify,
  getOutlookThread,
  sendOutlookNew,
  sendOutlookReply,
  syncOutlookAccount,
} from './outlook.service.js';

const SYNC_THROTTLE_MS = () => env.GMAIL_SYNC_THROTTLE_MINUTES * 60 * 1000;

export async function listAccountSummaries(
  db: Kysely<DB>,
  userId: string,
): Promise<EmailAccountSummary[]> {
  return (await listAccounts(db, userId)).map(accountToSummary);
}

/**
 * Per-mailbox prefs: ADR 0142 label-push opt-in, ADR 0145 nickname.
 *
 * A partial patch — an absent field is left alone rather than cleared, so
 * renaming a mailbox cannot silently switch its label push off.
 */
export async function setAccountPrefs(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  patch: { labelPushEnabled?: boolean; nickname?: string | null },
): Promise<EmailAccountSummary | null> {
  const account = await getAccount(db, userId, accountId);
  if (!account) return null;
  const values: {
    label_push_enabled?: number;
    nickname?: string | null;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };

  if (patch.labelPushEnabled !== undefined) {
    if (patch.labelPushEnabled && Number(account.label_push_supported ?? 0) !== 1) {
      throw new AccountValidationError(
        'this mailbox cannot receive Chord label tags',
      );
    }
    values.label_push_enabled = patch.labelPushEnabled ? 1 : 0;
    // Switching push on is asking for the labels again (ADR 0303 addendum).
    if (patch.labelPushEnabled) {
      const { forgetRemovedFolders, isChordProviderLabel } = await import('../email/mailbox-folder-memory.js');
      await forgetRemovedFolders(db, userId, isChordProviderLabel, account.id);
    }
  }
  if (patch.nickname !== undefined) {
    values.nickname = normalizeMailboxNickname(patch.nickname);
  }

  await db
    .updateTable('email_accounts')
    .set(values)
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .execute();
  const row = await getAccount(db, userId, accountId);
  return row ? accountToSummary(row) : null;
}

/**
 * One mailbox, one mirror: the same address under a second provider (the
 * primary Gmail over IMAP, an Outlook mailbox again as IMAP) syncs every
 * message twice. Re-attaching under the SAME provider is a reconnect and
 * passes.
 */
async function assertMailboxNotAttached(
  db: Kysely<DB>,
  userId: string,
  provider: 'gmail' | 'outlook' | 'imap',
  emailAddress: string,
): Promise<void> {
  const address = emailAddress.trim().toLowerCase();
  if ((await primaryGmailAddress(db, userId)) === address && (await hasGmailScope(db, userId))) {
    throw new AccountValidationError('That address is already connected as your primary Gmail mailbox');
  }
  const other = await db
    .selectFrom('email_accounts')
    .select('provider')
    .where('user_id', '=', userId)
    .where('provider', '!=', provider)
    .where(sql<boolean>`lower(email_address) = ${address}`)
    .executeTakeFirst();
  if (other) {
    const name = other.provider === 'imap' ? 'IMAP' : other.provider === 'gmail' ? 'Gmail' : 'Outlook';
    throw new AccountValidationError(`That address is already connected as an ${name} mailbox`);
  }
}

interface InsertedAccount {
  row: AccountRow;
  /**
   * This address was already on the user's list and its credentials were
   * replaced. Right for the reconnect door, and the answer the ADD door owes
   * the user: nothing new was attached (ADR 0320).
   */
  reattached: boolean;
}

async function insertAccount(
  db: Kysely<DB>,
  values: {
    userId: string;
    provider: 'gmail' | 'outlook' | 'imap';
    emailAddress: string;
    displayName: string | null;
    presetKey: string | null;
    auth: { auth_ciphertext: Buffer; auth_iv: Buffer; auth_tag: Buffer } | null;
  },
): Promise<InsertedAccount> {
  const now = new Date().toISOString();
  // One spelling per mailbox. Every caller lowercases already, but a mixed-case
  // address reaching here would miss the row below and attach the SAME mailbox
  // a second time, with nothing to tell the two rows apart (ADR 0320).
  const emailAddress = values.emailAddress.trim().toLowerCase();
  // Gmail + Outlook can push Chord labels today; IMAP waits for PERMANENTFLAGS.
  const labelPushSupported = values.provider === 'imap' ? 0 : 1;
  await assertMailboxNotAttached(db, values.userId, values.provider, emailAddress);
  const existing = await db
    .selectFrom('email_accounts')
    .select('id')
    .where('user_id', '=', values.userId)
    .where('provider', '=', values.provider)
    .where(sql<boolean>`lower(email_address) = ${emailAddress}`)
    .executeTakeFirst();
  if (existing) {
    // Re-attach: fresh credentials replace the dead ones; the mirror stays.
    await db
      .updateTable('email_accounts')
      .set({
        display_name: values.displayName,
        preset_key: values.presetKey,
        ...(values.auth ?? {}),
        status: 'ok',
        label_push_supported: labelPushSupported,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('email_accounts')
      .values({
        id: newId('ema'),
        user_id: values.userId,
        provider: values.provider,
        email_address: emailAddress,
        display_name: values.displayName,
        preset_key: values.presetKey,
        ...(values.auth ?? { auth_ciphertext: null, auth_iv: null, auth_tag: null }),
        sync_cursor: null,
        synced_at: null,
        backfill_done: 0,
        status: 'ok',
        label_push_supported: labelPushSupported,
        label_push_enabled: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  const row = await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('user_id', '=', values.userId)
    .where('provider', '=', values.provider)
    .where(sql<boolean>`lower(email_address) = ${emailAddress}`)
    .executeTakeFirstOrThrow();
  return { row: row as AccountRow, reattached: !!existing };
}

/** Attach an Outlook / Microsoft 365 mailbox from the client's PKCE code. */
export async function connectOutlookAccount(
  db: Kysely<DB>,
  userId: string,
  input: ConnectOutlookRequest,
): Promise<EmailAccountSummary> {
  return attachOutlookMailbox(
    db,
    userId,
    env.OUTLOOK_PROVIDER === 'mock' ? null : await exchangeOutlookCode(input),
  );
}

/**
 * Store an exchanged Outlook grant as the user's mailbox and start it (null =
 * the mock mailbox). Shared by the Settings connect and Sign in with Microsoft
 * (ADR 0293), which exchanges the code itself to read the identity from the
 * same response.
 *
 * Deliberately never writes `users.microsoft_sub`: attaching a mailbox (a
 * child's school account) is not proof the Microsoft login is this person, so
 * it must not open this account (ADR 0293, owner decision).
 */
export async function attachOutlookMailbox(
  db: Kysely<DB>,
  userId: string,
  exchanged: OutlookExchangeResult | null,
): Promise<EmailAccountSummary> {
  let account: AccountRow;
  let reattached: boolean;
  if (!exchanged) {
    ({ row: account, reattached } = await insertAccount(db, {
      userId,
      provider: 'outlook',
      emailAddress: 'me@outlook.example',
      displayName: 'Mock Outlook',
      presetKey: null,
      auth: null,
    }));
  } else {
    ({ row: account, reattached } = await insertAccount(db, {
      userId,
      provider: 'outlook',
      emailAddress: exchanged.emailAddress,
      displayName: exchanged.displayName,
      presetKey: null,
      auth: sealAuthBlob(outlookAuthBlob(exchanged.refreshToken, exchanged.publicClient)),
    }));
    // ADR 0228 — the grant decides whether this mailbox carries a calendar.
    // Written on every connect, so reconnecting to add calendar access (or a
    // consent that left it out) is reflected either way.
    const calendarEnabled = grantsOutlookCalendar(exchanged.grantedScopes) ? 1 : 0;
    await db
      .updateTable('email_accounts')
      .set({ calendar_enabled: calendarEnabled })
      .where('id', '=', account.id)
      .execute();
    account = { ...account, calendar_enabled: calendarEnabled };
    if (calendarEnabled && env.OUTLOOK_CALENDAR_ENABLED) {
      // First calendar pull, beside the first mail sync. Imported on use:
      // the sync engine sits above this module.
      runInBackground(
        import('../google/two-way-sync.service.js')
          .then((m) => m.syncTwoWay(db, userId))
          .catch((err) =>
            logger.warn('initial outlook calendar sync failed', {
              accountId: account.id,
              err: (err as Error).message,
            }),
          ),
      );
    }
  }
  // ADR 0118 — ask the provider to notify us. Fire-and-forget beside the
  // initial sync: push is an optimisation over polling, so a misconfigured
  // topic or an unreachable callback must not fail a connect.
  runInBackground(
    armMailbox(db, {
      userId: account.user_id,
      accountId: account.id,
      provider: account.provider as 'gmail' | 'outlook' | 'imap',
    }),
  );
  runInBackground(
    syncAccount(db, account).catch((err) =>
      logger.warn('initial outlook sync failed', { accountId: account.id, err: (err as Error).message }),
    ),
  );
  return { ...accountToSummary(account), reattached };
}

/**
 * Attach a SECONDARY Gmail mailbox (ADR 0080 addendum). Same Google OAuth
 * client as login; the exchanged refresh token lands on the account row —
 * the users-row token (login + calendar anchor) is never touched.
 */
export async function connectGmailAccount(
  db: Kysely<DB>,
  userId: string,
  input: ConnectGmailAccountRequest,
): Promise<EmailAccountSummary> {
  let account: AccountRow;
  let reattached: boolean;
  if (env.GMAIL_PROVIDER === 'mock') {
    ({ row: account, reattached } = await insertAccount(db, {
      userId,
      provider: 'gmail',
      emailAddress: 'second@gmail.example',
      displayName: 'Mock Gmail',
      presetKey: null,
      auth: null,
    }));
  } else {
    const exchanged = await exchangeCode(input);
    const email = exchanged.identity.email.toLowerCase();
    const me = await db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (me?.email && me.email.toLowerCase() === email) {
      throw new AccountValidationError(
        'That Gmail is already connected as your primary mailbox',
      );
    }
    if (!exchanged.refreshToken) {
      throw new AccountValidationError(
        'Google did not return a refresh token — retry the connect',
      );
    }
    if (!/https:\/\/www\.googleapis\.com\/auth\/gmail\.modify/.test(exchanged.grantedScopes)) {
      throw new AccountValidationError('Gmail permission was not granted');
    }
    const auth: GmailAccountAuth = {
      refreshToken: exchanged.refreshToken,
      clientId: exchanged.clientId,
    };
    ({ row: account, reattached } = await insertAccount(db, {
      userId,
      provider: 'gmail',
      emailAddress: email,
      displayName: exchanged.identity.name ?? null,
      presetKey: null,
      auth: sealAuthBlob(auth),
    }));
    // ADR 0313 — the grant decides whether this mailbox carries its own
    // calendar. Written on every connect, so reconnecting with the calendar
    // box ticked (or unticked) is reflected either way.
    const calendarEnabled = grantsGoogleCalendar(exchanged.grantedScopes) ? 1 : 0;
    await db
      .updateTable('email_accounts')
      .set({ calendar_enabled: calendarEnabled })
      .where('id', '=', account.id)
      .execute();
    account = { ...account, calendar_enabled: calendarEnabled };
    if (calendarEnabled) {
      runInBackground(
        import('../google/two-way-sync.service.js')
          .then((m) => m.syncTwoWay(db, userId))
          .catch((err) =>
            logger.warn('initial gmail-account calendar sync failed', {
              accountId: account.id,
              err: (err as Error).message,
            }),
          ),
      );
    }
  }
  // ADR 0118 — ask the provider to notify us. Fire-and-forget beside the
  // initial sync: push is an optimisation over polling, so a misconfigured
  // topic or an unreachable callback must not fail a connect.
  runInBackground(
    armMailbox(db, {
      userId: account.user_id,
      accountId: account.id,
      provider: account.provider as 'gmail' | 'outlook' | 'imap',
    }).catch(() => {
      /* armMailbox already records and logs its own failure */
    }),
  );
  runInBackground(
    syncAccount(db, account).catch((err) =>
      logger.warn('initial gmail-account sync failed', {
        accountId: account.id,
        err: (err as Error).message,
      }),
    ),
  );
  return { ...accountToSummary(account), reattached };
}

/** Attach a generic IMAP mailbox (Yahoo/AOL/iCloud/custom app password). */
export async function connectImapAccount(
  db: Kysely<DB>,
  userId: string,
  input: ConnectImapRequest,
): Promise<EmailAccountSummary> {
  const preset = IMAP_PRESETS[input.preset];
  const auth: ImapAuth = {
    host: input.host ?? preset.host,
    port: input.port ?? preset.port,
    smtpHost: input.smtpHost ?? preset.smtpHost,
    smtpPort: input.smtpPort ?? preset.smtpPort,
    username: input.username ?? input.emailAddress,
    password: input.password,
  };
  // ADR 0269 — a custom preset is a host and port the user typed, and the
  // verify login below is the server connecting to it: screen it first, or
  // connecting a mailbox is a port scan of the private network.
  if (input.preset === 'custom' && env.IMAP_PROVIDER !== 'mock' && env.NODE_ENV === 'production') {
    for (const host of [auth.host, auth.smtpHost]) {
      try {
        await assertPublicHost(host);
      } catch (err) {
        if (err instanceof BlockedHostError) throw Object.assign(err, { status: 400 });
        throw err;
      }
    }
  }
  // Verify the login BEFORE persisting anything — a typo'd app password must
  // fail the connect, not poison the sync loop.
  const verifyApi =
    env.IMAP_PROVIDER === 'mock'
      ? mockImapApi(`verify:${userId}`, { password: input.password })
      : getImapApi(`verify:${userId}`, auth);
  await verifyApi.verify();

  const { row: account, reattached } = await insertAccount(db, {
    userId,
    provider: 'imap',
    emailAddress: input.emailAddress.toLowerCase(),
    displayName: null,
    presetKey: input.preset,
    auth: env.IMAP_PROVIDER === 'mock' ? null : sealAuthBlob(auth),
  });
  // ADR 0142 — probe PERMANENTFLAGS before the user can opt into keyword push.
  try {
    const supported = await verifyApi.probeKeywordSupport();
    const { recordImapLabelPushSupport } = await import('../email/chord-label-push.js');
    await recordImapLabelPushSupport(db, account.id, supported);
  } catch (err) {
    logger.info('imap keyword probe failed', {
      accountId: account.id,
      err: (err as Error).message,
    });
  }
  // ADR 0118 — ask the provider to notify us. Fire-and-forget beside the
  // initial sync: push is an optimisation over polling, so a misconfigured
  // topic or an unreachable callback must not fail a connect.
  runInBackground(
    armMailbox(db, {
      userId: account.user_id,
      accountId: account.id,
      provider: account.provider as 'gmail' | 'outlook' | 'imap',
    }).catch(() => {
      /* armMailbox already records and logs its own failure */
    }),
  );
  runInBackground(
    syncAccount(db, account).catch((err) =>
      logger.warn('initial imap sync failed', { accountId: account.id, err: (err as Error).message }),
    ),
  );
  return { ...accountToSummary(account), reattached };
}

/**
 * Detach: the FK cascade wipes the account's threads/messages. ADR 0312 —
 * what its mail produced (trips, people, facts, receipts) goes too, unless
 * `keepDerived` (the mailbox is moving to another account, not leaving).
 */
export async function disconnectAccount(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  opts: { keepDerived?: boolean } = {},
): Promise<boolean> {
  // ADR 0228 — its calendars are named by the account id, not tied by a
  // foreign key, so they are cleared by hand.
  await forgetOutlookAccountCalendars(db, userId, accountId);
  await forgetGmailAccountCalendars(db, userId, accountId);
  if (!opts.keepDerived) {
    const owned = await db
      .selectFrom('email_accounts')
      .select('id')
      .where('id', '=', accountId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (owned) {
      const { purgeMailboxData } = await import('../email/mailbox-purge.js');
      await purgeMailboxData(db, userId, { kind: 'account', accountId });
    }
  }
  const res = await db
    .deleteFrom('email_accounts')
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

/**
 * ADR 0293 addendum — a sign-in-only account folded into another: its
 * mailboxes follow the person. A mailbox the target already reads (same
 * address, attached or its primary Gmail) is dropped, since keeping both
 * syncs the same mail twice. Any other is connected to the target with the
 * same credential and mirrors afresh: mail is sealed under the OWNER's key
 * (ADR 0201), so the old copy cannot simply be re-pointed. The source's
 * mirror goes with its row (FK cascade).
 *
 * Not in the fold's transaction: the calendar cleanup inside
 * `disconnectAccount` swallows its own errors, which would leave a Postgres
 * transaction aborted. Each mailbox is handled on its own and a failure is
 * logged, never thrown — the sign-in has already moved.
 */
export async function moveMailboxesTo(
  db: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
): Promise<{ moved: number; dropped: number }> {
  const out = { moved: 0, dropped: 0 };
  if (fromUserId === toUserId) return out;
  const [source, target, targetGmail, targetHasGmail] = await Promise.all([
    db.selectFrom('email_accounts').selectAll().where('user_id', '=', fromUserId).execute(),
    db.selectFrom('email_accounts').select(['id', 'email_address']).where('user_id', '=', toUserId).execute(),
    primaryGmailAddress(db, toUserId),
    hasGmailScope(db, toUserId),
  ]);
  // Address -> the target mailbox that reads it: an attached account id, or
  // null for the target's primary Gmail.
  const held = new Map<string, string | null>(
    target.map((a) => [a.email_address.trim().toLowerCase(), a.id]),
  );
  const targetPrimary = targetHasGmail ? targetGmail : null;
  if (targetPrimary && !held.has(targetPrimary)) held.set(targetPrimary, null);

  for (const acct of source) {
    try {
      const address = acct.email_address.trim().toLowerCase();
      if (!held.has(address)) {
        const now = new Date().toISOString();
        const id = newId('ema');
        await db
          .insertInto('email_accounts')
          .values({
            id,
            user_id: toUserId,
            provider: acct.provider,
            email_address: acct.email_address,
            display_name: acct.display_name,
            preset_key: acct.preset_key,
            auth_ciphertext: acct.auth_ciphertext,
            auth_iv: acct.auth_iv,
            auth_tag: acct.auth_tag,
            sync_cursor: null,
            synced_at: null,
            backfill_done: 0,
            status: acct.status,
            nickname: acct.nickname ?? null,
            label_push_supported: acct.label_push_supported,
            label_push_enabled: acct.label_push_enabled,
            calendar_enabled: acct.calendar_enabled,
            created_at: now,
            updated_at: now,
          })
          .execute();
        held.set(address, id);
        await repointMailboxProvenance(db, fromUserId, toUserId, acct.id, `${id}:`);
        const moved = await getAccount(db, toUserId, id);
        if (moved) {
          runInBackground(
            armMailbox(db, { userId: toUserId, accountId: id, provider: moved.provider }),
          );
          runInBackground(
            syncAccount(db, moved).catch((err) =>
              logger.warn('moved mailbox first sync failed', { accountId: id, err: (err as Error).message }),
            ),
          );
        }
        out.moved += 1;
      } else {
        const into = held.get(address) ?? null;
        // Into the target's primary Gmail only a Gmail mailbox can be the
        // same mail (its native thread ids are the primary's bare ids).
        if (into !== null) {
          await repointMailboxProvenance(db, fromUserId, toUserId, acct.id, `${into}:`);
        } else if (acct.provider === 'gmail') {
          await repointMailboxProvenance(db, fromUserId, toUserId, acct.id, '');
        }
        out.dropped += 1;
      }
      await disconnectAccount(db, fromUserId, acct.id, { keepDerived: true });
    } catch (err) {
      logger.error('mailbox move failed', {
        from: fromUserId,
        to: toUserId,
        accountId: acct.id,
        err: (err as Error).message,
      });
    }
  }
  return out;
}

/** Tables whose `gmail:<threadId>` provenance names the mail a row came from. */
const PROVENANCE_COLUMNS: Array<[keyof DB & string, string]> = [
  ['tasks', 'source_raw_context'],
  ['events', 'source_raw_context'],
  ['proposals', 'provenance'],
  ['trips', 'source_raw_context'],
  ['travel_legs', 'source_raw_context'],
  ['accommodations', 'source_raw_context'],
  ['trip_reservations', 'source_raw_context'],
  ['people', 'provenance'],
  ['person_relationships', 'provenance'],
  ['memories', 'provenance'],
];

/**
 * A folded mailbox's thread ids are `<oldAccountId>:<native>`; the mailbox
 * that now reads the same mail keys them `<newPrefix><native>`. Rows its mail
 * made are re-pointed so ADR 0312's purge (and ADR 0143/0314's thread
 * lookups) still find them, and the extraction marks are copied so the fresh
 * mirror is not mined a second time. The old prefix is unique to the old
 * account, so no owner filter is needed.
 */
export async function repointMailboxProvenance(
  db: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
  oldAccountId: string,
  newPrefix: string,
): Promise<void> {
  const oldThreads = `${oldAccountId}:`;
  const oldKey = `gmail:${oldThreads}`;
  const newKey = `gmail:${newPrefix}`;
  for (const [table, column] of PROVENANCE_COLUMNS) {
    const col = sql.ref(column);
    await sql`UPDATE ${sql.table(table)} SET ${col} = ${newKey} || substr(${col}, ${oldKey.length + 1})
      WHERE left(${col}, ${oldKey.length}) = ${oldKey}`.execute(db);
  }
  await sql`INSERT INTO email_extraction_marks (user_id, gmail_thread_id, kind, created_at)
    SELECT ${toUserId}, ${newPrefix} || substr(gmail_thread_id, ${oldThreads.length + 1}), kind, created_at
    FROM email_extraction_marks
    WHERE user_id = ${fromUserId} AND left(gmail_thread_id, ${oldThreads.length}) = ${oldThreads}
    ON CONFLICT DO NOTHING`.execute(db);
}

/**
 * Per account id: the run in flight, the single run queued behind it, and
 * how many of the two are still outstanding.
 *
 * The count is what keeps the bound honest. Clearing the entry when the
 * RUNNING one settles would drop it while the queued one is still going, and
 * the next caller — seeing nothing — would start a third sync alongside it.
 */
interface AccountSyncState {
  running: Promise<EmailSyncResult>;
  queued?: Promise<EmailSyncResult>;
  outstanding: number;
}
const accountSyncs = new Map<string, AccountSyncState>();

/** Drop the entry once both its runs have settled, and only if it is still
 *  the one the map holds. */
function releaseAccountSync(accountId: string, state: AccountSyncState): void {
  state.outstanding -= 1;
  if (state.outstanding <= 0 && accountSyncs.get(accountId) === state) {
    accountSyncs.delete(accountId);
  }
}

/**
 * Sync one mailbox, coalesced per account.
 *
 * Overlapping callers are ordinary here — the scheduler tick, a pull-to-
 * refresh, and a screen mounting all reach this — and prod showed four syncs
 * of one Yahoo account inside 1.3s. On IMAP that is four LOGINs, the exact
 * metric Yahoo throttles (ADR 0080): the next came back
 * `[LIMIT] AUTHENTICATE Rate limit hit`. Concurrency was buying nothing —
 * the later three re-read a mailbox the first was already reading — so
 * callers now collapse into at most ONE queued follow-up run: two logins
 * however many pile up, instead of one each.
 *
 * Keyed by account id rather than user: two of a user's mailboxes are
 * different servers and may legitimately sync at once.
 */
export async function syncAccount(db: Kysely<DB>, account: AccountRow): Promise<EmailSyncResult> {
  const dispatch = async (): Promise<EmailSyncResult> => {
    try {
      if (account.provider === 'gmail') {
        // A backfill stopped on the quota returns cleanly (ADR 0206 addendum);
        // it still waits before the next background try.
        const { pausedBy, ...result } = await syncGmailAccount(db, account);
        if (pausedBy !== undefined) recordSyncPause(accountKey(account.id), pausedBy, result.inserted > 0);
        else recordSyncSuccess(accountKey(account.id));
        return result;
      }
      const result =
        account.provider === 'outlook'
          ? await syncOutlookAccount(db, account)
          : await syncImapAccount(db, account);
      recordSyncSuccess(accountKey(account.id));
      return result;
    } catch (err) {
      recordSyncFailure(accountKey(account.id), err);
      throw err;
    }
  };

  const existing = accountSyncs.get(account.id);
  if (!existing) {
    const state: AccountSyncState = { running: Promise.resolve() as never, outstanding: 1 };
    state.running = dispatch().finally(() => releaseAccountSync(account.id, state));
    accountSyncs.set(account.id, state);
    return state.running;
  }
  // A caller arriving mid-run wants the mailbox as of THEIR call, and the
  // run in flight may have read it before their mail landed - so they get
  // their own run, not its result. Everyone who arrives during this one
  // shares that single trailing run, which is what bounds the logins.
  if (!existing.queued) {
    existing.outstanding += 1;
    existing.queued = existing.running
      .catch(() => undefined)
      .then(dispatch)
      .finally(() => releaseAccountSync(account.id, existing));
  }
  return existing.queued;
}

/**
 * Opportunistic, throttled, never-throws sync over every attached account.
 *
 * ONE round for the whole sweep. Each mailbox sync ends by calling the
 * user-wide AI pipeline — so without the round a three-mailbox user ran that
 * pipeline three times over the same rows.
 */
export async function maybeSyncAccounts(
  db: Kysely<DB>,
  userId: string,
  windowMs: number = SYNC_THROTTLE_MS(),
  depth: MailSyncDepth = 'full',
): Promise<void> {
  // `depth` is forwarded rather than left to default: the ADR 0144 sweep
  // opens a mirror round and then calls this, and a nested round asking for
  // `full` would DEEPEN the sweep straight back into the AI passes.
  await withMailSyncRound(
    db,
    userId,
    () => maybeSyncAccountsInner(db, userId, windowMs),
    depth,
  );
}

async function maybeSyncAccountsInner(
  db: Kysely<DB>,
  userId: string,
  windowMs: number,
): Promise<void> {
  try {
    const accounts = await listAccounts(db, userId);
    const due = accounts.filter((account) => {
      if (account.status === 'reconnect') return false;
      const last = account.synced_at ? Date.parse(account.synced_at) : 0;
      if (Date.now() - last < windowMs) return false;
      // `synced_at` only moves on success, so a failing account looks stale on
      // every tick; wait out its backoff instead of retrying it each time.
      return backoffRemainingMs(accountKey(account.id)) <= 0;
    });
    // Different servers, so side by side (as syncAllAccounts does); one IMAP
    // mailbox is still one login per tick (ADR 0080), only no longer queued
    // behind the others.
    await Promise.allSettled(
      due.map(async (account) => {
        try {
          await syncAccount(db, account);
        } catch (err) {
          // Unopenable/dead credentials (incl. a mock-era row after a flip to
          // real) surface as a visible reconnect state instead of silent misses.
          if (err instanceof AccountAuthError && err.needsReconnect) {
            await markAccountReconnect(db, account.id);
          }
          logger.warn('account sync failed', {
            accountId: account.id,
            provider: account.provider,
            err: (err as Error).message,
            retryInMs: backoffRemainingMs(accountKey(account.id)),
          });
        }
      }),
    );
  } catch (err) {
    logger.warn('maybeSyncAccounts failed', { userId, err: (err as Error).message });
  }
}

/**
 * Retry a flagged mailbox with the credential already on file. Every provider
 * resets `status` to `ok` after a clean tick, so a mailbox stranded by a
 * transient failure heals itself here — without this the bulk paths skip a
 * `reconnect` row forever and the only exit is re-typing an app password that
 * was never wrong.
 */
export async function retryAccount(
  db: Kysely<DB>,
  account: AccountRow,
): Promise<{ ok: boolean; needsReconnect: boolean; account: EmailAccountSummary }> {
  const summarise = async (): Promise<EmailAccountSummary> =>
    accountToSummary((await getAccount(db, account.user_id, account.id)) ?? account);
  try {
    await syncAccount(db, account);
  } catch (err) {
    if (err instanceof AccountAuthError && err.needsReconnect) {
      await markAccountReconnect(db, account.id);
      return { ok: false, needsReconnect: true, account: await summarise() };
    }
    throw err;
  }
  return { ok: true, needsReconnect: false, account: await summarise() };
}

/** Sync every account NOW (the explicit sync button), summing results. */
export async function syncAllAccounts(
  db: Kysely<DB>,
  userId: string,
  // Forwarded, not left to default: a nested `full` round DEEPENS the outer one
  // (see withMailSyncRound), which would put the AI passes back inside a
  // request that asked for the mirror only.
  depth: MailSyncDepth = 'full',
): Promise<EmailSyncResult> {
  return withMailSyncRound(db, userId, () => syncAllAccountsInner(db, userId), depth);
}

async function syncAllAccountsInner(
  db: Kysely<DB>,
  userId: string,
): Promise<EmailSyncResult> {
  const totals: EmailSyncResult = { inserted: 0, updated: 0, deleted: 0, backfillDone: true };
  // Every mailbox is tried, and at once: they are different servers, and a
  // loop that stopped at the first failure left every mailbox after a
  // throttled one unsynced — its deletions never reached Chord however often
  // the user pulled. The first real failure is still reported, after the rest.
  const accounts = (await listAccounts(db, userId)).filter((a) => a.status !== 'reconnect');
  const outcomes = await Promise.allSettled(accounts.map((a) => syncAccount(db, a)));
  let firstError: unknown = null;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.status === 'fulfilled') {
      totals.inserted += o.value.inserted;
      totals.updated += o.value.updated;
      totals.deleted += o.value.deleted;
      totals.backfillDone = totals.backfillDone && o.value.backfillDone;
      continue;
    }
    const err = o.reason;
    if (err instanceof AccountAuthError && err.needsReconnect) {
      await markAccountReconnect(db, accounts[i].id);
      continue;
    }
    firstError ??= err;
  }
  if (firstError) throw firstError;
  return totals;
}

/**
 * Every mailbox this user has, as ONE round.
 *
 * The primary Gmail and the attached accounts are separate calls, and the
 * places that mean "sync my mail" made both — so even with each half
 * collapsed, a Gmail-plus-Yahoo user still paid two AI pipelines. Sequential
 * rather than concurrent on purpose: those two were fired as independent
 * floating promises, which is one of the ways two rounds came to overlap.
 */
export async function syncAllUserMail(db: Kysely<DB>, userId: string): Promise<void> {
  await withMailSyncRound(db, userId, async () => {
    await maybeSyncGmail(db, userId);
    await maybeSyncAccounts(db, userId);
  });
}

// ── thread-level dispatch (reader routes) ─────────────────────────────

/**
 * Where to open this thread in the provider (ADR 0107). Resolves the mailbox
 * that actually holds it - the primary Gmail on the user row, or an attached
 * account - so a second Gmail opens the right profile rather than the first.
 */
export async function threadProviderLink(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
): Promise<ProviderLink | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['account_id', 'gmail_thread_id'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!thread) return null;

  if (!thread.account_id) {
    const me = await db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirst();
    return providerThreadLink({
      provider: 'gmail',
      emailAddress: me?.email ?? null,
      nativeThreadId: thread.gmail_thread_id,
    });
  }

  const account = await db
    .selectFrom('email_accounts')
    .select(['provider', 'email_address', 'preset_key'])
    .where('id', '=', thread.account_id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!account) return null;
  return providerThreadLink({
    provider: account.provider as 'gmail' | 'outlook' | 'imap',
    emailAddress: account.email_address,
    // Stored ids are account-prefixed; the provider wants its own.
    nativeThreadId: nativeId(thread.account_id, thread.gmail_thread_id),
    presetKey: account.preset_key,
  });
}
/** Compose a new message from one attached mailbox (ADR 0107). */
export async function sendAccountNew(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; attachments?: { filename: string; mimeType: string; content: Buffer }[] } & Omit<ComposedBody, 'body'>,
): Promise<{ fromEmail: string }> {
  const account = await requireAccount(db, userId, accountId);
  if (account.provider === 'gmail') return sendGmailAccountNew(db, account, input);
  return account.provider === 'outlook'
    ? sendOutlookNew(db, account, input)
    : sendImapNew(db, account, input);
}
/**
 * Which provider a message will actually leave through. `null` is the primary
 * Gmail on the user row (ADR 0080), so an unknown account falls back to that
 * rather than throwing — the send path itself will reject a bad account id with
 * a better error than an attachment lookup could.
 */
export async function providerFor(
  db: Kysely<DB>,
  userId: string,
  accountId: string | null,
): Promise<'gmail' | 'outlook' | 'imap'> {
  if (!accountId) return 'gmail';
  const account = await getAccount(db, userId, accountId);
  return account?.provider ?? 'gmail';
}

/** The owning account id of a thread row, or null for the Gmail mailbox. */
export async function threadAccountId(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('email_threads')
    .select('account_id')
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.account_id ?? null;
}

async function requireAccount(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<AccountRow> {
  const account = await getAccount(db, userId, accountId);
  if (!account) throw new AccountAuthError(`email account ${accountId} not found`, { needsReconnect: true });
  return account;
}

export async function getAccountThread(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  threadRowId: string,
): Promise<EmailThreadDetail | null> {
  const account = await requireAccount(db, userId, accountId);
  if (account.provider === 'gmail') return getGmailAccountThread(db, account, threadRowId);
  return account.provider === 'outlook'
    ? getOutlookThread(db, account, threadRowId)
    : getImapThread(db, account, threadRowId);
}

export async function sendAccountReply(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  input: { threadRowId: string; body: string; to?: string[]; cc?: string[]; bcc?: string[]; attachments?: { filename: string; mimeType: string; content: Buffer }[]; messageId?: string; markRead?: boolean; autoReply?: boolean } & Omit<ComposedBody, 'body'>,
): Promise<EmailThreadDetail | null> {
  const account = await requireAccount(db, userId, accountId);
  if (account.provider === 'gmail') return sendGmailAccountReply(db, account, input);
  return account.provider === 'outlook'
    ? sendOutlookReply(db, account, input)
    : sendImapReply(db, account, input);
}

export async function applyAccountThreadModify(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  threadRowId: string,
  patch: EmailModifyRequest,
  opts: ReadWriteOpts = {},
): Promise<EmailThreadSummary | null> {
  const account = await requireAccount(db, userId, accountId);

  // ADR 0141 — Chord labels are local on every mailbox; apply before provider.
  await applyChordLabelPatch(db, userId, threadRowId, patch);
  if (chordLabelPatchRequested(patch)) {
    const { pushChordLabels } = await import('../email/chord-label-push.js');
    await pushChordLabels(db, userId, threadRowId, patch);
  }

  // A secondary Gmail speaks the full label API; Outlook/IMAP get read/archive.
  if (account.provider === 'gmail') {
    return applyGmailAccountThreadModify(
      db,
      account,
      threadRowId,
      {
        markRead: patch.markRead,
        archive: patch.archive,
        trash: patch.trash,
        addLabelIds: patch.addLabelIds,
        removeLabelIds: patch.removeLabelIds,
        messageIds: patch.messageIds,
      },
      opts,
    );
  }
  // Outlook and IMAP have no label model. This used to silently drop the ids
  // and return a success the mailbox never saw (ADR 0107) — refuse instead, so
  // the caller learns the difference between "applied" and "ignored".
  // Chord labels (above) are NOT this — they never reach the provider.
  if ((patch.addLabelIds?.length ?? 0) > 0 || (patch.removeLabelIds?.length ?? 0) > 0) {
    throw new MailboxWriteUnsupportedError(
      `labels are a Gmail feature; this ${account.provider} mailbox cannot apply them`,
    );
  }

  if (!providerModifyRequested(patch)) {
    // Chord-only patch — reload the row (chord labels already applied).
    const row = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('id', '=', threadRowId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return null;
    const summary = threadRowToSummary(row);
    if (chordLabelPatchRequested(patch)) emitEmailThreadUpdated(userId, summary);
    return summary;
  }

  const narrowed = {
    markRead: patch.markRead,
    archive: patch.archive,
    trash: patch.trash,
    messageIds: patch.messageIds,
  };
  return account.provider === 'outlook'
    ? applyOutlookThreadModify(db, account, threadRowId, narrowed, opts)
    : applyImapThreadModify(db, account, threadRowId, narrowed, opts);
}
