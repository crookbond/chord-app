/**
 * The email capabilities the app had and chat did not (ADR 0214): compose,
 * forward, undo a queued send, read a whole thread, the briefing's email
 * section, and the per-channel briefing mute.
 *
 * Every write reuses the function its route already calls. Compose and forward
 * go through the SAME draft + outbox path as the app composer (ADR 0113/0115),
 * not a direct provider send, so a bot-sent message gets the undo window and a
 * failed send lands back in Drafts with its error instead of vanishing.
 */
import type { Kysely } from 'kysely';

import { splitQuotedText, type BriefingChannel } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { listBriefingChannels, setBriefingChannelMuted } from '@/services/connectors/briefing-channels.js';
import { getAccount, MailboxWriteUnsupportedError } from '@/services/email-accounts/account-utils.js';
import {
  applyAccountThreadModify,
  getAccountThread,
  threadAccountId,
} from '@/services/email-accounts/accounts.service.js';
import { resolveSendMailbox, sendableMailbox } from '@/services/email/default-mailbox.js';
import { resolveCategoryMatch } from '@/services/email/classification.service.js';
import { findEmailThreads } from '@/services/email/email-search.js';
import { prepareMailQuery, type PersonResolution } from '@/services/email/mail-query.js';
import { mapConcurrent } from '@/utils/concurrency.js';
import { saveDraft } from '@/services/email/drafts.service.js';
import { signedBody } from '@/services/email/signature.js';
import { env } from '@/config/env.js';
import { logger } from '@/config/logging.js';
import {
  cancelQueuedSend,
  flushDueSends,
  queueSend,
  type QueuedSend,
} from '@/services/email/outbox.service.js';
import { applyThreadModify, getThread, hasGmailScope } from '@/services/google/gmail.service.js';
import { bodyForModel, cleanSnippet } from '@/utils/email-text.js';
import { localWhen } from '@/utils/tz.js';

export type QueueOutcome =
  | ({ ok: true } & QueuedSend)
  | { ok: false; reason: 'no_mailbox' | 'thread_not_found' | 'mailbox_unavailable' };

/**
 * Which mailbox a new message goes out from when the user named none: the
 * one they chose in chat while it can still send (ADR 0255), else the primary
 * Gmail when Chord may send from it, else their oldest attached mailbox that
 * does not need reconnecting — the same default the composer opens on.
 */
export async function defaultSendMailbox(
  db: Kysely<DB>,
  userId: string,
): Promise<{ accountId: string | null } | null> {
  const pick = await resolveSendMailbox(db, userId);
  return pick ? { accountId: pick.accountId } : null;
}

/**
 * Queue on the CHAT hold, not the composer's: "unsend that" is typed, and
 * the composer's few seconds are gone before anyone finishes typing it. A
 * hold of 0 sends now rather than relying on a scheduler that may be off.
 */
async function queueChatSend(
  db: Kysely<DB>,
  userId: string,
  draftId: string,
  includeAttachments = true,
): Promise<QueuedSend | null> {
  const queued = await queueSend(db, userId, draftId, {
    includeAttachments,
    holdSeconds: env.EMAIL_CHAT_UNDO_SECONDS,
  });
  if (queued && env.EMAIL_CHAT_UNDO_SECONDS <= 0) await flushDueSends(db);
  return queued;
}

export async function queueComposedEmail(
  db: Kysely<DB>,
  userId: string,
  input: { to: string[]; cc?: string[]; subject: string; body: string; fromMailbox?: string },
): Promise<QueueOutcome> {
  // A card that showed its sender (ADR 0255) sends from exactly that one.
  // If it can no longer send, refuse rather than quietly use another address.
  let mailbox: { accountId: string | null } | null;
  if (input.fromMailbox) {
    mailbox = await sendableMailbox(db, userId, input.fromMailbox);
    if (!mailbox) return { ok: false, reason: 'mailbox_unavailable' };
  } else {
    mailbox = await defaultSendMailbox(db, userId);
  }
  if (!mailbox) return { ok: false, reason: 'no_mailbox' };
  const draft = await saveDraft(db, userId, {
    kind: 'new',
    accountId: mailbox.accountId,
    to: input.to,
    cc: input.cc ?? [],
    subject: input.subject,
    body: await signedBody(db, userId, input.body, mailbox.accountId),
  });
  const queued = await queueChatSend(db, userId, draft.id);
  return queued ? { ok: true, ...queued } : { ok: false, reason: 'no_mailbox' };
}

