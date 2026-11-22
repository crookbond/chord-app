/**
 * ADR 0234 — putting something of the user's into a group they belong to: a
 * line of text, or an email thread. A tap in the app ("Share to family chat")
 * is the user's own deliberate act and posts at once; the bot's tools stage a
 * card first and post only on the asker's tap (ADR 0234 addendum), since a
 * wrong post is in front of the whole family and deleting it hides it for the
 * poster alone (ADR 0242). Both guard who may be posted to — a group the user
 * is in, never one they only know the name of.
 *
 * An email is shared as text: sender, date, subject and the newest message's
 * body trimmed to a screenful. The mailbox itself is not shared and neither
 * are attachments (their names are listed, so the recipient knows to ask) —
 * the family sees what the user chose to put in front of them, and no more.
 */
import type { Kysely } from 'kysely';

import type { Message } from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { readEmailThread } from './bot/email-actions.js';
import { isMember } from './groups.service.js';
import { postMessage } from './messages.service.js';

/** Enough of the newest message to read the point, not the whole of it. */
const SHARE_BODY_CAP = 1500;

/** How far back a pinned message is looked for. */
const PINNED_LOOKBACK = 50;

export type ShareFailure = 'not_member' | 'thread_not_found';
export type ShareResult = { ok: true; message: Message } | { ok: false; reason: ShareFailure };

export async function postToGroup(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
  body: string,
): Promise<ShareResult> {
  if (!(await isMember(db, groupId, userId))) return { ok: false, reason: 'not_member' };
  const message = await postMessage(db, { groupId, senderId: userId, body: body.trim(), mentionsBot: false });
  return { ok: true, message };
}

export async function shareEmailThreadToGroup(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
  threadId: string,
  opts: {
    note?: string;
    tz?: string | null;
    /** The message a confirm card showed (its date). That one is shared, not
     *  whatever arrived since; gone = `thread_not_found`. */
    messageDate?: string;
  } = {},
): Promise<ShareResult> {
  if (!(await isMember(db, groupId, userId))) return { ok: false, reason: 'not_member' };
  const thread = await readEmailThread(db, userId, threadId, opts.messageDate ? PINNED_LOOKBACK : 1, opts.tz);
  const latest = opts.messageDate
    ? thread?.messages.find((m) => m.date === opts.messageDate)
    : thread?.messages[thread.messages.length - 1];
  if (!thread || !latest) return { ok: false, reason: 'thread_not_found' };

  const excerpt = latest.body.slice(0, SHARE_BODY_CAP);
  const lines = [
    ...(opts.note?.trim() ? [opts.note.trim(), ''] : []),
    `Shared an email: ${thread.subject || '(no subject)'}`,
    `From ${latest.from}${latest.when ? ` · ${latest.when}` : ''}`,
    '',
    excerpt + (latest.body.length > SHARE_BODY_CAP || latest.truncated ? ' …' : ''),
    ...(latest.attachments.length > 0 ? ['', `Attachments (not included): ${latest.attachments.join(', ')}`] : []),
  ];
  const message = await postMessage(db, {
    groupId,
    senderId: userId,
    body: lines.join('\n'),
    mentionsBot: false,
  });
  return { ok: true, message };
}

/**
 * What a confirm card shows of the email it will share: the newest message, as
 * `shareEmailThreadToGroup` would post it. Null = not the user's thread.
 */
export async function emailSharePreview(
  db: Kysely<DB>,
  userId: string,
  threadId: string,
  tz?: string | null,
): Promise<{ subject: string; from: string; when?: string; date: string; body: string; files: string[] } | null> {
  const thread = await readEmailThread(db, userId, threadId, 1, tz);
  const latest = thread?.messages[thread.messages.length - 1];
  if (!thread || !latest) return null;
  const flat = latest.body.replace(/\s+/g, ' ').trim();
  return {
    subject: thread.subject || '(no subject)',
    from: latest.from,
    ...(latest.when ? { when: latest.when } : {}),
    date: latest.date,
    body: flat.length > 280 ? `${flat.slice(0, 279)}…` : flat,
    files: latest.attachments.slice(0, 20),
  };
}
