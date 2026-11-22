/**
 * Filing rules (ADR 0309): "send mail from a person, or from a company's
 * domain, to folder Z". The rule lives in Chord; the folder lives on the
 * user's own mailbox, made there if it does not exist (a Gmail label, an
 * Outlook mail folder, an IMAP mailbox). After each sync, inbox mail that
 * matches a rule and arrived after it was made leaves the inbox and goes into
 * that folder. No AI call, so it runs with the mailbox passes above the
 * AI-consent and billing gates. Nothing is ever deleted.
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { textInstant } from '@/db/text-instant.js';
import { newId } from '@/utils/ids.js';
import type { ImapApi } from '../email-accounts/imap-api.js';
import type { GmailLabel } from '../google/gmail-api.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { listAutoTrash } from './auto-trash.service.js';
import {
  chordGmailLabel,
  folderState,
  FolderRemovedError,
  forgetRemovedFolders,
  loadFolderMemory,
  mailboxKeyOf,
  noteFolderRemoved,
  noteFolderSeen,
  sameFolderName,
} from './mailbox-folder-memory.js';

export interface FilingRule {
  id: string;
  /** `sender` matches one address; `domain` that domain and its subdomains. */
  kind: 'sender' | 'domain';
  value: string;
  folder: string;
  /** ISO time from which mail is filed; the epoch means existing mail too. */
  since: string;
}

export const MAX_FILING_RULES = 100;
/** Threads filed per pass: a backlog is finished over a few syncs. */
const PER_PASS = 25;
/** Folders a rule may not file into: the mailbox's own places. */
const RESERVED = new Set(['inbox', 'trash', 'spam', 'junk', 'sent', 'drafts', 'archive', 'deleted items']);

const filingRules = defineUserDefault(
  'email_filing_rules',
  z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        kind: z.enum(['sender', 'domain']),
        value: z.string().min(3).max(320),
        folder: z.string().min(1).max(100),
        since: z.string().min(10).max(40),
      }),
    )
    .max(MAX_FILING_RULES),
);

export async function listFilingRules(db: Kysely<DB>, userId: string): Promise<FilingRule[]> {
  return (await filingRules.get(db, userId)) ?? [];
}

export type FilingRuleProblem = 'bad_folder' | 'reserved_folder' | 'bad_match' | 'too_many';

/** A folder name a rule may use, trimmed; null when it may not. */
export function checkFolderName(folder: string): { ok: true; folder: string } | { ok: false; reason: FilingRuleProblem } {
  const f = folder.trim().replace(/\s+/g, ' ');
  if (!f || f.length > 100 || /^\/|\/$|\/\//.test(f)) return { ok: false, reason: 'bad_folder' };
  if (RESERVED.has(f.toLowerCase())) return { ok: false, reason: 'reserved_folder' };
  return { ok: true, folder: f };
}

/** `sender` for an address, `domain` for a bare domain; null otherwise. */
/**
 * Did the user ask for the mail ALREADY in the inbox to move, not just mail
 * arriving from now on? `alsoExisting` is an optional boolean, and ADR 0229's
 * addendum records that models fill those in — so without this the card can
 * offer a mailbox move nobody asked for, under a main sentence ("file mail
 * from the school into School") that is exactly right.
 *
 * Generous, like `looksLikeVideoCallRequest`: a false "they asked" shows a
 * card that honestly says "new and existing mail" and still needs a tap, while
 * a false "they did not" costs one more sentence ("move the old ones too").
 */
export function looksLikeExistingMailRequest(text: string): boolean {
  return /\b(exist\w*|already\s+(in|there|sitting|arrived|received)|old(er)?\s+(mail|email\w*|message\w*|ones?)|past\s+(mail|email\w*|message\w*)|previous\w*|everything\s+(from|in)|all\s+(of\s+)?(it|the\s+(mail|email\w*|message\w*|ones))|back\s?-?dat\w*|retro\w*|the\s+ones?\s+(i|already|that)|clean\s+(up|out)|move\s+(them|those|the\s+rest))\b/i.test(
    text,
  );
}

export function parseMatch(from: string): { kind: 'sender' | 'domain'; value: string } | null {
  const v = from.trim().toLowerCase().replace(/^@/, '');
  if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return { kind: 'sender', value: v };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(v)) return { kind: 'domain', value: v };
  return null;
}

