/**
 * A draft also lives in the mailbox's own Drafts folder (ADR 0303): copied
 * when it changed, updated in place rather than duplicated, and removed when
 * the Chord draft is sent or discarded.
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
import {
  __imapMockDrafts,
  __resetImapMock,
  __setImapMockNoDraftsFolder,
} from '@/services/email-accounts/imap-api.js';
import {
  __duringNextOutlookMockDraftWrite,
  __outlookMockDrafts,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import { deleteDraft, saveDraft } from '@/services/email/drafts.service.js';
import { cancelQueuedSend, flushDueSends, queueSend } from '@/services/email/outbox.service.js';
import { syncProviderDrafts } from '@/services/email/provider-drafts.service.js';
import {
  __addGmailMockMessage,
  __failGmailMockDrafts,
  __gmailMockDrafts,
  __resetGmailMock,
} from '@/services/google/gmail-api.js';
import { backfillGmail } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

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
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

const draftRow = (id: string) =>
  db
    .selectFrom('email_drafts')
    .select(['provider_ref', 'provider_mailbox', 'provider_synced_at', 'updated_at', 'provider_error', 'provider_retry_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

/** Saves land in the same millisecond in a fast test; the second must be newer. */
async function laterSave(...args: Parameters<typeof saveDraft>) {
  const before = Date.now();
  while (Date.now() === before) await new Promise((r) => setImmediate(r));
  return saveDraft(...args);
}

