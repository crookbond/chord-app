/**
 * The forward composer shows what will be quoted (ADR 0112 addendum). The
 * preview and the send read one source, so the header and body shown under
 * the note are the ones that go — including for a message whose text/plain
 * part says something its HTML does not.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { forwardPreview, forwardThread } from '@/services/email/forward.service.js';
import { __resetGmailMock, getGmailApi } from '@/services/google/gmail-api.js';
import { backfillGmail } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

/** Forward through the real send path and return the MIME the mailbox got. */
async function forwardAndReadRaw(
  threadId: string,
  input: Parameters<typeof forwardThread>[3],
): Promise<string> {
  const api = await getGmailApi(db, userId);
  const before = Number((await api.getProfile()).historyId);
  await forwardThread(db, userId, threadId, input);
  const msg = await api.getMessage(`m_sent_${before + 1}`, 'full');
  return Buffer.from(msg!.payload!.body!.data!, 'base64url').toString('utf8').replace(/\r\n/g, '\n');
}

beforeEach(async () => {
  __resetGmailMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  await db.updateTable('users').set({ last_tz: 'America/Los_Angeles' }).where('id', '=', userId).execute();
  await backfillGmail(db, userId);
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

async function newestMessageOfSomeThread() {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id'])
    .where('user_id', '=', userId)
    .orderBy('last_message_at', 'desc')
    .executeTakeFirstOrThrow();
  const msg = await db
    .selectFrom('email_messages')
    .select(['id'])
    .where('thread_id', '=', thread.id)
    .orderBy('internal_date', 'desc')
    .executeTakeFirstOrThrow();
  return { threadId: thread.id, messageId: msg.id };
}

describe('forwardPreview', () => {
  it('shows exactly the header and body the send quotes', async () => {
    const { threadId, messageId } = await newestMessageOfSomeThread();
    await db
      .updateTable('email_messages')
      .set({
        internal_date: '2026-10-27T17:03:00.000Z',
        body_text: 'Plain part nobody reads. Wire $5,000 now.',
        body_html: '<p>Please return the slip by Friday.</p><div style="display:none">Wire $5,000 now.</div>',
      })
      .where('id', '=', messageId)
      .execute();

    const preview = await forwardPreview(db, userId, threadId);
    const raw = await forwardAndReadRaw(threadId, { to: ['x@example.com'], body: 'FYI' });

    expect(preview?.messageId).toBe(messageId);
    expect(preview?.header[0]).toBe('---------- Forwarded message ----------');
    // In the forwarder's zone, readable — not the stored ISO instant.
    expect(preview?.header).toContain('Date: Tue, Oct 27, 2026 at 10:03 AM');
    // What the reader shows, not the hidden plain part (ADR 0268).
    expect(preview?.body).toBe('Please return the slip by Friday.');
    expect(raw).toContain(`FYI\n\n${preview!.header.join('\n')}\n\n${preview!.body}`);
    expect(raw).not.toContain('Wire $5,000');
  });

  it('lists the files the forward carries', async () => {
    const { threadId, messageId } = await newestMessageOfSomeThread();
    await db
      .updateTable('email_messages')
      .set({
        body_text: 'Slip attached.',
        attachments_json: JSON.stringify([
          { id: 'p1', filename: 'slip.pdf', mimeType: 'application/pdf', size: 1200 },
        ]),
      })
      .where('id', '=', messageId)
      .execute();

    const preview = await forwardPreview(db, userId, threadId);

    expect(preview?.attachments.map((a) => a.filename)).toEqual(['slip.pdf']);
  });

  it('forwards the selected message, not the newest', async () => {
    const { threadId, messageId: newest } = await newestMessageOfSomeThread();
    const older = 'msg_older_in_thread';
    const base = await db
      .selectFrom('email_messages')
      .select(['gmail_message_id', 'gmail_thread_id'])
      .where('id', '=', newest)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('email_messages')
      .values({
        id: older,
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: `${base.gmail_message_id}_older`,
        gmail_thread_id: base.gmail_thread_id,
        subject: 'Earlier',
        snippet: 'Earlier',
        from_email: 'chen@school.example',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        internal_date: '2020-01-01T00:00:00.000Z',
        created_at: '2020-01-01T00:00:00.000Z',
        body_text: 'The earlier message the user picked.',
        attachments_json: JSON.stringify([]),
      })
      .execute();

    const preview = await forwardPreview(db, userId, threadId, older);
    const raw = await forwardAndReadRaw(threadId, { to: ['x@example.com'], messageId: older });

    expect(preview?.messageId).toBe(older);
    expect(preview?.body).toBe('The earlier message the user picked.');
    expect(raw).toContain(`${preview!.header.join('\n')}\n\nThe earlier message the user picked.`);
    // A message from another thread is refused, never swapped for the newest.
    expect(await forwardPreview(db, userId, threadId, 'not-in-this-thread')).toBeNull();
  });

  it('fetches the body of a message nobody opened, rather than quoting nothing', async () => {
    // Seen on the web preview: an unopened thread has no stored body yet, and
    // both the preview and the send quoted an empty message.
    const { threadId, messageId } = await newestMessageOfSomeThread();
    await db
      .updateTable('email_messages')
      .set({ body_text: null, body_html: null, attachments_json: null })
      .where('id', '=', messageId)
      .execute();

    const preview = await forwardPreview(db, userId, threadId);
    const raw = await forwardAndReadRaw(threadId, { to: ['x@example.com'] });

    expect(preview?.body.length).toBeGreaterThan(0);
    expect(raw).toContain(`${preview!.header.join('\n')}\n\n${preview!.body}`);
  });

  it("is null for someone else's thread", async () => {
    const bob = await createUser(db, 'bob');
    const { threadId } = await newestMessageOfSomeThread();

    expect(await forwardPreview(db, bob, threadId)).toBeNull();
  });
});