/**
 * Add a rule (or move an existing rule for the same sender/domain to a new
 * folder). Returns the whole list after the change.
 */
export async function addFilingRule(
  db: Kysely<DB>,
  userId: string,
  input: { from: string; folder: string; alsoExisting?: boolean },
): Promise<{ ok: true; rule: FilingRule; rules: FilingRule[] } | { ok: false; reason: FilingRuleProblem }> {
  const match = parseMatch(input.from);
  if (!match) return { ok: false, reason: 'bad_match' };
  const folder = checkFolderName(input.folder);
  if (!folder.ok) return folder;
  // Under a row lock: two rules added at once both land.
  type Added = { ok: true; rule: FilingRule; rules: FilingRule[] } | { ok: false; reason: FilingRuleProblem };
  // Asking for this folder again is how a folder deleted in the mailbox is
  // made again (ADR 0303 addendum).
  await forgetRemovedFolders(db, userId, (name) => sameFolderName(name, folder.folder));
  return filingRules.update<Added>(db, userId, (stored) => {
    const current = stored ?? [];
    const existing = current.find((r) => r.kind === match.kind && r.value === match.value);
    if (!existing && current.length >= MAX_FILING_RULES) {
      return { value: undefined, result: { ok: false as const, reason: 'too_many' as const } };
    }
    const rule: FilingRule = {
      id: existing?.id ?? newId('fr'),
      ...match,
      folder: folder.folder,
      since: input.alsoExisting ? new Date(0).toISOString() : (existing?.since ?? new Date().toISOString()),
    };
    const rules = existing ? current.map((r) => (r.id === existing.id ? rule : r)) : [...current, rule];
    return { value: rules, result: { ok: true as const, rule, rules } };
  });
}

/** Remove rules by id. Returns the list after the change. */
export async function removeFilingRules(db: Kysely<DB>, userId: string, ids: string[]): Promise<FilingRule[]> {
  const drop = new Set(ids);
  return filingRules.update(db, userId, (stored) => {
    const rules = (stored ?? []).filter((r) => !drop.has(r.id));
    return { value: rules.length ? rules : null, result: rules };
  });
}

/** The rule that files mail from this address: an exact sender beats a domain;
 *  then the oldest rule (first in the list) wins. */
export function ruleFor(rules: FilingRule[], fromEmail: string): FilingRule | null {
  const from = fromEmail.trim().toLowerCase();
  const domain = from.slice(from.lastIndexOf('@') + 1);
  return (
    rules.find((r) => r.kind === 'sender' && r.value === from) ??
    rules.find((r) => r.kind === 'domain' && (domain === r.value || domain.endsWith(`.${r.value}`))) ??
    null
  );
}

/**
 * File one thread into a folder on its own mailbox. Throws when the mailbox
 * refused; returns false when there was nothing left in the inbox to file.
 */