export async function queueForwardedEmail(
  db: Kysely<DB>,
  userId: string,
  input: {
    threadId: string;
    to: string[];
    cc?: string[];
    note?: string;
    includeAttachments?: boolean;
    /** The message the confirm card showed (ADR 0112 addendum). */
    messageId?: string;
  },
): Promise<QueueOutcome> {
  const owned = await db
    .selectFrom('email_threads')
    .select('id')
    .where('id', '=', input.threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!owned) return { ok: false, reason: 'thread_not_found' };
  const accountId = await threadAccountId(db, userId, input.threadId);
  if (!accountId && !(await hasGmailScope(db, userId))) return { ok: false, reason: 'no_mailbox' };
  const draft = await saveDraft(db, userId, {
    kind: 'forward',
    threadId: input.threadId,
    accountId,
    to: input.to,
    cc: input.cc ?? [],
    body: await signedBody(db, userId, input.note ?? '', accountId),
    forwardMessageId: input.messageId ?? null,
  });
  const queued = await queueChatSend(db, userId, draft.id, input.includeAttachments !== false);
  return queued ? { ok: true, ...queued } : { ok: false, reason: 'thread_not_found' };
}

/**
 * Undo the user's most recently queued message. Chat cannot name a draft id
 * (tool results do not survive a turn — ADR 0093), and the only message anyone
 * means by "unsend that" is the last one. False = nothing is waiting, i.e. it
 * already went: the honest answer to a request that lost the race.
 */
export async function cancelLatestQueuedSend(
  db: Kysely<DB>,
  userId: string,
): Promise<{ cancelled: true; subject: string; to: string[] } | { cancelled: false }> {
  const row = await db
    .selectFrom('email_drafts')
    .select(['id', 'subject', 'to_emails'])
    .where('user_id', '=', userId)
    .where('send_after', 'is not', null)
    .orderBy('send_after', 'desc')
    .executeTakeFirst();
  if (!row) return { cancelled: false };
  if (!(await cancelQueuedSend(db, userId, row.id))) return { cancelled: false };
  return { cancelled: true, subject: row.subject, to: row.to_emails };
}

/** Enough of a message body to answer from, not the whole of a newsletter. */
const BODY_CAP = 4000;

export interface ReadThreadResult {
  subject: string;
  messageCount: number;
  messages: {
    from: string;
    date: string;
    /** `date` in the user's own zone with the weekday — what to quote. */
    when: string;
    body: string;
    truncated: boolean;
    attachments: string[];
    /** ADR 0294 — what Chord's sender checks found (caution/danger only). */
    senderWarnings?: string[];
    /** The receiving mail server confirmed the sender's domain. */
    senderDomainVerified?: boolean;
  }[];
}

/**
 * The newest `max` messages of one thread, quoted history folded away (each
 * message would otherwise repeat every earlier one — ADR 0121). Read-only: it
 * does not mark the thread read (the bot reading is not the user reading, ADR
 * 0124's reasoning) and does not run the read-time pass (ADR 0180), which is
 * about the user having the message open.
 */
export async function readEmailThread(
  db: Kysely<DB>,
  userId: string,
  threadId: string,
  max = 5,
  tz?: string | null,
): Promise<ReadThreadResult | null> {
  const accountId = await threadAccountId(db, userId, threadId);
  const detail = accountId
    ? await getAccountThread(db, userId, accountId, threadId)
    : await getThread(db, userId, threadId);
  if (!detail) return null;
  const newest = detail.messages.slice(-Math.max(1, max));
  return {
    subject: detail.thread.subject,
    messageCount: detail.messages.length,
    messages: newest.map((m) => {
      const raw = bodyForModel({ html: m.bodyHtml, text: m.bodyText });
      const visible = splitQuotedText(raw || cleanSnippet(m.snippet)).visible.trim();
      return {
        from: m.fromName ? `${m.fromName} <${m.fromEmail ?? ''}>` : (m.fromEmail ?? ''),
        date: m.internalDate,
        when: localWhen(m.internalDate, tz),
        body: visible.slice(0, BODY_CAP),
        truncated: visible.length > BODY_CAP,
        attachments: (m.attachments ?? []).map((a) => a.filename).filter(Boolean),
        ...(m.senderCheck
          ? {
              senderWarnings: m.senderCheck.signals.filter((s) => s.level !== 'info').map((s) => s.message),
              senderDomainVerified: m.senderCheck.verifiedDomain,
            }
          : {}),
      };
    }),
  };
}

export type ChannelOutcome =
  | { ok: true; channel: BriefingChannel }
  | { ok: false; reason: 'no_channels' | 'ambiguous'; channels: BriefingChannel[] };