describe('primary Gmail', () => {
  it('copies a new draft into Gmail Drafts, then updates that same draft', async () => {
    const draft = await saveDraft(db, userId, {
      kind: 'new',
      to: ['coach@example.com'],
      subject: 'Saturday practice',
      body: 'Can Ben come at 10?',
    });

    expect((await syncProviderDrafts(db)).pushed).toBe(1);
    const drafts = __gmailMockDrafts(userId);
    expect(drafts.size).toBe(1);
    const [gmailId, first] = [...drafts.entries()][0]!;
    expect(first.mime).toContain('Subject: Saturday practice');
    expect(first.mime).toContain('coach@example.com');
    expect((await draftRow(draft.id)).provider_ref).toBe(gmailId);

    await laterSave(db, userId, { id: draft.id, kind: 'new', to: ['coach@example.com'], subject: 'Saturday practice', body: 'Can Ben come at 11 instead?' });
    expect((await syncProviderDrafts(db)).pushed).toBe(1);
    expect(drafts.size).toBe(1);
    expect(drafts.get(gmailId)!.mime).toMatch(/11 instead/);
  });

  it('does not write again when nothing changed', async () => {
    await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'x', body: 'y' });
    await syncProviderDrafts(db);

    expect((await syncProviderDrafts(db)).pushed).toBe(0);
    expect(__gmailMockDrafts(userId).size).toBe(1);
  });

  it('removes the Gmail copy when the draft is discarded', async () => {
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'x', body: 'y' });
    await syncProviderDrafts(db);
    expect(__gmailMockDrafts(userId).size).toBe(1);

    await deleteDraft(db, userId, draft.id);
    expect((await syncProviderDrafts(db)).removed).toBe(1);
    expect(__gmailMockDrafts(userId).size).toBe(0);
  });

  it('removes the Gmail copy once the message is sent, so it is not left as a draft', async () => {
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'Ladder', body: 'Saturday?' });
    await syncProviderDrafts(db);
    await queueSend(db, userId, draft.id);
    await db
      .updateTable('email_drafts')
      .set({ send_after: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', draft.id)
      .execute();

    expect(await flushDueSends(db)).toBe(1);
    await syncProviderDrafts(db);
    expect(__gmailMockDrafts(userId).size).toBe(0);
  });

  it('does not copy a message that is queued to send', async () => {
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'x', body: 'y' });
    await queueSend(db, userId, draft.id);

    expect((await syncProviderDrafts(db)).pushed).toBe(0);
  });

  it('backs off after a failure, and a new local save tries again at once', async () => {
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'x', body: 'y' });
    __failGmailMockDrafts(userId, 1);

    expect((await syncProviderDrafts(db)).pushed).toBe(0);
    const failed = await draftRow(draft.id);
    expect(failed.provider_error).toMatch(/503/);
    expect(failed.provider_retry_at).toBeTruthy();
    // Waiting out the backoff: nothing is tried.
    expect((await syncProviderDrafts(db)).pushed).toBe(0);

    await laterSave(db, userId, { id: draft.id, kind: 'new', to: ['a@example.com'], subject: 'x', body: 'y z' });
    expect((await syncProviderDrafts(db)).pushed).toBe(1);
    expect((await draftRow(draft.id)).provider_error).toBeNull();
  });

  it('keeps a Gmail-side draft out of the mirror', async () => {
    // Without this, Chord's own copy of a reply being written would show up
    // in that thread as a message.
    __addGmailMockMessage(userId, {
      id: 'm_draft_1',
      threadId: 't_fam1',
      labelIds: ['DRAFT'],
      snippet: 'half written',
      internalDate: String(Date.now()),
      historyId: '1',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'you@example.com' },
          { name: 'To', value: 'grandma@example.com' },
          { name: 'Subject', value: 'Re: Sunday dinner?' },
        ],
        body: { data: Buffer.from('half written', 'utf8').toString('base64url') },
      },
    });
    await backfillGmail(db, userId);

    const rows = await db
      .selectFrom('email_messages')
      .select('gmail_message_id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.gmail_message_id)).not.toContain('m_draft_1');
  });

  it('threads a reply draft on its Gmail thread with the reply headers', async () => {
    await backfillGmail(db, userId);
    const thread = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_fam1')
      .executeTakeFirstOrThrow();

    await saveDraft(db, userId, { kind: 'reply', threadId: thread.id, body: 'Yes, we will be there!' });
    await syncProviderDrafts(db);

    const [copy] = [...__gmailMockDrafts(userId).values()];
    expect(copy!.threadId).toBe('t_fam1');
    expect(copy!.mime).toContain('In-Reply-To: <fam1@example.com>');
    expect(copy!.mime).toContain('Subject: Re: Sunday dinner?');
    expect(copy!.mime).toContain('grandma@example.com');
  });

  it("copies a forward draft quoting the message it forwards, as the send will (ADR 0112 addendum)", async () => {
    await backfillGmail(db, userId);
    const thread = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_fam1')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('email_messages')
      .values({
        id: 'msg_earlier_fwd',
        user_id: userId,
        thread_id: thread.id,
        gmail_thread_id: thread.gmail_thread_id,
        gmail_message_id: 'm_earlier_fwd',
        from_name: 'Grandpa',
        from_email: 'grandpa@example.com',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        subject: 'Sunday dinner?',
        snippet: 'earlier',
        body_text: 'The earlier message the user picked.',
        attachments_json: '[]',
        internal_date: '2020-01-01T00:00:00.000Z',
        created_at: '2020-01-01T00:00:00.000Z',
      })
      .execute();

    await saveDraft(db, userId, {
      kind: 'forward',
      threadId: thread.id,
      to: ['aunt@example.com'],
      body: 'FYI',
      forwardMessageId: 'msg_earlier_fwd',
    });
    await syncProviderDrafts(db);

    const [copy] = [...__gmailMockDrafts(userId).values()];
    expect(copy!.mime).toContain('Subject: Fwd: Sunday dinner?');
    expect(copy!.mime).toContain('From: Grandpa <grandpa@example.com>');
    expect(copy!.mime).toContain('The earlier message the user picked.');
  });
});

describe('Outlook', () => {
  async function connectOutlook() {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const account = await db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
    await syncAccount(db, account);
    return account;
  }

  it('starts a reply draft from the message it answers, and updates it in place', async () => {
    const account = await connectOutlook();
    const thread = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('account_id', '=', account.id)
      .execute()
      .then((rows) => rows.find((t) => t.subject.includes('Soccer'))!);

    const draft = await saveDraft(db, userId, { kind: 'reply', threadId: thread.id, body: 'Thursday works' });
    await syncProviderDrafts(db);

    const drafts = __outlookMockDrafts(account.id);
    expect(drafts.size).toBe(1);
    const [id, copy] = [...drafts.entries()][0]!;
    expect(copy.replyTo).toBe('ol-msg-1');
    expect(copy.html).toContain('Thursday works');
    expect(copy.to).toEqual(['coach@lions-soccer.example']);
    expect((await draftRow(draft.id)).provider_mailbox).toBe(account.id);

    await laterSave(db, userId, { id: draft.id, kind: 'reply', threadId: thread.id, body: 'Thursday works, see you then' });
    await syncProviderDrafts(db);
    expect(drafts.size).toBe(1);
    expect(drafts.get(id)!.html).toContain('see you then');
  });
});

