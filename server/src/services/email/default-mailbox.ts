/**
 * ADR 0255 — the mailbox new mail goes out from when the user names none.
 *
 * Stored per user in `users.default_send_mailbox` ('primary' = the sign-in
 * Gmail, else an `email_accounts.id`), set only from chat. A stored choice is
 * used while that mailbox can still send; otherwise the built-in rule applies
 * (the primary Gmail when Chord may send from it, else the oldest attached
 * mailbox that does not need reconnecting), so a removed or broken mailbox
 * never strands a send.
 */
import type { Kysely } from 'kysely';

import { mailboxDisplayName, mailboxLocalPart, primaryMailboxDisplayName } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { listAccounts, type AccountRow } from '@/services/email-accounts/account-utils.js';
import { primaryGmailAddress } from '@/services/email/primary-gmail-address.js';
import { hasGmailScope, scopesCoverGmail } from '@/services/google/gmail.service.js';

export const PRIMARY_MAILBOX = 'primary';

export interface MailboxChoice {
  /** 'primary' or an attached account id. */
  mailbox: string;
  /** Null for the primary Gmail, which has no account row (ADR 0080). */
  accountId: string | null;
  label: string;
  address: string | null;
}

interface Candidate extends MailboxChoice {
  keys: string[];
  canSend: boolean;
}

/** What a caller that reads several mailbox facts at once (the Email status
 *  route) already has, so each helper need not read it again. */
export interface MailboxPreread {
  user: {
    email: string | null;
    gmail_nickname?: string | null;
    refresh_token_scopes: string | null;
    default_send_mailbox: string | null;
  } | undefined;
  accounts: AccountRow[];
}

async function candidates(db: Kysely<DB>, userId: string, pre?: MailboxPreread): Promise<Candidate[]> {
  const user = pre
    ? pre.user
    : await db
        .selectFrom('users')
        .select(['email', 'gmail_nickname'])
        .where('id', '=', userId)
        .executeTakeFirst();
  const out: Candidate[] = [];
  const gmail = pre ? scopesCoverGmail(pre.user?.refresh_token_scopes) : await hasGmailScope(db, userId);
  if (gmail) {
    // The Gmail's own address, not the sign-in email (a Microsoft or Apple
    // account's sign-in email is a different mailbox).
    const address = await primaryGmailAddress(db, userId);
    out.push({
      mailbox: PRIMARY_MAILBOX,
      accountId: null,
      label: primaryMailboxDisplayName(user?.gmail_nickname),
      address,
      keys: keysFor(user?.gmail_nickname, address, ['gmail', 'google']),
      canSend: true,
    });
  }
  for (const a of pre ? pre.accounts : await listAccounts(db, userId)) out.push(accountCandidate(a));
  return out;
}

function accountCandidate(a: AccountRow): Candidate {
  const words: string[] = [a.provider === 'imap' ? '' : a.provider];
  if (a.preset_key) words.push(a.preset_key);
  return {
    mailbox: a.id,
    accountId: a.id,
    label: mailboxDisplayName(a.nickname, a.email_address),
    address: a.email_address,
    keys: keysFor(a.nickname, a.email_address, words),
    canSend: a.status !== 'reconnect',
  };
}

/** Everything a person might call this mailbox: its nickname, its address,
 *  the address's local part, the provider, and the domain's first label
 *  ("hotmail", "yahoo"). */
function keysFor(nickname: string | null | undefined, address: string | null, words: string[]): string[] {
  const keys = [...words];
  if (nickname?.trim()) keys.push(nickname.trim());
  if (address) {
    keys.push(address, mailboxLocalPart(address));
    const domain = address.split('@')[1];
    if (domain) keys.push(domain.split('.')[0]);
  }
  return [...new Set(keys.map((k) => k.toLowerCase()).filter(Boolean))];
}

/** "my Outlook email" → "outlook". */
function normalizeAsk(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(my|the)\s+/, '')
    .replace(/\s+(mailbox|email|e-mail|mail|account|inbox|address)$/, '')
    .trim();
}

function toChoice(c: Candidate): MailboxChoice {
  return { mailbox: c.mailbox, accountId: c.accountId, label: c.label, address: c.address };
}

/** Every connected mailbox, the primary Gmail first, in the order Settings lists them. */
export async function listMailboxChoices(
  db: Kysely<DB>,
  userId: string,
  pre?: MailboxPreread,
): Promise<MailboxChoice[]> {
  return (await candidates(db, userId, pre)).map(toChoice);
}