/**
 * Mute or resume the briefing on one WhatsApp channel (ADR 0091). The user
 * names the chat by its group name; with a single channel there is nothing to
 * name. Several and no name, or a name matching several → the list comes
 * back so the bot asks (exact-name-or-ask, ADR 0077/0094).
 */
export async function setBriefingChannelByName(
  db: Kysely<DB>,
  userId: string,
  muted: boolean,
  groupName?: string,
): Promise<ChannelOutcome> {
  const channels = await listBriefingChannels(db, userId);
  if (channels.length === 0) return { ok: false, reason: 'no_channels', channels };
  const wanted = groupName?.trim().toLowerCase();
  const matches = wanted
    ? channels.filter((c) => c.groupName.toLowerCase() === wanted)
    : channels;
  if (matches.length !== 1) return { ok: false, reason: 'ambiguous', channels };
  const outcome = await setBriefingChannelMuted(db, userId, matches[0].id, muted);
  if (outcome === 'not_found') return { ok: false, reason: 'ambiguous', channels };
  return { ok: true, channel: { ...matches[0], optedOut: muted } };
}

export type TrashOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_connected' | 'refused'; message?: string };

/**
 * ADR 0215 — move one thread to its mailbox's Trash, through the same service
 * functions as the swipe. A mailbox that cannot do it (IMAP with no Trash
 * folder, archived IMAP mail) says so in words the user can act on; anything
 * else throws, and the executor tells the model it failed without the raw
 * error (ADR 0102).
 */