export async function fileThreadIntoFolder(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  folder: string,
  /** Per-pass caches: each Gmail mailbox's labels (keyed `primary` or account
   *  id), each Outlook mailbox's folder ids, and an open IMAP session. */
  cache?: FilingPassCache,
): Promise<boolean> {
  const gmailLabels = cache?.gmailLabels;
  // Imported here: these modules import the Gmail service, which runs this pass.
  const { threadAccountId } = await import('../email-accounts/accounts.service.js');
  const { getAccount, MailboxWriteUnsupportedError } = await import('../email-accounts/account-utils.js');
  const accountId = await threadAccountId(db, userId, threadRowId);
  // ADR 0303 addendum: the folder is made only the first time. One the user
  // has since deleted in that mailbox is not made again; nothing is filed.
  const mailbox = mailboxKeyOf(accountId);
  const state = await folderState(db, userId, mailbox, folder);
  if (state === 'removed') return false;

  if (!accountId) {
    const { hasGmailScope, applyThreadModify } = await import('../google/gmail.service.js');
    const { getGmailApi } = await import('../google/gmail-api.js');
    if (!(await hasGmailScope(db, userId))) throw new MailboxWriteUnsupportedError('Gmail is not connected');
    const api = await getGmailApi(db, userId);
    const labels = gmailLabels?.get('primary') ?? (await api.listLabels());
    gmailLabels?.set('primary', labels);
    const label = await chordGmailLabel(db, userId, mailbox, api, labels, folder);
    if (!label) return false;
    return !!(await applyThreadModify(db, userId, threadRowId, { addLabelIds: [label.id], removeLabelIds: ['INBOX'] }));
  }

  const account = await getAccount(db, userId, accountId);
  if (!account) throw new MailboxWriteUnsupportedError('that mailbox is no longer connected');
  if (account.provider === 'gmail') {
    const { gmailAccountApi } = await import('../email-accounts/gmail-account.service.js');
    const { applyAccountThreadModify } = await import('../email-accounts/accounts.service.js');
    const api = await gmailAccountApi(db, account);
    const labels = gmailLabels?.get(account.id) ?? (await api.listLabels());
    gmailLabels?.set(account.id, labels);
    const label = await chordGmailLabel(db, userId, mailbox, api, labels, folder);
    if (!label) return false;
    return !!(await applyAccountThreadModify(db, userId, account.id, threadRowId, {
      addLabelIds: [label.id],
      removeLabelIds: ['INBOX'],
    }));
  }
  // Nested folders differ per server (delimiter, parent rules); Gmail is the
  // one place a "/" means something we can rely on.
  if (folder.includes('/')) {
    throw new MailboxWriteUnsupportedError(`nested folders are Gmail-only; "${folder}" was not made here`);
  }
  const create = { create: state === 'new' };
  try {
    let filed: boolean;
    if (account.provider === 'outlook') {
      const { fileOutlookThread } = await import('../email-accounts/outlook.service.js');
      let folderIds = cache?.outlookFolders.get(account.id);
      if (cache && !folderIds) cache.outlookFolders.set(account.id, (folderIds = new Map()));
      filed = !!(await fileOutlookThread(db, account, threadRowId, folder, folderIds, create));
    } else {
      const { fileImapThread } = await import('../email-accounts/imap.service.js');
      filed = !!(await fileImapThread(db, account, threadRowId, folder, cache?.imapSessions.get(account.id), create));
    }
    if (filed && state === 'new') await noteFolderSeen(db, userId, mailbox, folder);
    return filed;
  } catch (err) {
    if (!(err instanceof FolderRemovedError)) throw err;
    await noteFolderRemoved(db, userId, mailbox, folder);
    return false;
  }
}

export interface FilingPassCache {
  gmailLabels: Map<string, GmailLabel[]>;
  outlookFolders: Map<string, Map<string, string>>;
  imapSessions: Map<string, ImapApi>;
}

/**
 * A thread the mailbox refused to file waits before it is tried again,
 * doubling from FILE_RETRY_BASE_MS, and is given up on after
 * FILE_GIVE_UP_AFTER refusals (until the process restarts). Without this a
 * thread that can never be filed (a folder the server refuses, a mailbox that
 * lost its grant) cost a provider round trip - an IMAP login - every sync.
 */
const FILE_RETRY_BASE_MS = 10 * 60_000;
const FILE_RETRY_MAX_MS = 24 * 60 * 60_000;
const FILE_GIVE_UP_AFTER = 6;
/** A mailbox that refuses this many threads in a row is left for the pass. */
const MAILBOX_REFUSALS_PER_PASS = 3;

const fileFailures = new Map<string, { count: number; retryAt: number }>();

function mayTryFiling(key: string, now: number): boolean {
  const f = fileFailures.get(key);
  return !f || (f.count < FILE_GIVE_UP_AFTER && now >= f.retryAt);
}

function recordFilingFailure(key: string, now: number): void {
  const count = (fileFailures.get(key)?.count ?? 0) + 1;
  const wait = Math.min(FILE_RETRY_MAX_MS, FILE_RETRY_BASE_MS * 2 ** (count - 1));
  fileFailures.set(key, { count, retryAt: now + wait });
}

export function __resetFilingFailures(): void {
  fileFailures.clear();
}

