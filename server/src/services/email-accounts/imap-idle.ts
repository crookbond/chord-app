/**
 * IMAP's answer to push: hold the connection open (ADR 0118).
 *
 * There is no registration and no webhook. `IDLE` (RFC 2177) parks a logged-in
 * connection on the inbox and the server speaks first when something arrives,
 * which imapflow surfaces as an `exists` event.
 *
 * This argues with ADR 0080, which deliberately refused a cross-tick connection
 * pool, so the reasoning has to be explicit rather than assumed:
 *
 *  - That ADR's concern was **login rate** — Yahoo throttles on it, and a
 *    per-message login inside a loop is what caused the outage it fixed. IDLE
 *    is the opposite trade: ONE login held open, versus one per sync tick
 *    forever. It reduces the metric that ADR was protecting.
 *  - What it costs instead is a long-lived resource in a process that also
 *    runs schedulers. So: one connection per account, re-established on drop
 *    with backoff, and never more than `IMAP_IDLE_MAX_ACCOUNTS` of them.
 *  - Polling is untouched. If IDLE never connects, or dies quietly, the mailbox
 *    still syncs on its normal tick — this only makes it sooner.
 *
 * Every 29 minutes the connection must re-issue IDLE (RFC 2177's guidance,
 * since servers may drop a longer one); imapflow handles that internally, but
 * a dropped socket still surfaces here as a close and is retried.
 */
import { ImapFlow } from 'imapflow';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { wakeMailbox } from '../email/mail-push.js';
import { openAuthBlob, type AccountRow, type ImapAuth } from './account-utils.js';

/** Backoff between reconnect attempts, doubling to a ceiling. A mailbox whose
 *  credentials died must not become a login-rate problem of its own. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

interface Watcher {
  accountId: string;
  /** Which stored credential this watcher last logged in with. */
  credential: string;
  client: ImapFlow | null;
  stopped: boolean;
  retryMs: number;
  timer: NodeJS.Timeout | null;
}

const watchers = new Map<string, Watcher>();

/** Identifies one stored credential: a reconnect with a new app password
 *  seals a new blob (fresh IV). */
function credentialKey(row: AccountRow): string {
  return row.auth_iv ? Buffer.from(row.auth_iv as Buffer).toString('hex') : '';
}

async function loadAccount(db: Kysely<DB>, accountId: string): Promise<AccountRow | null> {
  const row = await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('id', '=', accountId)
    .where('provider', '=', 'imap')
    .executeTakeFirst();
  return (row as AccountRow | undefined) ?? null;
}

/**
 * Log in and park on the inbox. The account is read again on every attempt:
 * a reconnect captured at start would keep presenting the old app password
 * after the user reconnected the mailbox with a new one.
 */
async function connectOne(db: Kysely<DB>, accountId: string, w: Watcher): Promise<void> {
  const account = await loadAccount(db, accountId);
  // Gone or disconnected: nothing to watch; the next refresh drops the watcher.
  if (!account || account.status !== 'ok' || w.stopped) return;
  w.credential = credentialKey(account);
  const auth = openAuthBlob<ImapAuth>(account);
  const client = new ImapFlow({
    host: auth.host,
    port: auth.port,
    secure: true,
    auth: { user: auth.username, pass: auth.password },
    logger: false,
  });
  w.client = client;

  // The event that matters: the server volunteering that the mailbox grew.
  // Deliberately NOT acted on directly — it says a count changed, not what
  // arrived, so the sync re-reads as it always would.
  client.on('exists', () => {
    wakeMailbox(db, account.user_id, account.id);
  });

  client.on('close', () => {
    if (w.stopped) return;
    schedule(db, account.id, w);
  });
  client.on('error', (err: Error) => {
    logger.warn('imap idle error', { accountId: account.id, err: err.message });
  });

  await client.connect();
  // Replaced (new credential) or stopped while logging in: let it go.
  if (w.stopped) {
    await client.logout().catch(() => {});
    return;
  }
  await client.mailboxOpen('INBOX');
  // A successful connect resets the backoff; otherwise one bad night leaves a
  // healthy mailbox on a 15-minute retry forever.
  w.retryMs = RETRY_BASE_MS;
  logger.info('imap idle watching', { accountId: account.id });
  await client.idle();
}

function schedule(db: Kysely<DB>, accountId: string, w: Watcher): void {
  if (w.stopped || w.timer) return;
  const delay = w.retryMs;
  w.retryMs = Math.min(w.retryMs * 2, RETRY_MAX_MS);
  w.timer = setTimeout(() => {
    w.timer = null;
    void connectOne(db, accountId, w).catch((err: Error) => {
      logger.warn('imap idle reconnect failed', { accountId, err: err.message });
      schedule(db, accountId, w);
    });
  }, delay);
  w.timer.unref?.();
}

async function refreshWatchers(db: Kysely<DB>): Promise<void> {
  const rows = (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('provider', '=', 'imap')
    .where('status', '=', 'ok')
    .limit(env.IMAP_IDLE_MAX_ACCOUNTS)
    .execute()) as AccountRow[];
  const live = new Set(rows.map((r) => r.id));

  // Drop watchers whose account went away, was disconnected, or fell out of
  // the cap. Leaving one running would hold a login for a mailbox nobody is
  // reading.
  for (const [id, w] of watchers) {
    if (live.has(id)) continue;
    stopWatcher(w);
    watchers.delete(id);
  }

  for (const account of rows) {
    const existing = watchers.get(account.id);
    // A new credential (the user reconnected the mailbox) restarts the
    // watcher now rather than leaving it on the old one's backoff.
    if (existing && existing.credential === credentialKey(account)) continue;
    if (existing) {
      stopWatcher(existing);
      watchers.delete(account.id);
    }
    const w: Watcher = {
      accountId: account.id,
      credential: credentialKey(account),
      client: null,
      stopped: false,
      retryMs: RETRY_BASE_MS,
      timer: null,
    };
    watchers.set(account.id, w);
    void connectOne(db, account.id, w).catch((err: Error) => {
      logger.warn('imap idle connect failed, polling continues', {
        accountId: account.id,
        err: err.message,
      });
      schedule(db, account.id, w);
    });
  }
}

function stopWatcher(w: Watcher): void {
  w.stopped = true;
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  void w.client?.logout().catch(() => {
    // A logout that fails on an already-dead socket is not worth reporting.
  });
  w.client = null;
}

export interface IdleHandle {
  stop: () => void;
}

export function startImapIdle(db: Kysely<DB>): IdleHandle {
  if (!env.MAIL_PUSH_ENABLED || !env.IMAP_IDLE_ENABLED) {
    return { stop: () => {} };
  }
  logger.info(`imap idle enabled max_accounts=${env.IMAP_IDLE_MAX_ACCOUNTS}`);
  void refreshWatchers(db).catch((err) => logger.error('imap idle refresh failed', { err }));
  // Re-scan periodically so a newly connected mailbox starts being watched
  // without a restart, and a disconnected one stops.
  const interval = setInterval(() => {
    void refreshWatchers(db).catch((err) => logger.error('imap idle refresh failed', { err }));
  }, env.IMAP_IDLE_REFRESH_MS);
  interval.unref?.();
  return {
    stop: () => {
      clearInterval(interval);
      for (const w of watchers.values()) stopWatcher(w);
      watchers.clear();
    },
  };
}
