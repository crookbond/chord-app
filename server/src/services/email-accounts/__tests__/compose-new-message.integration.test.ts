/**
 * Compose (ADR 0107). Outbound used to be reply-only on all four providers —
 * every send function required an existing thread row — so Chord could answer
 * mail but never start a conversation.
 *
 * What matters per provider is that the message actually leaves, and that it
 * leaves as a NEW message rather than a reply: no threading headers, and no
 * "Re:" bolted onto a subject the user typed.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  connectGmailAccount,
  connectImapAccount,
  connectOutlookAccount,
  sendAccountNew,
} from '@/services/email-accounts/accounts.service.js';
import { __outlookMockSentCount, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { __imapMockSentCount, __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import {
  backfillGmail,
  getThread,
  listThreads,
  sendNewMessage,
} from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('compose a new message', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    __resetGmailMock();
    __resetOutlookMock();
    __resetImapMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'compose-user');
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
    await closeTestDb(db);
  });

  it('sends from the primary Gmail without an existing thread', async () => {
    const before = (await listThreads(db, userId, {})).length;
    const out = await sendNewMessage(db, userId, {
      to: ['neighbour@example.com'],
      subject: 'Borrowing the ladder',
      body: 'Could we borrow your ladder on Saturday?',
    });
    expect(out.fromEmail).toBeTruthy();

    // Nothing is written to the mirror on the way out — the provider is the
    // truth, and the sent copy arrives on the next sync like any other message.
    expect((await listThreads(db, userId, {})).length).toBe(before);

    await backfillGmail(db, userId);
    const sent = await db
      .selectFrom('email_messages')
      .select(['subject', 'to_emails', 'body_text'])
      .where('user_id', '=', userId)
      .where('subject', 'like', '%ladder%')
      .execute();
    expect(sent.length).toBeGreaterThan(0);
    // A new message keeps the typed subject: no "Re:" prefix, which is what
    // separates this path from sendReply.
    expect(sent[0].subject.startsWith('Re:')).toBe(false);
  });

  it('sends from a secondary Gmail mailbox', async () => {
    const acct = await connectGmailAccount(db, userId, { code: 'x', codeVerifier: 'y', redirectUri: 'z' } as never);
    const out = await sendAccountNew(db, userId, acct.id, {
      to: ['someone@example.com'],
      subject: 'From the other address',
      body: 'Hello.',
    });
    expect(out.fromEmail).toBe(acct.emailAddress);
  });

  it('sends through Graph sendMail on Outlook', async () => {
    const acct = await connectOutlookAccount(db, userId, { code: 'x', codeVerifier: 'y', redirectUri: 'z' } as never);
    const before = __outlookMockSentCount(acct.id);
    const out = await sendAccountNew(db, userId, acct.id, {
      to: ['colleague@work.example'],
      cc: ['boss@work.example'],
      subject: 'Q3 numbers',
      body: 'Attached next week.',
    });
    expect(__outlookMockSentCount(acct.id)).toBe(before + 1);
    expect(out.fromEmail).toBe(acct.emailAddress);
  });

  it('sends over SMTP on IMAP', async () => {
    const acct = await connectImapAccount(db, userId, {
      emailAddress: 'me@yahoo.com',
      password: 'app-password',
      preset: 'yahoo',
    });
    const before = __imapMockSentCount(acct.id);
    const out = await sendAccountNew(db, userId, acct.id, {
      to: ['friend@example.com'],
      subject: 'Dinner',
      body: 'Friday?',
    });
    expect(__imapMockSentCount(acct.id)).toBe(before + 1);
    expect(out.fromEmail).toBe('me@yahoo.com');
  });

  it('sends the body as written: the signature the composer showed, or none if deleted', async () => {
    await db
      .updateTable('users')
      .set({ email_signature: 'Ro\nSent from Chord' })
      .where('id', '=', userId)
      .execute();
    const sentBody = async (subject: string, body: string) => {
      await sendNewMessage(db, userId, { to: ['x@example.com'], subject, body });
      await backfillGmail(db, userId);
      const row = await db
        .selectFrom('email_messages')
        .select(['thread_id'])
        .where('user_id', '=', userId)
        .where('subject', 'like', `%${subject}%`)
        .executeTakeFirstOrThrow();
      // ADR 0110 — read through the reader, not the excerpt, which drops the
      // trailing space in "-- " that this asserts.
      const detail = await getThread(db, userId, row.thread_id);
      return detail!.messages.find((m) => m.subject.includes(subject))!.bodyText ?? '';
    };
    // The RFC 3676 separator, so a client can fold it away - once.
    const signed = await sentBody('Signed', 'Body text.\n\n-- \nRo\nSent from Chord');
    expect(signed).toContain('-- \nRo');
    expect(signed.match(/-- \n/g)).toHaveLength(1);
    // Deleted in the composer: nothing is added at send (ADR 0260 addendum).
    expect(await sentBody('Unsigned', 'Body text.')).not.toContain('Sent from Chord');
  });
});