export async function trashEmailThread(
  db: Kysely<DB>,
  userId: string,
  threadId: string,
): Promise<TrashOutcome> {
  const accountId = await threadAccountId(db, userId, threadId);
  if (!accountId && !(await hasGmailScope(db, userId))) {
    return { ok: false, reason: 'not_connected' };
  }
  try {
    const summary = accountId
      ? await applyAccountThreadModify(db, userId, accountId, threadId, { trash: true })
      : await applyThreadModify(db, userId, threadId, { trash: true });
    return summary ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch (err) {
    if (err instanceof MailboxWriteUnsupportedError) {
      return { ok: false, reason: 'refused', message: err.message };
    }
    throw err;
  }
}

export type EmailChange = {
  markRead?: boolean;
  archive?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
};

export type EmailChangeOutcome =
  | { threadId: string; ok: true; subject: string; isUnread: boolean; isArchived: boolean; labels: string[] }
  | { threadId: string; ok: false; reason: 'not_found' | 'not_connected' | 'refused' | 'failed'; message?: string };

/**
 * Read state, archive and Chord labels (ADR 0141) for one or more threads,
 * through the same service functions as the Email tab's swipe and label sheet.
 * Each thread succeeds or fails on its own, so the reply can name exactly which
 * ones changed. Chord labels never touch the provider, so they work on a
 * primary Gmail whose grant has lapsed; read and archive do not.
 */
export async function changeEmailThreads(
  db: Kysely<DB>,
  userId: string,
  threadIds: string[],
  change: EmailChange,
): Promise<EmailChangeOutcome[]> {
  const patch = {
    ...(change.markRead !== undefined ? { markRead: change.markRead } : {}),
    ...(change.archive !== undefined ? { archive: change.archive } : {}),
    ...(change.addLabels?.length ? { addChordLabels: change.addLabels } : {}),
    ...(change.removeLabels?.length ? { removeChordLabels: change.removeLabels } : {}),
  };
  const needsProvider = change.markRead !== undefined || change.archive !== undefined;
  const gmailOk = needsProvider ? await hasGmailScope(db, userId) : true;
  const ids = [...new Set(threadIds)];
  const outcome = new Map<string, EmailChangeOutcome>();
  // Still one write per thread, but not one after another (the app's bulk
  // select does the same, ADR 0128): mailboxes side by side, a few at a time
  // within one, and IMAP one at a time because each write is a login (ADR 0080).
  const byMailbox = new Map<string, string[]>();
  for (const threadId of ids) {
    const accountId = (await threadAccountId(db, userId, threadId)) ?? '';
    byMailbox.set(accountId, [...(byMailbox.get(accountId) ?? []), threadId]);
  }
  await Promise.all(
    [...byMailbox.entries()].map(async ([accountId, group]) => {
      const account = accountId ? await getAccount(db, userId, accountId) : undefined;
      await mapConcurrent(group, account?.provider === 'imap' ? 1 : CHANGE_CONCURRENCY, async (threadId) => {
        if (!accountId && !gmailOk) {
          outcome.set(threadId, { threadId, ok: false, reason: 'not_connected' });
          return;
        }
        try {
          const summary = accountId
            ? await applyAccountThreadModify(db, userId, accountId, threadId, patch)
            : await applyThreadModify(db, userId, threadId, patch);
          outcome.set(
            threadId,
            summary
              ? {
                  threadId,
                  ok: true,
                  subject: summary.subject,
                  isUnread: summary.isUnread,
                  isArchived: summary.isArchived,
                  labels: summary.chordLabelIds ?? [],
                }
              : { threadId, ok: false, reason: 'not_found' },
          );
        } catch (err) {
          if (err instanceof MailboxWriteUnsupportedError) {
            outcome.set(threadId, { threadId, ok: false, reason: 'refused', message: err.message });
          } else {
            logger.warn('bot email change failed', { userId, threadId, err: (err as Error).message });
            outcome.set(threadId, { threadId, ok: false, reason: 'failed' });
          }
        }
      });
    }),
  );
  return ids.map((id) => outcome.get(id)!);
}

const CHANGE_CONCURRENCY = 4;

/** Emails one confirm may change. Past it the card says how many were left out. */
export const MAX_EMAILS_PER_CHANGE = 500;

export interface EmailMatchFilter {
  /** A person, address or domain, resolved the way chat search resolves it (ADR 0270). */
  from?: string;
  /** A topic: one of the user's own categories ("school") when it names one, else words. */
  about?: string;
  hasAttachment?: boolean;
  /** Instants, inclusive. */
  after?: string;
  before?: string;
  /** A Chord or provider label (ADR 0125/0141). */
  label?: string;
  unreadOnly?: boolean;
  /** Every email, with no other filter. Without it a filter is required. */
  all?: boolean;
}

export type EmailMatchOutcome =
  | {
      ok: true;
      threadIds: string[];
      truncated: boolean;
      samples: { subject: string; from: string | null }[];
      /** The categories `about` was read as, when it named some. */
      categories: string[];
    }
  | { ok: false; reason: 'no_filter' }
  | { ok: false; reason: 'ambiguous'; people: PersonResolution[] };

/**
 * The emails a sentence like "mark everything from the school read" means,
 * found with the same preparation chat search uses, so the set the user
 * confirms is the set search would show. Two differences, both because this
 * set gets WRITTEN to: a topic that names one of the user's categories means
 * that category only (ADR 0152's replace, not ADR 0271's add - a promo that
 * mentions "school" in its body is not school mail), and nothing is matched
 * by meaning (ADR 0276 ranks; it does not decide membership).
 */
export async function findEmailsForChange(
  db: Kysely<DB>,
  userId: string,
  filter: EmailMatchFilter,
): Promise<EmailMatchOutcome> {
  const about = filter.about?.trim() ?? '';
  const narrowed =
    !!filter.from?.trim() || !!about || !!filter.hasAttachment || !!filter.after || !!filter.before || !!filter.label?.trim();
  if (!narrowed && !filter.all) return { ok: false, reason: 'no_filter' };

  const mail = await prepareMailQuery(db, userId, about, {
    from: filter.from?.trim() || undefined,
    hasAttachment: filter.hasAttachment,
    after: filter.after,
    before: filter.before,
  });
  if (mail.blocked) {
    return { ok: false, reason: 'ambiguous', people: mail.people.filter((p) => p.status !== 'resolved') };
  }
  const topic = mail.find.text.toLowerCase().trim();
  const category = topic ? await resolveCategoryMatch(db, userId, topic) : null;
  const rows = await findEmailThreads(db, {
    ...mail.find,
    text: category ? '' : mail.find.text,
    label: filter.label?.trim() || mail.find.label,
    unread: filter.unreadOnly || undefined,
    userId,
    categoryIds: category?.categoryIds ?? null,
    limit: MAX_EMAILS_PER_CHANGE + 1,
    order: 'recent',
  });
  const kept = rows.slice(0, MAX_EMAILS_PER_CHANGE);
  return {
    ok: true,
    threadIds: kept.map((r) => r.id),
    truncated: rows.length > MAX_EMAILS_PER_CHANGE,
    samples: kept.slice(0, 3).map((r) => ({ subject: r.subject || '(no subject)', from: r.fromName ?? r.fromEmail })),
    categories: category?.titles ?? [],
  };
}

export async function setEmailDigestEnabled(
  db: Kysely<DB>,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .updateTable('users')
    .set({ email_digest_enabled: enabled ? 1 : 0 })
    .where('id', '=', userId)
    .execute();
}