describe('Outlook, sent or undone while the copy is written', () => {
  async function connectOutlook() {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    return db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
  }

  it('keeps the copy of a draft that was queued and then undone mid-write', async () => {
    const account = await connectOutlook();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Carpool', body: 'one' });
    await syncProviderDrafts(db);
    await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Carpool', body: 'two' });

    // Send tapped while the pass is updating the copy; Undo tapped after.
    __duringNextOutlookMockDraftWrite(async () => {
      await queueSend(db, userId, draft.id);
    });
    await syncProviderDrafts(db);
    expect(await cancelQueuedSend(db, userId, draft.id)).toBe(true);
    await syncProviderDrafts(db);
    await syncProviderDrafts(db);

    const drafts = __outlookMockDrafts(account.id);
    expect(drafts.size).toBe(1);
    expect([...drafts.keys()]).toEqual([(await draftRow(draft.id)).provider_ref]);
  });

  it('removes the copy written for a draft that was sent mid-write', async () => {
    const account = await connectOutlook();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Carpool', body: 'one' });
    await syncProviderDrafts(db);
    await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Carpool', body: 'two' });

    __duringNextOutlookMockDraftWrite(async () => {
      await queueSend(db, userId, draft.id);
      await db
        .updateTable('email_drafts')
        .set({ send_after: new Date(Date.now() - 1000).toISOString() })
        .where('id', '=', draft.id)
        .execute();
      expect(await flushDueSends(db)).toBe(1);
    });
    await syncProviderDrafts(db);
    await syncProviderDrafts(db);

    expect(__outlookMockDrafts(account.id).size).toBe(0);
  });
});

describe('IMAP', () => {
  async function connectImap() {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    return db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
  }

  it('replaces the previous copy instead of piling up one per save', async () => {
    const account = await connectImap();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Bake sale', body: 'one' });
    await syncProviderDrafts(db);
    await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Bake sale', body: 'two' });
    await syncProviderDrafts(db);

    const drafts = __imapMockDrafts(account.id);
    expect(drafts.size).toBe(1);
    expect([...drafts.values()][0]).toContain('two');

    await deleteDraft(db, userId, draft.id);
    await syncProviderDrafts(db);
    expect(drafts.size).toBe(0);
  });

  it('records a mailbox with no Drafts folder instead of retrying it', async () => {
    const account = await connectImap();
    __setImapMockNoDraftsFolder(account.id, true);
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'x', body: 'y' });

    expect((await syncProviderDrafts(db)).pushed).toBe(0);
    const row = await draftRow(draft.id);
    expect(row.provider_ref).toBeNull();
    expect(row.provider_error).toMatch(/no drafts folder/);
    expect(row.provider_synced_at).toBe(row.updated_at);
  });
});

describe('moving a draft to another mailbox', () => {
  it('removes the copy from the mailbox it was in', async () => {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    const account = await db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'x', body: 'y' });
    await syncProviderDrafts(db);
    expect(__gmailMockDrafts(userId).size).toBe(1);

    await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'x', body: 'y' });
    await syncProviderDrafts(db);
    await syncProviderDrafts(db);

    expect(__gmailMockDrafts(userId).size).toBe(0);
    expect(__imapMockDrafts(account.id).size).toBe(1);
  });
});

/**
 * A copy deleted in another mail app (Outlook web, Gmail, Apple Mail) stays
 * deleted: the next copy used to find it gone and quietly write a new one, and
 * the Chord draft stayed in Chord's Drafts list waiting for that next copy.
 */
