/**
 * ADR 0080 — shared plumbing for attached mailboxes (Outlook / IMAP).
 * Credentials are sealed with the same AES-GCM helpers as the Google refresh
 * token; provider-native ids are stored ACCOUNT-PREFIXED in the existing
 * gmail_*_id columns so downstream consumers stay unchanged.
 */
import type { Kysely, Selectable } from 'kysely';

import type { EmailAccountSummary } from '@chord/kernel';

import type { DB, EmailAccountsTable } from '../../db/schema.js';
import { openToken, sealToken } from '../../utils/crypto-tokens.js';

/** A selected email_accounts row (all columns). */
export type AccountRow = Selectable<EmailAccountsTable>;

/** Outlook auth blob: the (rotating) Microsoft refresh token. */
export interface OutlookAuth {
  refreshToken: string;
  /** The grant came back through the apps' `chord://` address, which Entra
   *  registers as a public client: Microsoft refuses a client secret when
   *  this token is refreshed (AADSTS90023). Absent = the web client. */
  publicClient?: boolean;
}

/** IMAP auth blob: hosts + the user-generated app password. */
export interface ImapAuth {
  host: string;
  port: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
}

/** Raised when a connect request is coherent but not attachable (e.g. trying
 *  to attach the primary Gmail as a secondary). Routes map it to 400. */
export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountValidationError';
  }
}

/**
 * Raised when an attached account's stored credentials are dead and the user
 * must re-attach the mailbox. Routes map it to 409 { needsReconnect } like
 * GoogleAuthError.
 */
export class AccountAuthError extends Error {
  readonly needsReconnect: boolean;
  constructor(message: string, opts: { needsReconnect?: boolean } = {}) {
    super(message);
    this.name = 'AccountAuthError';
    this.needsReconnect = opts.needsReconnect ?? false;
  }
}

/**
 * A mailbox write this provider cannot perform (ADR 0107). Raised INSTEAD of
 * quietly writing the local mirror and returning success: the mirror must never
 * assert something about the mailbox that is not true of it. Maps to 422.
 */
export class MailboxWriteUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxWriteUnsupportedError';
  }
}

/** `<accountId>:<nativeId>` — the stored form of provider thread/message ids. */
export function scopedId(accountId: string, nativeId: string): string {
  return `${accountId}:${nativeId}`;
}

/** Recover the provider-native id from a stored scoped id. */
export function nativeId(accountId: string, scoped: string): string {
  const prefix = `${accountId}:`;
  return scoped.startsWith(prefix) ? scoped.slice(prefix.length) : scoped;
}

export function sealAuthBlob(auth: object): {
  auth_ciphertext: Buffer;
  auth_iv: Buffer;
  auth_tag: Buffer;
} {
  const sealed = sealToken(JSON.stringify(auth));
  return { auth_ciphertext: sealed.ciphertext, auth_iv: sealed.iv, auth_tag: sealed.tag };
}

export function openAuthBlob<T>(row: AccountRow): T {
  if (!row.auth_ciphertext || !row.auth_iv || !row.auth_tag) {
    throw new AccountAuthError(`email account ${row.id} has no stored credentials`, {
      needsReconnect: true,
    });
  }
  try {
    return JSON.parse(
      openToken({
        ciphertext: row.auth_ciphertext as Buffer,
        iv: row.auth_iv as Buffer,
        tag: row.auth_tag as Buffer,
      }),
    ) as T;
  } catch {
    // A rotated MASTER_KEY makes every sealed blob undecryptable. Raised as a
    // plain Error this reads as a transient sync miss and the row keeps
    // claiming `ok` forever; as a reconnect the user is actually told.
    throw new AccountAuthError(`email account ${row.id} has unreadable credentials`, {
      needsReconnect: true,
    });
  }
}

export async function getAccount(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
): Promise<AccountRow | undefined> {
  return (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) as AccountRow | undefined;
}

export async function listAccounts(db: Kysely<DB>, userId: string): Promise<AccountRow[]> {
  return (await db
    .selectFrom('email_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute()) as AccountRow[];
}

export function accountToSummary(row: AccountRow): EmailAccountSummary {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.email_address,
    displayName: row.display_name,
    nickname: row.nickname ?? null,
    status: row.status,
    backfillDone: Number(row.backfill_done) === 1,
    lastSyncedAt: row.synced_at,
    presetKey: (row.preset_key as EmailAccountSummary['presetKey']) ?? null,
    labelPushSupported: Number(row.label_push_supported ?? 0) === 1,
    labelPushEnabled: Number(row.label_push_enabled ?? 0) === 1,
    calendarEnabled: Number(row.calendar_enabled ?? 0) === 1,
  };
}

/** Flag dead credentials so the UI can prompt a re-attach; sync skips it. */
export async function markAccountReconnect(db: Kysely<DB>, accountId: string): Promise<void> {
  await db
    .updateTable('email_accounts')
    .set({ status: 'reconnect', updated_at: new Date().toISOString() })
    .where('id', '=', accountId)
    .execute();
}

export async function updateAccountSync(
  db: Kysely<DB>,
  accountId: string,
  patch: { sync_cursor?: string | null; backfill_done?: number; synced_at?: string },
): Promise<void> {
  await db
    .updateTable('email_accounts')
    .set({ ...patch, updated_at: new Date().toISOString() })
    .where('id', '=', accountId)
    .execute();
}

/** Synthesized label set for non-Gmail messages (compatible with aggregateThread). */
export function syntheticLabels(opts: { inInbox: boolean; unread: boolean; sent?: boolean }): string[] {
  const labels: string[] = [];
  if (opts.inInbox) labels.push('INBOX');
  if (opts.unread) labels.push('UNREAD');
  if (opts.sent) labels.push('SENT');
  return labels;
}
