/**
 * The whole message, when the excerpt was not enough (ADR 0110).
 *
 * Sync keeps a bounded `body_excerpt` because 2,000 characters settles almost
 * every email. Almost: a BitGo invoice puts the amount below the cut, and an
 * Expedia itinerary puts the dates there. This is the escalation path, and it
 * is deliberately a separate call rather than a bigger cap — the cost then
 * follows the mail that needs it instead of the mail that does not.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { bodyForModel, modelBodyText } from '../../utils/email-text.js';
import { getGmailApi } from '../google/gmail-api.js';
import { extractBodies } from '../google/gmail-sync.js';
import { getAccount, nativeId } from './account-utils.js';
import { gmailAccountApi } from './gmail-account.service.js';
import { getOutlookApi } from './outlook-api.js';

/**
 * Full readable text of one mirrored message, or null when the provider has
 * nothing more to give than what is already stored.
 *
 * IMAP is absent on purpose: it parses the entire source at sync, so its stored
 * `body_text` already IS the full message and a second login would buy nothing
 * (ADR 0080 — every `ImapApi` call opens its own connection).
 */
export async function fetchFullBodyText(
  db: Kysely<DB>,
  userId: string,
  messageRowId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('email_messages')
    .select(['id', 'account_id', 'gmail_message_id', 'body_text', 'body_html'])
    .where('id', '=', messageRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;

  // A thread the user opened already has the whole body mirrored.
  const stored = bodyForModel({ html: row.body_html, text: row.body_text });
  if (stored) return stored;

  if (!row.account_id) {
    const api = await getGmailApi(db, userId);
    const raw = await api.getMessage(row.gmail_message_id, 'full');
    if (!raw) return null;
    const bodies = extractBodies(raw.payload);
    return modelBodyText(bodies) || null;
  }

  const account = await getAccount(db, userId, row.account_id);
  if (!account) return null;
  const native = nativeId(account.id, row.gmail_message_id);

  if (account.provider === 'gmail') {
    const api = await gmailAccountApi(db, account);
    const raw = await api.getMessage(native, 'full');
    if (!raw) return null;
    const bodies = extractBodies(raw.payload);
    return modelBodyText(bodies) || null;
  }
  if (account.provider === 'outlook') {
    const api = await getOutlookApi(db, account);
    const raw = await api.getMessage(native);
    const content = raw?.body?.content;
    if (!content) return null;
    const text = raw.body?.contentType === 'html' ? modelBodyText({ html: content }) : modelBodyText({ text: content });
    return text || null;
  }
  return null;
}