describe('a copy deleted in another mail app', () => {
  const draftExists = async (id: string) =>
    (await db.selectFrom('email_drafts').select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
  /** Make the untouched-draft check due now instead of five minutes on. */
  const checkDue = (id: string) =>
    db.updateTable('email_drafts').set({ provider_checked_at: null }).where('id', '=', id).execute();

  async function connectOutlook() {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    return db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
  }
  async function connectImap() {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    return db.selectFrom('email_accounts').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
  }

  it('Outlook: an edit in Chord after the deletion does not write the draft back', async () => {
    const account = await connectOutlook();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['coach@example.com'], subject: 'Carpool', body: 'one' });
    await syncProviderDrafts(db);
    const drafts = __outlookMockDrafts(account.id);
    expect(drafts.size).toBe(1);

    drafts.clear(); // deleted in Outlook on the web
    await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['coach@example.com'], subject: 'Carpool', body: 'two' });
    const pass = await syncProviderDrafts(db);

    expect(drafts.size).toBe(0);
    expect(pass.dropped).toBe(1);
    expect(await draftExists(draft.id)).toBe(false);
    // Nothing to remove: the copy is already gone.
    expect(await db.selectFrom('email_provider_draft_removals').selectAll().execute()).toEqual([]);
    await syncProviderDrafts(db);
    expect(drafts.size).toBe(0);
  });

  it('Outlook: an untouched draft leaves Chord too, and later saves start a new draft', async () => {
    const account = await connectOutlook();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['coach@example.com'], subject: 'Carpool', body: 'one' });
    await syncProviderDrafts(db);
    const drafts = __outlookMockDrafts(account.id);

    drafts.clear();
    // Not checked again within five minutes of the copy.
    expect((await syncProviderDrafts(db)).dropped).toBe(0);
    expect(await draftExists(draft.id)).toBe(true);

    await checkDue(draft.id);
    expect((await syncProviderDrafts(db)).dropped).toBe(1);
    expect(await draftExists(draft.id)).toBe(false);
    expect(drafts.size).toBe(0);

    // A composer still open keeps typing: ADR 0113's fall-through makes it a
    // fresh draft, which gets a fresh copy.
    const again = await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['coach@example.com'], subject: 'Carpool', body: 'three' });
    expect(again.id).not.toBe(draft.id);
    await syncProviderDrafts(db);
    expect(drafts.size).toBe(1);
  });

  it('keeps a draft whose copy is still there', async () => {
    const account = await connectOutlook();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'x', body: 'y' });
    await syncProviderDrafts(db);
    await checkDue(draft.id);

    expect((await syncProviderDrafts(db)).dropped).toBe(0);
    expect(await draftExists(draft.id)).toBe(true);
    expect(__outlookMockDrafts(account.id).size).toBe(1);
  });

  it('primary Gmail: the deleted draft is not created again', async () => {
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'Ladder', body: 'one' });
    await syncProviderDrafts(db);
    const drafts = __gmailMockDrafts(userId);
    drafts.clear();

    await laterSave(db, userId, { id: draft.id, kind: 'new', to: ['a@example.com'], subject: 'Ladder', body: 'two' });
    await syncProviderDrafts(db);
    expect(drafts.size).toBe(0);
    expect(await draftExists(draft.id)).toBe(false);
  });

  it('primary Gmail: an untouched deleted draft leaves Chord', async () => {
    const draft = await saveDraft(db, userId, { kind: 'new', to: ['a@example.com'], subject: 'Ladder', body: 'one' });
    await syncProviderDrafts(db);
    __gmailMockDrafts(userId).clear();
    await checkDue(draft.id);

    expect((await syncProviderDrafts(db)).dropped).toBe(1);
    expect(await draftExists(draft.id)).toBe(false);
  });

  it('IMAP: the deleted draft is not appended again', async () => {
    const account = await connectImap();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Bake sale', body: 'one' });
    await syncProviderDrafts(db);
    const drafts = __imapMockDrafts(account.id);
    drafts.clear();

    await laterSave(db, userId, { id: draft.id, kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Bake sale', body: 'two' });
    await syncProviderDrafts(db);
    expect(drafts.size).toBe(0);
    expect(await draftExists(draft.id)).toBe(false);
  });

  it('IMAP: an untouched deleted draft leaves Chord', async () => {
    const account = await connectImap();
    const draft = await saveDraft(db, userId, { kind: 'new', accountId: account.id, to: ['a@example.com'], subject: 'Bake sale', body: 'one' });
    await syncProviderDrafts(db);
    __imapMockDrafts(account.id).clear();
    await checkDue(draft.id);

    expect((await syncProviderDrafts(db)).dropped).toBe(1);
    expect(await draftExists(draft.id)).toBe(false);
  });
});
