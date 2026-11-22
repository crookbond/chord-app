/**
 * Provider parity (ADR 0116). What a mailbox can DO must not depend on which
 * provider it is, and the biggest divergence was structural rather than
 * cosmetic: Outlook and IMAP mirrored their inbox only, so Sent held nothing
 * but what Chord itself had sent and the ADR 0108 folder had to apologise for
 * it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  connectImapAccount,
  connectOutlookAccount,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockSent,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import { __addImapMockSent, __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  __resetOutlookMock();
  __resetImapMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'parity-user');
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

const subjectsIn = async (folder: 'inbox' | 'sent') =>
  (await listThreads(db, userId, { folder, limit: 100 })).map((t) => t.subject);

describe('Outlook mirrors its Sent folder', () => {
  async function connect() {
    await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const [account] = await listAccounts(db, userId);
    return account;
  }

  it('shows a message sent from another client', async () => {
    const account = await connect();
    __addOutlookMockSent(account.id, {
      id: 'sent-1',
      conversationId: 'conv-sent-1',
      subject: 'Ladder on Saturday',
      bodyPreview: 'Can we borrow it',
      receivedDateTime: new Date().toISOString(),
      isRead: true,
      from: { emailAddress: { address: 'me@outlook.example', name: 'Me' } },
      toRecipients: [{ emailAddress: { address: 'them@example.com' } }],
    });

    await syncAccount(db, account);

    expect(await subjectsIn('sent')).toContain('Ladder on Saturday');
  });

  it('keeps sent mail out of the inbox', async () => {
    // The two delta streams are separate for exactly this reason: a mock (or a
    // sync) that returned the same messages for both folders would import
    // everything twice and still look like it worked.
    const account = await connect();
    __addOutlookMockSent(account.id, {
      id: 'sent-2',
      conversationId: 'conv-sent-2',
      subject: 'Ladder on Saturday',
      bodyPreview: 'x',
      receivedDateTime: new Date().toISOString(),
      isRead: true,
      from: { emailAddress: { address: 'me@outlook.example' } },
      toRecipients: [],
    });

    await syncAccount(db, account);

    expect(await subjectsIn('inbox')).not.toContain('Ladder on Saturday');
  });
});

describe('IMAP mirrors its Sent folder', () => {
  async function connect() {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await listAccounts(db, userId);
    return account;
  }

  it('shows a message sent from another client', async () => {
    const account = await connect();
    __addImapMockSent(account.id, {
      uid: 5001,
      flags: ['\\Seen'],
      messageId: '<sent-5001@yahoo.example>',
      references: null,
      inReplyTo: null,
      fromName: 'Me',
      fromEmail: 'family@yahoo.example',
      toEmails: ['them@example.com'],
      ccEmails: [],
      subject: 'Ladder on Saturday',
      snippet: 'Can we borrow it',
      bodyText: 'Can we borrow it Saturday?',
      bodyHtml: null,
      date: new Date().toISOString(),
      attachments: [],
    });

    await syncAccount(db, account);

    expect(await subjectsIn('sent')).toContain('Ladder on Saturday');
  });

  it('copes with an account that has no Sent folder', async () => {
    // A bare IMAP host may genuinely not have one. That is a real state, and
    // the inbox sync must still succeed rather than failing on its absence.
    const account = await connect();

    const result = await syncAccount(db, account);

    expect(result).toBeTruthy();
    expect(await subjectsIn('sent')).toEqual([]);
    expect((await subjectsIn('inbox')).length).toBeGreaterThan(0);
  });
});
