/**
 * One message, one mirror row (docs/notes/0199 addendum). Three ways an
 * attached mailbox used to end up with two rows for one message, or one row
 * holding another message:
 *
 *  - Outlook gives a message a NEW Graph id when it moves folders, so a
 *    message moved back into the Inbox arrived on the delta as a stranger.
 *  - A reply Chord sent was stored under a placeholder `sent-…` id, and the
 *    real copy the Sent folder sync (ADR 0116) mirrored later sat beside it.
 *  - IMAP UIDs are per folder, and Inbox and Sent were both keyed `u<uid>`:
 *    a Sent UID equal to an Inbox UID overwrote the inbox row, or hid the
 *    inbox message from sync forever.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  applyAccountThreadModify,
  connectImapAccount,
  connectOutlookAccount,
  sendAccountReply,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { listAccounts, scopedId, type AccountRow } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockMessage,
  __addOutlookMockSent,
  __outlookMockIsRead,
  __reissueOutlookMockId,
  __removeOutlookMockMessage,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import { normalizeGraphMessage } from '@/services/email-accounts/outlook.service.js';
import {
  __addImapMockMessage,
  __addImapMockSent,
  __imapMockLastSentMessageId,
  __resetImapMock,
  __setImapMockAttachment,
  type ImapFetchedMessage,
} from '@/services/email-accounts/imap-api.js';
import { fetchEmailAttachmentData } from '@/services/email-accounts/attachment-fetch.js';
import { normalizeImapMessage } from '@/services/email-accounts/imap.service.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import {
  ensureThreadRow,
  listThreads,
  recomputeThread,
  upsertMessageMeta,
} from '@/services/google/gmail.service.js';
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
  userId = await createUser(db, 'mirror-identity-user');
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

async function rowsOf(accountId: string) {
  return db
    .selectFrom('email_messages')
    .select(['thread_id', 'gmail_message_id', 'gmail_thread_id', 'gmail_label_ids', 'rfc822_message_id', 'subject'])
    .where('account_id', '=', accountId)
    .orderBy('gmail_message_id')
    .execute();
}

async function rowsWithRfc822(accountId: string, rfc822: string) {
  return (await rowsOf(accountId)).filter((r) => r.rfc822_message_id === rfc822);
}

const subjectsIn = async (folder: 'inbox' | 'sent') =>
  (await listThreads(db, userId, { folder, limit: 100 })).map((t) => t.subject);

async function account(): Promise<AccountRow> {
  const [a] = await listAccounts(db, userId);
  return a;
}

function imapMessage(over: Partial<ImapFetchedMessage> & { uid: number }): ImapFetchedMessage {
  return {
    flags: ['\\Seen'],
    messageId: `<msg-${over.uid}@example.com>`,
    references: null,
    inReplyTo: null,
    fromName: 'Someone',
    fromEmail: 'someone@example.com',
    toEmails: ['family@yahoo.example'],
    ccEmails: [],
    subject: `Message ${over.uid}`,
    snippet: 'hello',
    bodyText: 'hello',
    bodyHtml: null,
    date: new Date().toISOString(),
    attachments: [],
    ...over,
  };
}

describe('IMAP: Inbox and Sent UIDs are separate number spaces', () => {
  async function connect() {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    return account();
  }

  it('a Sent UID equal to an Inbox UID does not overwrite the inbox message', async () => {
    const a = await connect();
    await syncAccount(db, a);
    // The seeded inbox holds UID 101 ("Picture day is next Friday").
    __addImapMockSent(
      a.id,
      imapMessage({
        uid: 101,
        messageId: '<sent-101@yahoo.example>',
        fromEmail: 'family@yahoo.example',
        toEmails: ['grandma@example.com'],
        subject: 'Sunday lunch',
      }),
    );

    await syncAccount(db, await account());

    expect(await subjectsIn('inbox')).toContain('Picture day is next Friday');
    expect(await subjectsIn('sent')).toContain('Sunday lunch');
    expect(await rowsWithRfc822(a.id, '<yh-101@school.example>')).toHaveLength(1);
    expect(await rowsWithRfc822(a.id, '<sent-101@yahoo.example>')).toHaveLength(1);
  });

  it('an Inbox message whose UID a Sent message already has is still mirrored', async () => {
    const a = await connect();
    __addImapMockSent(
      a.id,
      imapMessage({ uid: 500, messageId: '<sent-500@yahoo.example>', subject: 'Sent first' }),
    );
    await syncAccount(db, await account());

    __addImapMockMessage(
      a.id,
      imapMessage({ uid: 500, messageId: '<in-500@example.com>', subject: 'Arrived later' }),
    );
    await syncAccount(db, await account());

    expect(await subjectsIn('inbox')).toContain('Arrived later');
    expect(await subjectsIn('sent')).toContain('Sent first');
  });

  it('heals a mirror written under the old shared key', async () => {
    const a = await connect();
    await syncAccount(db, await account());
    // What the old code left behind: Sent UID 101 stored as `u101` over the
    // inbox message's row, the inbox message itself gone from the mirror.
    const sent = imapMessage({
      uid: 101,
      messageId: '<sent-101@yahoo.example>',
      fromEmail: 'family@yahoo.example',
      subject: 'Sunday lunch',
    });
    const now = new Date().toISOString();
    const nm = { ...normalizeImapMessage(a.id, sent, 'sent'), gmailMessageId: scopedId(a.id, 'u101') };
    const inboxThread = (await rowsWithRfc822(a.id, '<yh-101@school.example>'))[0];
    const threadRow = await ensureThreadRow(db, userId, inboxThread.gmail_thread_id, now, a.id);
    await upsertMessageMeta(db, userId, threadRow, nm, now, a.id);
    await recomputeThread(db, userId, inboxThread.gmail_thread_id);
    __addImapMockSent(a.id, sent);
    // An old cursor: no key version, and Sent already walked past UID 101.
    await db
      .updateTable('email_accounts')
      .set({ sync_cursor: JSON.stringify({ uidValidity: '1', lastUid: 102, sentUidValidity: '1', sentLastUid: 101 }) })
      .where('id', '=', a.id)
      .execute();

    await syncAccount(db, await account());
    await syncAccount(db, await account());

    expect(await subjectsIn('inbox')).toContain('Picture day is next Friday');
    expect(await subjectsIn('sent')).toContain('Sunday lunch');
    expect(await rowsWithRfc822(a.id, '<sent-101@yahoo.example>')).toHaveLength(1);
    expect(await rowsWithRfc822(a.id, '<yh-101@school.example>')).toHaveLength(1);
  });

  it('a thread moved out of and back into the Inbox stays one row per message', async () => {
    const a = await connect();
    await syncAccount(db, a);
    const [thread] = (await listThreads(db, userId, { limit: 100 })).filter(
      (t) => t.subject === 'Picture day is next Friday',
    );

    await applyAccountThreadModify(db, userId, a.id, thread.id, { archive: true });
    await applyAccountThreadModify(db, userId, a.id, thread.id, { archive: false });
    await syncAccount(db, await account());

    expect(await rowsWithRfc822(a.id, '<yh-101@school.example>')).toHaveLength(1);
    expect(await subjectsIn('inbox')).toContain('Picture day is next Friday');
  });

  it("a Sent message's attachment is fetched from Sent, not from the inbox UID", async () => {
    const a = await connect();
    const file = (name: string, text: string) => ({
      filename: name,
      mimeType: 'application/pdf',
      content: Buffer.from(text),
    });
    // Inbox UID 101 is the seeded school email; give it a file of its own.
    __setImapMockAttachment(a.id, 101, 0, file('order-form.pdf', 'school order form'));
    __addImapMockSent(
      a.id,
      imapMessage({ uid: 101, messageId: '<sent-101@yahoo.example>', subject: 'Signed lease' }),
    );
    __setImapMockAttachment(a.id, 101, 0, file('lease-signed.pdf', 'the signed lease'), 'sent');
    await syncAccount(db, a);

    const [row] = await db
      .selectFrom('email_messages')
      .select('id')
      .where('account_id', '=', a.id)
      .where('rfc822_message_id', '=', '<sent-101@yahoo.example>')
      .execute();
    const got = await fetchEmailAttachmentData(db, userId, row.id, 'i0');

    expect(got?.filename).toBe('lease-signed.pdf');
    expect(got?.buffer.toString()).toBe('the signed lease');
  });

  it('a reply Chord sent and its Sent-folder copy are one message', async () => {
    const a = await connect();
    await syncAccount(db, a);
    const [thread] = (await listThreads(db, userId, { limit: 100 })).filter(
      (t) => t.subject === 'Picture day is next Friday',
    );

    await sendAccountReply(db, userId, a.id, { threadRowId: thread.id, body: 'We will be there.' });
    // The server files the sent copy under the Message-ID it went out with.
    __addImapMockSent(
      a.id,
      imapMessage({
        uid: 7,
        messageId: __imapMockLastSentMessageId(a.id),
        inReplyTo: '<yh-101@school.example>',
        references: '<yh-101@school.example>',
        fromEmail: 'family@yahoo.example',
        toEmails: ['office@school.example'],
        subject: 'Re: Picture day is next Friday',
      }),
    );
    await syncAccount(db, await account());

    const inThread = (await rowsOf(a.id)).filter((r) => r.thread_id === thread.id);
    expect(inThread).toHaveLength(2);
  });
});

describe('Outlook: a message keeps one row when its Graph id changes', () => {
  async function connect() {
    await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    return account();
  }

  it('moved out of the Inbox and back under a new id', async () => {
    const a = await connect();
    await syncAccount(db, a);
    expect(await rowsWithRfc822(a.id, '<ol-msg-1@lions-soccer.example>')).toHaveLength(1);

    // Archived in Outlook: the inbox delta says the old id left...
    __removeOutlookMockMessage(a.id, 'ol-msg-1', 'moved');
    await syncAccount(db, await account());
    // ...and moved back: the inbox delta reports the same message, new id.
    __addOutlookMockMessage(a.id, {
      id: 'ol-msg-1-moved-back',
      conversationId: 'ol-conv-1',
      subject: 'Soccer practice moved to Thursday',
      bodyPreview: 'Hi parents',
      from: { emailAddress: { name: 'Coach Dana', address: 'coach@lions-soccer.example' } },
      toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
      receivedDateTime: new Date(Date.now() - 20 * 3600_000).toISOString(),
      isRead: false,
      internetMessageId: '<ol-msg-1@lions-soccer.example>',
    });
    await syncAccount(db, await account());

    const rows = await rowsWithRfc822(a.id, '<ol-msg-1@lions-soccer.example>');
    expect(rows).toHaveLength(1);
    expect(rows[0].gmail_message_id).toBe(scopedId(a.id, 'ol-msg-1-moved-back'));
    expect(rows[0].gmail_label_ids).toContain('INBOX');
  });

  it('a twin left by an older sync is removed when a write finds the live copy', async () => {
    const a = await connect();
    await syncAccount(db, a);
    // Before this fix: the message moved and back, and the delta inserted the
    // new id beside the old row instead of re-keying it.
    __reissueOutlookMockId(a.id, 'ol-msg-1', 'ol-msg-1-new');
    const [old] = await rowsWithRfc822(a.id, '<ol-msg-1@lions-soccer.example>');
    const now = new Date().toISOString();
    await upsertMessageMeta(
      db,
      userId,
      old.thread_id,
      normalizeGraphMessage(a.id, {
        id: 'ol-msg-1-new',
        conversationId: 'ol-conv-1',
        subject: 'Soccer practice moved to Thursday',
        receivedDateTime: new Date(Date.now() - 20 * 3600_000).toISOString(),
        isRead: false,
        internetMessageId: '<ol-msg-1@lions-soccer.example>',
      }),
      now,
      a.id,
    );
    expect(await rowsWithRfc822(a.id, '<ol-msg-1@lions-soccer.example>')).toHaveLength(2);

    await applyAccountThreadModify(db, userId, a.id, old.thread_id, { markRead: true });

    const rows = await rowsWithRfc822(a.id, '<ol-msg-1@lions-soccer.example>');
    expect(rows).toHaveLength(1);
    expect(rows[0].gmail_message_id).toBe(scopedId(a.id, 'ol-msg-1-new'));
  });

  it('a message sent to yourself keeps its inbox copy and its sent copy', async () => {
    const a = await connect();
    const base = {
      conversationId: 'conv-self',
      subject: 'Note to self',
      bodyPreview: 'milk',
      from: { emailAddress: { address: 'me@outlook.example' } },
      toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
      receivedDateTime: new Date().toISOString(),
      isRead: true,
      internetMessageId: '<self@outlook.example>',
    };
    __addOutlookMockMessage(a.id, { ...base, id: 'self-inbox' });
    __addOutlookMockSent(a.id, { ...base, id: 'self-sent' });

    await syncAccount(db, a);
    await syncAccount(db, await account());

    expect(await rowsWithRfc822(a.id, '<self@outlook.example>')).toHaveLength(2);
  });

  it("a write to a message sent to yourself reaches that copy, not the other one", async () => {
    const a = await connect();
    const base = {
      conversationId: 'conv-self-write',
      subject: 'Pick up dry cleaning',
      bodyPreview: 'ticket 4417',
      from: { emailAddress: { address: 'me@outlook.example' } },
      toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
      receivedDateTime: new Date().toISOString(),
      internetMessageId: '<dry-cleaning@outlook.example>',
    };
    // The Sent copy is the first match Graph's lookup would give back.
    __addOutlookMockSent(a.id, { ...base, id: 'dc-sent', isRead: true });
    __addOutlookMockMessage(a.id, { ...base, id: 'dc-inbox', isRead: false });
    await syncAccount(db, a);
    // Moved and back in Outlook since: the stored inbox id is stale.
    __reissueOutlookMockId(a.id, 'dc-inbox', 'dc-inbox-new');
    const [thread] = (await listThreads(db, userId, { limit: 100 })).filter(
      (t) => t.subject === 'Pick up dry cleaning',
    );

    await applyAccountThreadModify(db, userId, a.id, thread.id, { markRead: true });

    expect(__outlookMockIsRead(a.id, 'dc-inbox-new')).toBe(true);
    const keys = (await rowsWithRfc822(a.id, '<dry-cleaning@outlook.example>')).map(
      (r) => r.gmail_message_id,
    );
    expect(keys.sort()).toEqual([scopedId(a.id, 'dc-inbox-new'), scopedId(a.id, 'dc-sent')].sort());
  });

  it('a reply Chord sent and its Sent-folder copy are one message', async () => {
    const a = await connect();
    await syncAccount(db, a);
    const [thread] = (await listThreads(db, userId, { limit: 100 })).filter(
      (t) => t.subject === 'Soccer practice moved to Thursday',
    );

    await sendAccountReply(db, userId, a.id, { threadRowId: thread.id, body: 'See you Thursday.' });
    __addOutlookMockSent(a.id, {
      id: 'graph-sent-reply',
      conversationId: 'ol-conv-1',
      subject: 'RE: Soccer practice moved to Thursday',
      bodyPreview: 'See you Thursday.',
      from: { emailAddress: { address: 'me@outlook.example' } },
      toRecipients: [{ emailAddress: { address: 'coach@lions-soccer.example' } }],
      receivedDateTime: new Date().toISOString(),
      isRead: true,
      internetMessageId: '<reply-1@outlook.example>',
    });
    await syncAccount(db, await account());

    const inThread = (await rowsOf(a.id)).filter((r) => r.thread_id === thread.id);
    expect(inThread).toHaveLength(2);
    expect(inThread.map((r) => r.gmail_message_id)).toContain(scopedId(a.id, 'graph-sent-reply'));
  });

  it('a second reply sent much later is not merged with the first', async () => {
    const a = await connect();
    await syncAccount(db, a);
    const [thread] = (await listThreads(db, userId, { limit: 100 })).filter(
      (t) => t.subject === 'Soccer practice moved to Thursday',
    );
    await sendAccountReply(db, userId, a.id, { threadRowId: thread.id, body: 'See you Thursday.' });
    // A copy of a reply sent from another client hours earlier is not the
    // placeholder for the one Chord just sent.
    __addOutlookMockSent(a.id, {
      id: 'graph-sent-earlier',
      conversationId: 'ol-conv-1',
      subject: 'RE: Soccer practice moved to Thursday',
      bodyPreview: 'Thanks coach',
      from: { emailAddress: { address: 'me@outlook.example' } },
      receivedDateTime: new Date(Date.now() - 6 * 3600_000).toISOString(),
      isRead: true,
      internetMessageId: '<earlier@outlook.example>',
    });
    await syncAccount(db, await account());

    const inThread = (await rowsOf(a.id)).filter((r) => r.thread_id === thread.id);
    expect(inThread).toHaveLength(3);
  });
});
