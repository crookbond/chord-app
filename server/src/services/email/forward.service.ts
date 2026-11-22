/**
 * Forwarding a thread onward (ADR 0112).
 *
 * A sibling of reply, not a variant of it. Reply answers the people already in
 * the conversation; a forward starts a new one with people who were never in
 * it, which is why it carries no threading headers and quotes the original
 * rather than appending to it.
 *
 * The whole reason this waited for ADR 0111: a forward that arrives without
 * the attachment the sender meant to pass on has failed in the one way the
 * sender cannot see.
 */
import type { Kysely } from 'kysely';
import {
  buildForwardBody,
  forwardDateLabel,
  forwardHeaderLines,
  forwardQuote,
  type EmailAttachmentRef,
  type EmailForwardPreview,
  type ForwardOriginal,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { bodyForModel } from '../../utils/email-text.js';
import { fetchEmailAttachmentData } from '../email-accounts/attachment-fetch.js';
import {
  getAccountThread,
  providerFor,
  sendAccountNew,
  threadAccountId,
} from '../email-accounts/accounts.service.js';
import { textToHtml } from '../google/gmail-sync.js';
import { getThread, sendNewMessage } from '../google/gmail.service.js';
import {
  AttachmentRejected,
  checkOutgoingSize,
  loadOutgoingAttachments,
  type OutgoingAttachment,
} from './outgoing-attachments.js';

/** Exactly one leading "Fwd: ", mirroring `replySubject`. */
export function forwardSubject(subject: string): string {
  const bare = subject.replace(/^(\s*(re|fwd|fw):\s*)+/i, '').trim();
  return `Fwd: ${bare}`;
}

/**
 * The message a forward quotes, read once for both the preview and the send
 * (ADR 0112 addendum): the one selected in the reader, else the newest; its
 * visible text (the reader shows the HTML, so a text/plain part that says
 * something else would pass on words the sender never saw, ADR 0268); and a
 * date in the forwarder's zone. A `messageId` not in this thread is null, not
 * a silent fallback to another message.
 */
async function loadForwardSource(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  messageId?: string,
) {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'subject'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!thread) return null;

  const readMessage = () =>
    db
      .selectFrom('email_messages')
      .select([
        'id',
        'from_name',
        'from_email',
        'to_emails',
        'subject',
        'body_text',
        'body_html',
        'internal_date',
        'attachments_json',
      ])
      .where('thread_id', '=', threadRowId)
      .where('user_id', '=', userId)
      .$if(!!messageId, (q) => q.where('id', '=', messageId!))
      .orderBy('internal_date', 'desc')
      .limit(1)
      .executeTakeFirst();
  let latest = await readMessage();
  if (!latest) return null;
  // A body nobody has opened may not be stored yet (or its part list not
  // read); fetch it the way opening the thread does, or the forward quotes
  // nothing and carries no files.
  if ((latest.body_text === null && latest.body_html === null) || latest.attachments_json === null) {
    const accountId = await threadAccountId(db, userId, threadRowId);
    await (accountId
      ? getAccountThread(db, userId, accountId, threadRowId)
      : getThread(db, userId, threadRowId));
    latest = await readMessage();
    if (!latest) return null;
  }

  const user = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  const original: ForwardOriginal = {
    fromName: latest.from_name,
    fromEmail: latest.from_email,
    date: forwardDateLabel(latest.internal_date, user?.last_tz || env.BRIEFING_DEFAULT_TZ),
    subject: latest.subject,
    to: Array.isArray(latest.to_emails) ? latest.to_emails : [],
    body: bodyForModel({ html: latest.body_html, text: latest.body_text }),
  };
  const parts: EmailAttachmentRef[] = Array.isArray(latest.attachments_json)
    ? latest.attachments_json
    : [];
  return { thread, latest, original, parts };
}

/** The forward's body and subject as the send would build them, for a copy
 *  of the draft kept elsewhere (the mailbox's Drafts folder, ADR 0303). */
