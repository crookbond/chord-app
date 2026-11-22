/**
 * Live junk/spam peek (ADR 0080 addendum). Verification codes and password
 * resets land in junk constantly, so the reader offers an on-demand view of
 * every mailbox's spam folder — read straight from the provider, NEVER
 * mirrored, never classified, never fed to any AI pass. The "not junk"
 * rescue moves a message to the inbox, where the normal sync picks it up.
 *
 * Keys are opaque: "primary:<gmailId>" or "<accountId>:<nativeId>".
 */
import type { Kysely } from 'kysely';

import type { JunkMessage } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { getGmailApi, type GmailApi } from '../google/gmail-api.js';
import { normalizeMessage } from '../google/gmail-sync.js';
import { hasGmailScope, maybeSyncGmail } from '../google/gmail.service.js';
import { listAccounts, type AccountRow } from './account-utils.js';
import { syncAccount } from './accounts.service.js';
import { gmailAccountApi } from './gmail-account.service.js';
import { imapAccountApi } from './imap.service.js';
import { getOutlookApi } from './outlook-api.js';

const JUNK_WINDOW_DAYS = 7;
const JUNK_PER_MAILBOX = 15;

async function gmailJunk(api: GmailApi, keyPrefix: string, mailbox: string): Promise<JunkMessage[]> {
  const page = await api.listMessages({
    q: `in:spam newer_than:${JUNK_WINDOW_DAYS}d`,
    maxResults: JUNK_PER_MAILBOX,
  });
  const wanted = page.messages.slice(0, JUNK_PER_MAILBOX);
  const fetched = await mapConcurrent(wanted, env.GMAIL_FETCH_CONCURRENCY, ({ id }) =>
    api.getMessage(id, 'full'),
  );
  const out: JunkMessage[] = [];
  for (let i = 0; i < fetched.length; i++) {
    const raw = fetched[i];
    if (!raw) continue;
    const nm = normalizeMessage(raw);
    out.push({
      key: `${keyPrefix}:${wanted[i].id}`,
      mailbox,
      fromName: nm.fromName,
      fromEmail: nm.fromEmail,
      subject: nm.subject,
      snippet: nm.snippet,
      bodyText: nm.bodyText,
      date: nm.internalDate,
    });
  }
  return out;
}

async function accountJunk(db: Kysely<DB>, account: AccountRow): Promise<JunkMessage[]> {
  if (account.provider === 'gmail') {
    const api = await gmailAccountApi(db, account);
    return gmailJunk(api, account.id, account.email_address);
  }
  if (account.provider === 'outlook') {
    const api = await getOutlookApi(db, account);
    const messages = await api.listJunk(JUNK_PER_MAILBOX);
    return messages.map((m) => ({
      key: `${account.id}:${m.id}`,
      mailbox: account.email_address,
      fromName: m.from?.emailAddress?.name ?? null,
      fromEmail: m.from?.emailAddress?.address?.toLowerCase() ?? null,
      subject: m.subject ?? '',
      snippet: m.bodyPreview ?? '',
      bodyText: m.body?.contentType === 'html' ? null : m.body?.content ?? null,
      date: m.receivedDateTime ?? new Date().toISOString(),
    }));
  }
  const api = imapAccountApi(account);
  const messages = await api.listJunk(JUNK_WINDOW_DAYS, JUNK_PER_MAILBOX);
  return messages.map((m) => ({
    key: `${account.id}:u${m.uid}`,
    mailbox: account.email_address,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    subject: m.subject,
    snippet: m.snippet,
    bodyText: m.bodyText,
    date: m.date,
  }));
}

/** Merge every mailbox's junk, newest first. Per-mailbox failures degrade. */
export async function listJunkMail(db: Kysely<DB>, userId: string): Promise<JunkMessage[]> {
  const out: JunkMessage[] = [];
  if (env.GMAIL_ENABLED && (await hasGmailScope(db, userId))) {
    try {
      out.push(...(await gmailJunk(await getGmailApi(db, userId), 'primary', 'Gmail')));
    } catch (err) {
      logger.warn('gmail junk peek failed', { userId, err: (err as Error).message });
    }
  }
  const accounts = (await listAccounts(db, userId)).filter((a) => a.status !== 'reconnect');
  // Independent per-mailbox provider calls, on demand from a route (not a
  // background sweep) — a small bound is plenty since a user rarely has more
  // than a handful of mailboxes.
  const perAccount = await mapConcurrent(accounts, 4, async (account) => {
    try {
      return await accountJunk(db, account);
    } catch (err) {
      logger.warn('account junk peek failed', {
        accountId: account.id,
        err: (err as Error).message,
      });
      return [];
    }
  });
  for (const messages of perAccount) out.push(...messages);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * "Not junk": move the message to that mailbox's inbox, then nudge a sync so
 * it lands in the mirror like normal mail. Returns false for an unknown key.
 */
export async function rescueJunkMail(
  db: Kysely<DB>,
  userId: string,
  key: string,
): Promise<boolean> {
  const sep = key.indexOf(':');
  if (sep <= 0) return false;
  const prefix = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (!id) return false;

  if (prefix === 'primary') {
    if (!(await hasGmailScope(db, userId))) return false;
    const api = await getGmailApi(db, userId);
    const raw = await api.getMessage(id, 'metadata');
    if (!raw) return false;
    await api.modifyThread(raw.threadId, { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] });
    await maybeSyncGmail(db, userId, 0);
    return true;
  }

  const account = (await listAccounts(db, userId)).find((a) => a.id === prefix);
  if (!account) return false;
  if (account.provider === 'gmail') {
    const api = await gmailAccountApi(db, account);
    const raw = await api.getMessage(id, 'metadata');
    if (!raw) return false;
    await api.modifyThread(raw.threadId, { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] });
  } else if (account.provider === 'outlook') {
    const api = await getOutlookApi(db, account);
    await api.moveToInbox(id);
  } else {
    const uid = Number((id.match(/^u(\d+)$/) ?? [])[1]);
    if (!Number.isFinite(uid) || uid <= 0) return false;
    await imapAccountApi(account).rescueJunk(uid);
  }
  try {
    await syncAccount(db, account);
  } catch (err) {
    logger.warn('post-rescue sync failed', { accountId: account.id, err: (err as Error).message });
  }
  return true;
}