/**
 * A mailbox by what the user called it, exact or ask (ADR 0137): an exact
 * name/address/provider match wins; otherwise a partial match must be unique.
 */
async function findMailboxByName(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<
  | { ok: true; hit: Candidate }
  | { ok: false; reason: 'not_found' | 'no_mailbox' }
  | { ok: false; reason: 'ambiguous'; candidates: MailboxChoice[] }
> {
  const ask = normalizeAsk(name);
  const all = await candidates(db, userId);
  if (all.length === 0) return { ok: false, reason: 'no_mailbox' };
  let hits = all.filter((c) => c.keys.includes(ask));
  if (hits.length === 0 && ask.length >= 3) {
    hits = all.filter((c) => c.keys.some((k) => k.includes(ask)));
  }
  if (hits.length === 0) return { ok: false, reason: 'not_found' };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits.map(toChoice) };
  return { ok: true, hit: hits[0] };
}

/** `findMailboxByName` without the internal fields. */
export async function matchMailboxByName(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<
  | { ok: true; mailbox: MailboxChoice }
  | { ok: false; reason: 'not_found' | 'no_mailbox' }
  | { ok: false; reason: 'ambiguous'; candidates: MailboxChoice[] }
> {
  const found = await findMailboxByName(db, userId, name);
  return found.ok ? { ok: true, mailbox: toChoice(found.hit) } : found;
}

/** The mailbox a new message leaves from: the stored choice while it can
 *  still send, else the built-in rule. Null when nothing can send. */
export async function resolveSendMailbox(
  db: Kysely<DB>,
  userId: string,
  pre?: MailboxPreread,
): Promise<MailboxChoice | null> {
  const all = await candidates(db, userId, pre);
  const user = pre
    ? pre.user
    : await db
        .selectFrom('users')
        .select('default_send_mailbox')
        .where('id', '=', userId)
        .executeTakeFirst();
  const stored = all.find((c) => c.mailbox === user?.default_send_mailbox && c.canSend);
  if (stored) return toChoice(stored);
  const fallback = all.find((c) => c.canSend);
  return fallback ? toChoice(fallback) : null;
}

/** A specific mailbox ('primary' or an account id), if it can send now. */
export async function sendableMailbox(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
): Promise<MailboxChoice | null> {
  const hit = (await candidates(db, userId)).find((c) => c.mailbox === mailbox && c.canSend);
  return hit ? toChoice(hit) : null;
}

/** What chat reports for "which mailbox do I send from": the mailbox that
 *  would be used now, and whether the user chose it. */
export async function getDefaultMailbox(
  db: Kysely<DB>,
  userId: string,
): Promise<{ current: MailboxChoice | null; chosen: boolean }> {
  const current = await resolveSendMailbox(db, userId);
  const user = await db
    .selectFrom('users')
    .select('default_send_mailbox')
    .where('id', '=', userId)
    .executeTakeFirst();
  return { current, chosen: !!current && current.mailbox === user?.default_send_mailbox };
}

export type SetDefaultMailboxResult =
  | { ok: true; mailbox: MailboxChoice | null }
  | { ok: false; reason: 'not_found' | 'no_mailbox' }
  | { ok: false; reason: 'needs_reconnect'; mailbox: MailboxChoice }
  | { ok: false; reason: 'ambiguous'; candidates: MailboxChoice[] };

/**
 * Set the default from what the user called it. Exact or ask (the ADR 0137
 * posture): an exact name/address/provider match wins; otherwise a partial
 * match must be unique. An empty name clears the choice (the rule applies
 * again). A mailbox that needs reconnecting is refused, never stored, since
 * mail could not leave from it.
 */
export async function setDefaultMailbox(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<SetDefaultMailboxResult> {
  if (!normalizeAsk(name)) {
    await db.updateTable('users').set({ default_send_mailbox: null }).where('id', '=', userId).execute();
    return { ok: true, mailbox: await resolveSendMailbox(db, userId) };
  }
  const found = await findMailboxByName(db, userId, name);
  if (!found.ok) return found;
  const hit = found.hit;
  if (!hit.canSend) return { ok: false, reason: 'needs_reconnect', mailbox: toChoice(hit) };
  await db
    .updateTable('users')
    .set({ default_send_mailbox: hit.mailbox })
    .where('id', '=', userId)
    .execute();
  return { ok: true, mailbox: toChoice(hit) };
}
