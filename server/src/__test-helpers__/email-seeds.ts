/**
 * Two ways to put a message in a mailbox for a test.
 *
 * `seedPlainMail` inserts rows directly, exactly as every mail test written
 * before content encryption did: plaintext columns, no blind index. It stands
 * for a mailbox that predates the feature.
 *
 * `seedSyncedMail` goes through the same two functions every provider's sync
 * goes through (`upsertMessageMeta`, `recomputeThread`), so what it stores is
 * what production stores: sealed when `CONTENT_ENCRYPTION` is on, and always
 * blind-indexed.
 */
import type { Kysely } from 'kysely';

import type { DB } from '@/db/schema.js';
import type { NormalizedMessage } from '@/services/google/gmail-sync.js';
import { ensureThreadRow, recomputeThread, upsertMessageMeta } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';

export interface SeedMailOpts {
  subject: string;
  snippet?: string;
  fromName?: string | null;
  fromEmail?: string;
  body?: string | null;
  labels?: string[];
  at?: string;
  attachments?: Array<{ id: string; filename: string; mimeType: string; size: number }>;
  html?: string | null;
  ics?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  /** Add this message to an existing provider thread rather than starting one. */
  gmailThreadId?: string;
}

export async function seedPlainMail(db: Kysely<DB>, owner: string, opts: SeedMailOpts): Promise<string> {
  const id = newId('emt');
  const gid = newId('gt');
  const at = opts.at ?? new Date().toISOString();
  const fromEmail = opts.fromEmail ?? 'noreply@example.test';
  const snippet = opts.snippet ?? '';
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: owner,
      gmail_thread_id: gid,
      subject: opts.subject,
      snippet,
      from_email: fromEmail,
      from_name: opts.fromName ?? null,
      gmail_label_ids: JSON.stringify(opts.labels ?? ['INBOX']),
      last_message_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: owner,
      thread_id: id,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: opts.subject,
      snippet,
      from_email: fromEmail,
      from_name: opts.fromName ?? null,
      body_text: opts.body ?? null,
      body_html: opts.html ?? null,
      attachments_json: opts.attachments ? JSON.stringify(opts.attachments) : '[]',
      ics_text: opts.ics ?? '',
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      internal_date: at,
      created_at: at,
    })
    .execute();
  return id;
}

export function normalizedFrom(opts: SeedMailOpts, gid: string, at: string): NormalizedMessage {
  return {
    gmailMessageId: newId('gm'),
    gmailThreadId: gid,
    fromName: opts.fromName ?? null,
    fromEmail: opts.fromEmail ?? 'noreply@example.test',
    toEmails: opts.toEmails ?? [],
    ccEmails: opts.ccEmails ?? [],
    subject: opts.subject,
    snippet: opts.snippet ?? '',
    bodyText: opts.body ?? null,
    bodyHtml: opts.html ?? null,
    internalDate: at,
    isUnread: false,
    labelIds: opts.labels ?? ['INBOX'],
    rfc822MessageId: null,
    headers: { references: null, inReplyTo: null, date: null },
    attachmentsJson: opts.attachments ? JSON.stringify(opts.attachments) : '[]',
    icsText: opts.ics ?? '',
  };
}

export async function seedSyncedMail(db: Kysely<DB>, owner: string, opts: SeedMailOpts): Promise<string> {
  const gid = opts.gmailThreadId ?? newId('gt');
  const at = opts.at ?? new Date().toISOString();
  const threadRowId = await ensureThreadRow(db, owner, gid, at);
  await upsertMessageMeta(db, owner, threadRowId, normalizedFrom(opts, gid, at), at);
  await recomputeThread(db, owner, gid);
  return threadRowId;
}