export async function forwardDraftContent(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  note: string,
  messageId?: string,
): Promise<{ subject: string; body: string } | null> {
  const src = await loadForwardSource(db, userId, threadRowId, messageId);
  if (!src) return null;
  return {
    subject: forwardSubject(src.thread.subject || src.latest.subject || ''),
    body: buildForwardBody(note, src.original),
  };
}

/** What the forward composer shows under the note: exactly what will be quoted. */
export async function forwardPreview(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  messageId?: string,
): Promise<EmailForwardPreview | null> {
  const src = await loadForwardSource(db, userId, threadRowId, messageId);
  if (!src) return null;
  return {
    messageId: src.latest.id,
    header: forwardHeaderLines(src.original),
    body: src.original.body ?? '',
    attachments: src.parts,
    accountId: await threadAccountId(db, userId, threadRowId),
    originalIsHtml: !!src.latest.body_html?.trim(),
  };
}

/**
 * Forward a message in a thread: the one selected in the reader (the message
 * opened last, which the reply bar answers too), else the newest. "Forward
 * this email" means the thing the user is looking at (ADR 0112 addendum).
 */
export async function forwardThread(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  input: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    body?: string;
    includeAttachments?: boolean;
    attachmentIds?: string[];
    messageId?: string;
    format?: 'plain' | 'rich';
    bodyHtml?: string | null;
  },
): Promise<{ fromEmail: string } | null> {
  const src = await loadForwardSource(db, userId, threadRowId, input.messageId);
  if (!src) return null;
  const { thread, latest, original } = src;

  const accountId = await threadAccountId(db, userId, threadRowId);
  const provider = await providerFor(db, userId, accountId);

  // The sender's own files first, so their size refusal names them rather than
  // an attachment they never chose.
  const mine = await loadOutgoingAttachments(db, userId, input.attachmentIds, provider);

  let carried: OutgoingAttachment[] = [];
  if (input.includeAttachments !== false) {
    const parts = src.parts;
    // Bounded at 5 concurrent fetches — a forward rarely carries many
    // attachments, this is interactive (the sender is waiting), and going
    // higher risks the provider's own rate limits. Any part that fails still
    // aborts the whole forward (thrown, not collected) — `includeAttachments:
    // false` is the sender's way to send without them.
    carried = await mapConcurrent(parts, 5, async (part) => {
      // Both failure shapes land here on purpose: the fetcher returns null for
      // a part it cannot address and THROWS when the provider 404s it, and a
      // raw provider error reaching the route would be a 500 where the sender
      // needs a sentence (ADR 0102).
      let data: Awaited<ReturnType<typeof fetchEmailAttachmentData>> = null;
      try {
        data = await fetchEmailAttachmentData(db, userId, latest.id, part.id);
      } catch (err) {
        logger.warn('forward: attachment fetch failed', {
          userId,
          part: part.id,
          err: (err as Error).message,
        });
      }
      if (!data) {
        throw new AttachmentRejected(
          `"${part.filename}" could not be fetched from the mailbox, so nothing was sent.`,
        );
      }
      return {
        filename: data.filename,
        mimeType: data.mimeType,
        content: data.buffer,
      };
    });
  }

  const attachments = [...mine, ...carried];
  checkOutgoingSize(attachments, provider);

  const message = {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: forwardSubject(thread.subject || latest.subject || ''),
    body: buildForwardBody(input.body, original),
    // ADR 0339: a rich note keeps its formatting above the forwarded email,
    // which goes as escaped text either way (ADR 0112).
    format: input.format,
    bodyHtml:
      input.format === 'rich' && input.bodyHtml?.trim()
        ? `${input.bodyHtml}<br>${textToHtml(forwardQuote(original))}`
        : undefined,
    attachments,
  };

  return accountId
    ? sendAccountNew(db, userId, accountId, message)
    : sendNewMessage(db, userId, message);
}