/** The after-sync pass: file inbox mail that matches a rule. Returns how many threads moved. */
export async function applyFilingRules(db: Kysely<DB>, userId: string): Promise<number> {
  const rules = await listFilingRules(db, userId);
  if (rules.length === 0) return 0;
  // A sender sent to Trash (ADR 0308) goes there, not to a folder.
  const trashing = new Set((await listAutoTrash(db, userId)).map((r) => r.sender));
  const earliest = rules.reduce((m, r) => Math.min(m, Date.parse(r.since)), Date.now());

  const domainArms = rules
    .filter((r) => r.kind === 'domain')
    .map((r) => sql<boolean>`(lower(t.from_email) like ${`%@${r.value}`} or lower(t.from_email) like ${`%.${r.value}`})`);
  const senders = rules.filter((r) => r.kind === 'sender').map((r) => r.value);
  const arms = [
    ...(senders.length ? [sql<boolean>`lower(t.from_email) in (${sql.join(senders)})`] : []),
    ...domainArms,
  ];

  const rows = await db
    .selectFrom('email_threads as t')
    .select([
      't.id',
      't.account_id',
      't.from_email',
      sql<string>`(extract(epoch from ${textInstant('t.last_message_at')}) * 1000)::bigint`.as('atMs'),
    ])
    .where('t.user_id', '=', userId)
    .where('t.is_archived', '=', 0)
    .where(sql<boolean>`(${sql.join(arms, sql` or `)})`)
    .where(sql<boolean>`not (t.gmail_label_ids @> '["TRASH"]'::jsonb)`)
    .where(sql<boolean>`not (t.gmail_label_ids @> '["SPAM"]'::jsonb)`)
    .where(sql<boolean>`${textInstant('t.last_message_at')} >= ${new Date(earliest).toISOString()}::timestamptz`)
    .orderBy(sql`${textInstant('t.last_message_at')}`, 'desc')
    .limit(PER_PASS * 4)
    .execute();

  const now = Date.now();
  const folders = await loadFolderMemory(db, userId);
  // Grouped by mailbox, so an IMAP mailbox is one login for the whole pass.
  const byMailbox = new Map<string | null, { id: string; folder: string; key: string }[]>();
  for (const r of rows) {
    const from = (r.from_email ?? '').toLowerCase();
    if (!from || trashing.has(from)) continue;
    const rule = ruleFor(rules, from);
    if (!rule || Number(r.atMs) < Date.parse(rule.since)) continue;
    // The user deleted this folder in that mailbox: nothing to file into.
    if (folders.state(mailboxKeyOf(r.account_id), rule.folder) === 'removed') continue;
    // Keyed on the folder too: a rule moved to another folder tries afresh.
    const key = `${userId}|${r.id}|${rule.folder.toLowerCase()}`;
    if (!mayTryFiling(key, now)) continue;
    const list = byMailbox.get(r.account_id ?? null) ?? [];
    list.push({ id: r.id, folder: rule.folder, key });
    byMailbox.set(r.account_id ?? null, list);
  }
  if (byMailbox.size === 0) return 0;

  const cache: FilingPassCache = { gmailLabels: new Map(), outlookFolders: new Map(), imapSessions: new Map() };
  let moved = 0;
  const fileAll = async (items: { id: string; folder: string; key: string }[]) => {
    let refusedInARow = 0;
    for (const it of items) {
      if (moved >= PER_PASS || refusedInARow >= MAILBOX_REFUSALS_PER_PASS) return;
      try {
        if (await fileThreadIntoFolder(db, userId, it.id, it.folder, cache)) moved += 1;
        fileFailures.delete(it.key);
        refusedInARow = 0;
      } catch (err) {
        refusedInARow += 1;
        recordFilingFailure(it.key, now);
        logger.warn('filing rule could not file a thread', {
          userId,
          folder: it.folder,
          err: (err as Error).message,
        });
      }
    }
  };

  const { getAccount } = await import('../email-accounts/account-utils.js');
  for (const [accountId, items] of byMailbox) {
    if (moved >= PER_PASS) break;
    const account = accountId ? await getAccount(db, userId, accountId) : null;
    if (account?.provider === 'imap') {
      const { withAccountSession } = await import('../email-accounts/imap.service.js');
      try {
        await withAccountSession(account, async (api) => {
          cache.imapSessions.set(account.id, api);
          await fileAll(items);
        });
      } catch (err) {
        // The login itself failed: every thread waited on it.
        for (const it of items) recordFilingFailure(it.key, now);
        logger.warn('filing rules could not open the mailbox', { userId, accountId, err: (err as Error).message });
      } finally {
        cache.imapSessions.delete(account.id);
      }
    } else {
      await fileAll(items);
    }
  }
  if (moved) logger.info('filing rules moved mail', { userId, moved });
  return moved;
}
