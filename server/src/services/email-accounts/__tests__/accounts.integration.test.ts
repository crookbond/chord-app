/**
 * ADR 0080 — attached mailboxes end-to-end with the mock providers:
 * connect → backfill → merged listing → reply → read/archive convergence →
 * disconnect, plus the Gmail-path isolation guards (disconnectGmail and the
 * backfill reverse-delete must never touch account rows).
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  connectGmailAccount,
  connectImapAccount,
  connectOutlookAccount,
  disconnectAccount,
  sendAccountReply,
  syncAccount,
  applyAccountThreadModify,
  getAccountThread,
  moveMailboxesTo,
} from '@/services/email-accounts/accounts.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createTask } from '@/services/tasks.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { AccountAuthError, AccountValidationError, listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockMessage,
  __outlookMockRemovalState,
  __outlookMockSentCount,
  __removeOutlookMockMessage,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import {
  __addImapMockMessage,
  __imapMockSentCount,
  __imapMockTrashed,
  __removeImapMockMessage,
  __resetImapMock,
  __setImapMockNoTrashFolder,
} from '@/services/email-accounts/imap-api.js';
import { inviteEventForAccountMessage } from '@/services/email-accounts/invite-probe.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail, disconnectGmail, listThreads } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/**
 * Relative, not literal (ADR 0100's precedent, load-bearing again for ADR
 * 0137): a `startsAt` already lived through stages nothing, so a hardcoded
 * date rots this into a test that asserts nothing.
 */
const inDays = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const D_CONFERENCE = inDays(21).replace(/-/g, '');


describe('email accounts (ADR 0080)', () => {
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
    userId = await createUser(db, 'accounts-user');
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
    await closeTestDb(db);
  });

  const accountRows = () => listAccounts(db, userId);
  const accountThreads = (accountId: string) =>
    db.selectFrom('email_threads').selectAll().where('account_id', '=', accountId).execute();

  async function connectOutlook() {
    await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    // The connect kicks a fire-and-forget initial sync; run one deterministically.
    const [account] = await accountRows();
    await syncAccount(db, account);
    return account;
  }

  it('connects an Outlook mailbox and mirrors its inbox', async () => {
    const account = await connectOutlook();
    expect(account.provider).toBe('outlook');
    expect(account.email_address).toBe('me@outlook.example');

    const threads = await accountThreads(account.id);
    expect(threads.length).toBe(2);
    expect(threads.every((t) => t.gmail_thread_id.startsWith(`${account.id}:`))).toBe(true);

    const soccer = threads.find((t) => t.subject.includes('Soccer'));
    expect(soccer?.is_unread).toBe(1);
  });

  it('merges account threads into the shared reader listing', async () => {
    await backfillGmail(db, userId);
    const account = await connectOutlook();
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [, imapAccount] = await accountRows();
    await syncAccount(db, imapAccount);

    const all = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    const subjects = all.map((t) => t.subject);
    expect(subjects.some((s) => s.includes('Soccer'))).toBe(true); // outlook
    expect(subjects.some((s) => s.includes('Picture day'))).toBe(true); // imap
    expect(all.length).toBeGreaterThan(4); // gmail fixtures + both accounts
    void account;
  });

  it('refuses the primary Gmail address attached again as an IMAP mailbox', async () => {
    // The only guard was on the secondary-Gmail path; insertAccount dedups on
    // provider + address, so the primary address under `imap` mirrored the
    // whole mailbox a second time.
    await db.updateTable('users').set({ email: 'parent@gmail.com' }).where('id', '=', userId).execute();
    await expect(
      connectImapAccount(db, userId, {
        emailAddress: 'Parent@Gmail.com',
        password: 'app-password',
        preset: 'custom',
        host: 'imap.gmail.com',
        port: 993,
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465,
      }),
    ).rejects.toBeInstanceOf(AccountValidationError);
    expect(await accountRows()).toHaveLength(0);
  });

  it('allows the sign-in address over IMAP when no primary Gmail is connected', async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await db.updateTable('users').set({ email: 'parent@gmail.com' }).where('id', '=', userId).execute();
    await connectImapAccount(db, userId, {
      emailAddress: 'parent@gmail.com',
      password: 'app-password',
      preset: 'yahoo',
    });
    expect(await accountRows()).toHaveLength(1);
  });

  it('refuses an address already attached under another provider', async () => {
    await connectOutlook();
    await expect(
      connectImapAccount(db, userId, {
        emailAddress: 'ME@outlook.example',
        password: 'app-password',
        preset: 'yahoo',
      }),
    ).rejects.toBeInstanceOf(AccountValidationError);
    expect(await accountRows()).toHaveLength(1);
    // Reconnecting the same mailbox under its own provider still works.
    await connectOutlook();
    expect(await accountRows()).toHaveLength(1);
  });

  it('attaches one mailbox however the address is spelled, and says it was already there', async () => {
    // ADR 0320 - the add door reported a silent success while nothing new was
    // attached, and a mixed-case spelling missed the existing row entirely:
    // insertAccount matched `email_address` with `=`, so the SAME mailbox got
    // a second row with nothing to tell the two apart.
    const first = await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const again = await connectImapAccount(db, userId, {
      emailAddress: 'Family@Yahoo.Example',
      password: 'app-password-2',
      preset: 'yahoo',
    });
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].email_address).toBe('family@yahoo.example');
    expect(again.id).toBe(first.id);
    expect(first.reattached).toBe(false);
    expect(again.reattached).toBe(true);
  });

  it('reports an Outlook connect that landed on the mailbox already attached', async () => {
    const first = await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    expect(first.reattached).toBe(false);
    const again = await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    expect(again.reattached).toBe(true);
    expect(await accountRows()).toHaveLength(1);
  });

  it('replies via the provider and upserts the sent copy locally', async () => {
    const account = await connectOutlook();
    const [thread] = (await accountThreads(account.id)).filter((t) =>
      t.subject.includes('Soccer'),
    );

    const detail = await sendAccountReply(db, userId, account.id, {
      threadRowId: thread.id,
      body: 'Thanks — see you Thursday!',
    });
    expect(detail).not.toBeNull();
    expect(__outlookMockSentCount(account.id)).toBe(1);
    expect(detail!.messages.some((m) => m.bodyText?.includes('see you Thursday'))).toBe(true);
    expect(detail!.thread.isUnread).toBe(false);
  });

  it('imap: connect verifies credentials and syncs; reply goes out over SMTP', async () => {
    await expect(
      connectImapAccount(db, userId, {
        emailAddress: 'family@yahoo.example',
        password: 'bad-password',
        preset: 'yahoo',
      }),
    ).rejects.toBeInstanceOf(AccountAuthError);
    expect((await accountRows()).length).toBe(0);

    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);

    const threads = await accountThreads(account.id);
    expect(threads.length).toBe(2);

    const picture = threads.find((t) => t.subject.includes('Picture day'))!;
    const detail = await sendAccountReply(db, userId, account.id, {
      threadRowId: picture.id,
      body: 'Ordering two prints, thanks!',
    });
    expect(detail).not.toBeNull();
    expect(__imapMockSentCount(account.id)).toBe(1);
  });

  it('imap: threads replies by References onto the same thread', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);

    __addImapMockMessage(account.id, {
      uid: 103,
      flags: [],
      messageId: '<yh-103@school.example>',
      inReplyTo: '<yh-101@school.example>',
      references: '<yh-101@school.example>',
      subject: 'Re: Picture day is next Friday',
      fromName: 'Lincoln Elementary',
      fromEmail: 'office@school.example',
      toEmails: ['family@yahoo.example'],
      ccEmails: [],
      date: new Date().toISOString(),
      snippet: 'Correction: picture day is Thursday.',
      bodyText: 'Correction: picture day is Thursday.',
      bodyHtml: null,
    });
    await syncAccount(db, account);

    const threads = await accountThreads(account.id);
    const picture = threads.find((t) => t.subject.includes('Picture day'))!;
    expect(picture.message_count).toBe(2);
    expect(threads.length).toBe(2);
  });

  it('imap: captures the invite .ics at sync so the probe needs no login', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    __addImapMockMessage(account.id, {
      uid: 110,
      flags: [],
      messageId: '<yh-110@school.example>',
      inReplyTo: null,
      references: null,
      subject: 'Parent-teacher conference',
      fromName: 'Lincoln Elementary',
      fromEmail: 'office@school.example',
      toEmails: ['family@yahoo.example'],
      ccEmails: [],
      date: new Date().toISOString(),
      snippet: 'Invitation',
      bodyText: 'Invitation',
      bodyHtml: null,
      icsText: [
        'BEGIN:VCALENDAR',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        'UID:ptc-110@school.example',
        `DTSTART:${D_CONFERENCE}T170000Z`,
        `DTEND:${D_CONFERENCE}T180000Z`,
        'SUMMARY:Parent-teacher conference',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    });
    await syncAccount(db, account);

    const rows = await db
      .selectFrom('email_messages')
      .select(['gmail_message_id', 'subject', 'ics_text'])
      .where('account_id', '=', account.id)
      .execute();
    const invite = rows.find((r) => r.subject.includes('Parent-teacher'))!;
    const plain = rows.find((r) => r.subject.includes('Picture day'))!;
    // '' is "parsed, carries no invite" — distinct from NULL, which would send
    // the probe to the wire for every ordinary message.
    expect(plain.ics_text).toBe('');
    expect(invite.ics_text).toContain('BEGIN:VCALENDAR');

    const probed = await inviteEventForAccountMessage(
      db,
      userId,
      account.id,
      invite.gmail_message_id,
    );
    expect(probed.isInvite).toBe(true);
    expect(probed.event?.uid).toBe('ptc-110@school.example');
    expect(probed.event?.title).toBe('Parent-teacher conference');

    const notInvite = await inviteEventForAccountMessage(
      db,
      userId,
      account.id,
      plain.gmail_message_id,
    );
    expect(notInvite.isInvite).toBe(false);
  });

  /**
   * ADR 0137 — prod fired four syncs of one Yahoo account inside 1.3s, which
   * on IMAP is four LOGINs, the metric Yahoo throttles: the next came back
   * `[LIMIT] AUTHENTICATE Rate limit hit` and escaped a route as a 500.
   *
   * The collapse must not cost freshness. A caller wants the mailbox as of
   * THEIR call, and the run already in flight may have read it before their
   * mail landed — so overlapping callers share one FOLLOW-UP run rather than
   * the in-flight one's result. Two syncs however many pile up, and every
   * caller sees mail that existed when they asked.
   */
  it('imap: overlapping syncs collapse without losing mail that arrived meanwhile', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();

    const first = syncAccount(db, account);
    // Lands after the in-flight sync has already listed the mailbox.
    __addImapMockMessage(account.id, {
      uid: 120,
      flags: [],
      messageId: '<yh-120@school.example>',
      inReplyTo: null,
      references: null,
      subject: 'Field trip form',
      fromName: 'Lincoln Elementary',
      fromEmail: 'office@school.example',
      toEmails: ['family@yahoo.example'],
      ccEmails: [],
      date: new Date().toISOString(),
      snippet: 'Please sign',
      bodyText: 'Please sign',
      bodyHtml: null,
    });
    const [, , third] = await Promise.all([
      first,
      syncAccount(db, account),
      syncAccount(db, account),
    ]);
    expect(third).toBeTruthy();

    const subjects = (await accountThreads(account.id)).map((t) => t.subject);
    expect(subjects.some((s) => s.includes('Field trip form'))).toBe(true);
  });

  it('outlook: a message removed from the inbox archives the thread', async () => {
    const account = await connectOutlook();
    __removeOutlookMockMessage(account.id, 'ol-msg-2');
    await syncAccount(db, account);

    const receipt = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('receipt'),
    )!;
    expect(receipt.is_archived).toBe(1);

    const listed = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    expect(listed.some((t) => t.id === receipt.id)).toBe(false);
  });

  it('imap: a vanished UID archives; modify syncs read-state', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);

    const picture = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Picture day'),
    )!;
    const summary = await applyAccountThreadModify(db, userId, account.id, picture.id, {
      markRead: true,
    });
    expect(summary?.isUnread).toBe(false);

    __removeImapMockMessage(account.id, 102);
    await syncAccount(db, account);
    const pharmacy = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('prescription'),
    )!;
    expect(pharmacy.is_archived).toBe(1);
  });

  it('outlook: incremental delta picks up new mail without duplicating old', async () => {
    const account = await connectOutlook();
    expect((await accountThreads(account.id)).length).toBe(2);

    __addOutlookMockMessage(account.id, {
      id: 'ol-msg-3',
      conversationId: 'ol-conv-3',
      subject: 'Dentist appointment reminder',
      bodyPreview: 'Reminder: cleaning on Aug 2 at 10am.',
      from: { emailAddress: { name: 'Smile Dental', address: 'appt@dental.example' } },
      toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
      receivedDateTime: new Date().toISOString(),
      isRead: false,
      internetMessageId: '<ol-msg-3@dental.example>',
      body: { contentType: 'text', content: 'Reminder: cleaning on Aug 2 at 10am.' },
    });
    await syncAccount(db, account);

    const threads = await accountThreads(account.id);
    expect(threads.length).toBe(3);
    const msgs = await db
      .selectFrom('email_messages')
      .select('id')
      .where('account_id', '=', account.id)
      .execute();
    expect(msgs.length).toBe(3);
  });

  it('lazy-fetches Outlook bodies on thread open', async () => {
    const account = await connectOutlook();
    const soccer = (await accountThreads(account.id)).find((t) => t.subject.includes('Soccer'))!;
    const detail = await getAccountThread(db, userId, account.id, soccer.id);
    expect(detail!.messages[0].bodyHtml).toContain('Thursday 5pm');
  });

  it('disconnect wipes only that account; gmail disconnect leaves accounts alone', async () => {
    await backfillGmail(db, userId);
    const account = await connectOutlook();
    const gmailThreads = await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .where('account_id', 'is', null)
      .execute();
    expect(gmailThreads.length).toBeGreaterThan(0);

    // Gmail disconnect must not touch the account mirror (ADR 0080 guard).
    await disconnectGmail(db, userId);
    expect((await accountThreads(account.id)).length).toBe(2);

    // Account disconnect cascades its mirror and leaves nothing else.
    await disconnectAccount(db, userId, account.id);
    expect((await accountRows()).length).toBe(0);
    expect((await accountThreads(account.id)).length).toBe(0);
  });

  it('secondary gmail: connects, mirrors with prefixed ids, distinct from primary', async () => {
    await backfillGmail(db, userId);
    await connectGmailAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const [account] = await accountRows();
    expect(account.provider).toBe('gmail');
    await syncAccount(db, account);

    // Mock fixtures seed 4 threads per mailbox — primary and secondary carry
    // the same subjects but must be independent rows with prefixed ids.
    const acctThreads = await accountThreads(account.id);
    expect(acctThreads.length).toBe(4);
    expect(acctThreads.every((t) => t.gmail_thread_id.startsWith(`${account.id}:`))).toBe(true);
    const all = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    expect(all.length).toBe(8);
  });

  it('secondary gmail: reply sends through its own mailbox and marks read', async () => {
    await connectGmailAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);

    const dinner = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Sunday dinner'),
    )!;
    expect(dinner.is_unread).toBe(1);
    const detail = await sendAccountReply(db, userId, account.id, {
      threadRowId: dinner.id,
      body: 'We will be there at 5!',
    });
    expect(detail).not.toBeNull();
    expect(detail!.messages.some((m) => m.bodyText?.includes('be there at 5'))).toBe(true);
    expect(detail!.thread.isUnread).toBe(false);
    // The sent copy landed in the ACCOUNT's mirror, prefixed.
    const msgs = await db
      .selectFrom('email_messages')
      .select('gmail_message_id')
      .where('account_id', '=', account.id)
      .execute();
    expect(msgs.length).toBe(5);
    expect(msgs.every((m) => m.gmail_message_id.startsWith(`${account.id}:`))).toBe(true);
  });

  it('secondary gmail: archive round-trips the label API; disconnect cascades', async () => {
    await connectGmailAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);

    const pkg = (await accountThreads(account.id)).find((t) => t.subject.includes('package'))!;
    const summary = await applyAccountThreadModify(db, userId, account.id, pkg.id, {
      archive: true,
    });
    expect(summary?.isArchived).toBe(true);
    const listed = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    expect(listed.some((t) => t.id === pkg.id)).toBe(false);

    await disconnectAccount(db, userId, account.id);
    expect((await accountThreads(account.id)).length).toBe(0);
  });

  it('junk peek merges every mailbox and rescue lands the mail in the mirror', async () => {
    const { listJunkMail, rescueJunkMail } = await import(
      '@/services/email-accounts/junk.service.js'
    );
    await backfillGmail(db, userId); // primary (mock seeds one junk code)
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [imapAcct] = await accountRows();
    await syncAccount(db, imapAcct);

    const junk = await listJunkMail(db, userId);
    // One seeded junk fixture per mock mailbox: primary Gmail + the IMAP box.
    expect(junk.length).toBe(2);
    expect(junk.some((j) => j.mailbox === 'Gmail' && j.subject.includes('774051'))).toBe(true);
    expect(
      junk.some((j) => j.mailbox === 'family@yahoo.example' && j.subject.includes('481902')),
    ).toBe(true);
    // Junk is a live peek — nothing mirrored, nothing for the AI passes.
    const mirrored = await db
      .selectFrom('email_threads')
      .select('subject')
      .where('user_id', '=', userId)
      .execute();
    expect(mirrored.some((t) => t.subject.includes('774051'))).toBe(false);

    // Rescue the Gmail code → moves out of spam and mirrors on the sync.
    // (The mock's history feed is inert, so reconcile via a full backfill —
    // real Gmail reports the SPAM→INBOX transition through history.list.)
    const gmailKey = junk.find((j) => j.mailbox === 'Gmail')!.key;
    expect(await rescueJunkMail(db, userId, gmailKey)).toBe(true);
    await backfillGmail(db, userId);
    const after = await db
      .selectFrom('email_threads')
      .select(['subject', 'is_archived'])
      .where('user_id', '=', userId)
      .execute();
    const rescued = after.find((t) => t.subject.includes('774051'));
    expect(rescued).toBeDefined();
    expect(rescued!.is_archived).toBe(0);
    expect((await listJunkMail(db, userId)).some((j) => j.mailbox === 'Gmail')).toBe(false);

    // Rescue the IMAP code too — appears in the account mirror on sync.
    const imapKey = junk.find((j) => j.mailbox === 'family@yahoo.example')!.key;
    expect(await rescueJunkMail(db, userId, imapKey)).toBe(true);
    const imapThreads = await accountThreads(imapAcct.id);
    expect(imapThreads.some((t) => t.subject.includes('481902'))).toBe(true);

    // Unknown keys 404.
    expect(await rescueJunkMail(db, userId, 'nope:xyz')).toBe(false);
  });

  it('attachments surface in the reader and download from each provider', async () => {
    const { fetchEmailAttachmentData } = await import(
      '@/services/email-accounts/attachment-fetch.js'
    );
    const { __setOutlookMockAttachments } = await import(
      '@/services/email-accounts/outlook-api.js'
    );
    const { __setImapMockAttachment } = await import('@/services/email-accounts/imap-api.js');
    const { getThread } = await import('@/services/google/gmail.service.js');

    // Primary Gmail: the seeded flight email carries UA512-itinerary.txt.
    await backfillGmail(db, userId);
    const flightThread = (
      await db
        .selectFrom('email_threads')
        .select(['id'])
        .where('user_id', '=', userId)
        .where('subject', 'like', '%SFO%')
        .execute()
    )[0];
    const flightDetail = await getThread(db, userId, flightThread.id);
    const flightMsg = flightDetail!.messages.find((m) =>
      m.attachments?.some((a) => a.filename === 'UA512-itinerary.txt'),
    )!;
    expect(flightMsg).toBeDefined();
    const gmailAtt = flightMsg.attachments!.find((a) => a.filename === 'UA512-itinerary.txt')!;
    const gmailData = await fetchEmailAttachmentData(db, userId, flightMsg.id, gmailAtt.id);
    expect(gmailData!.buffer.toString('utf8')).toContain('confirmation KX8QP2');

    // The ADR 0071 knowledge-base copy keeps its link back to the source
    // email thread (Attachments tab → "View original email").
    const imported = await db
      .selectFrom('attachments')
      .select(['origin_email_thread_id'])
      .where('filename', '=', 'UA512-itinerary.txt')
      .executeTakeFirst();
    expect(imported?.origin_email_thread_id).toBe(flightThread.id);

    // Outlook: attach a receipt to the soccer email, discover on thread open.
    const account = await connectOutlook();
    __setOutlookMockAttachments(account.id, 'ol-msg-1', [
      {
        id: 'att-1',
        name: 'receipt.pdf',
        contentType: 'application/pdf',
        size: 11,
        contentBytes: Buffer.from('PDF-RECEIPT').toString('base64'),
      },
    ]);
    // ADR 0110 — attachment import now runs for every provider after a sync, so
    // by the time the mock gains a receipt the pass has already looked at this
    // message and settled `attachments_json` to []. Real mail does not sprout an
    // attachment after we read it; restore the "never looked" state the lazy
    // discovery path below is what this asserts.
    await db
      .updateTable('email_messages')
      .set({ attachments_json: null })
      .where('user_id', '=', userId)
      .where('gmail_message_id', 'like', '%ol-msg-1')
      .execute();
    const soccer = (await accountThreads(account.id)).find((t) => t.subject.includes('Soccer'))!;
    const detail = await getAccountThread(db, userId, account.id, soccer.id);
    const olMsg = detail!.messages.find((m) => m.attachments?.length)!;
    expect(olMsg.attachments![0].filename).toBe('receipt.pdf');
    const olData = await fetchEmailAttachmentData(db, userId, olMsg.id, 'att-1');
    expect(olData!.buffer.toString('utf8')).toBe('PDF-RECEIPT');
    expect(olData!.mimeType).toBe('application/pdf');

    // IMAP: statement attached to the school email; meta lands at sync.
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const imapAcct = (await accountRows()).find((a) => a.provider === 'imap')!;
    await syncAccount(db, imapAcct);
    __setImapMockAttachment(imapAcct.id, 101, 0, {
      filename: 'statement.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('STATEMENT-BYTES'),
    });
    // Real mail carries its attachments at arrival; the fixture gained one
    // after mirroring, so force a refetch of that UID.
    await db
      .deleteFrom('email_messages')
      .where('gmail_message_id', '=', `${imapAcct.id}:u101`)
      .execute();
    await syncAccount(db, imapAcct);
    const imapMsg = await db
      .selectFrom('email_messages')
      .select(['id', 'attachments_json'])
      .where('account_id', '=', imapAcct.id)
      .where('gmail_message_id', '=', `${imapAcct.id}:u101`)
      .executeTakeFirstOrThrow();
    const imapMeta = (imapMsg.attachments_json ?? [])[0];
    expect(imapMeta?.filename).toBe('statement.pdf');
    const imapData = await fetchEmailAttachmentData(db, userId, imapMsg.id, imapMeta!.id);
    expect(imapData!.buffer.toString('utf8')).toBe('STATEMENT-BYTES');
  });

  /** Stage a pending magic proposal against a thread, ADR 0063 shape. */
  async function stageProposal(threadGid: string): Promise<string> {
    const { createProposal } = await import('@/services/proposals.service.js');
    const { ensurePersonalGroup } = await import('@/services/groups.service.js');
    const personal = await ensurePersonalGroup(db, userId);
    const p = await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'Shopping', items: ['milk'] },
      provenance: `gmail:${threadGid}`,
      targetGroupId: null,
    });
    return p.id;
  }

  const proposalStatus = async (id: string) =>
    (
      await db
        .selectFrom('proposals')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  it('outlook: deleting the email retracts its to-do; archiving keeps it', async () => {
    const account = await connectOutlook();
    const threads = await accountThreads(account.id);
    const soccer = threads.find((t) => t.subject.includes('Soccer'))!;
    const receipt = threads.find((t) => t.subject.includes('receipt'))!;
    const soccerProp = await stageProposal(soccer.gmail_thread_id);
    const receiptProp = await stageProposal(receipt.gmail_thread_id);

    // Archive (moved out of Inbox, still in the mailbox) — the to-do stands.
    __removeOutlookMockMessage(account.id, 'ol-msg-1');
    // Delete (landed in Deleted Items) — the to-do dies with the email.
    __removeOutlookMockMessage(account.id, 'ol-msg-2', 'deleted');
    await syncAccount(db, account);

    expect(await proposalStatus(soccerProp)).toBe('pending');
    expect(await proposalStatus(receiptProp)).toBe('expired');
  });

  it('imap: a message moved to Trash retracts its to-do; archive keeps it', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const threads = await accountThreads(account.id);
    const picture = threads.find((t) => t.subject.includes('Picture day'))!;
    const pharmacy = threads.find((t) => t.subject.includes('prescription'))!;
    const pictureProp = await stageProposal(picture.gmail_thread_id);
    const pharmacyProp = await stageProposal(pharmacy.gmail_thread_id);

    __removeImapMockMessage(account.id, 101); // archived
    __removeImapMockMessage(account.id, 102, { toTrash: true }); // deleted
    await syncAccount(db, account);

    expect(await proposalStatus(pictureProp)).toBe('pending');
    expect(await proposalStatus(pharmacyProp)).toBe('expired');
  });

  // ADR 0215 — trash written from Chord ends where a trash done in the
  // provider already ends: out of every folder, its to-dos retracted, and a
  // later sync agreeing rather than bringing it back.
  it('outlook: trash from Chord moves to Deleted Items and retracts the to-do', async () => {
    const account = await connectOutlook();
    const soccer = (await accountThreads(account.id)).find((t) => t.subject.includes('Soccer'))!;
    const prop = await stageProposal(soccer.gmail_thread_id);

    const summary = await applyAccountThreadModify(db, userId, account.id, soccer.id, {
      trash: true,
    });

    expect(summary?.isArchived).toBe(true);
    expect(__outlookMockRemovalState(account.id, 'ol-msg-1')).toBe('deleted');
    expect(await proposalStatus(prop)).toBe('expired');
    await syncAccount(db, account);
    const listed = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    expect(listed.some((t) => t.subject.includes('Soccer'))).toBe(false);
    const archive = await listThreads(db, userId, { mode: 'traditional', folder: 'archive', limit: 100 });
    expect(archive.some((t) => t.subject.includes('Soccer'))).toBe(false);
  });

  it('imap: trash from Chord moves the inbox copies to Trash', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const picture = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Picture day'),
    )!;
    const prop = await stageProposal(picture.gmail_thread_id);

    await applyAccountThreadModify(db, userId, account.id, picture.id, { trash: true });

    expect(__imapMockTrashed(account.id)).toContain('<yh-101@school.example>');
    expect(await proposalStatus(prop)).toBe('expired');
    await syncAccount(db, account);
    const listed = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    expect(listed.some((t) => t.subject.includes('Picture day'))).toBe(false);
  });

  it('imap: trashing an email a second time is done, not refused', async () => {
    // Prod 2026-10-27: the reader sent Trash for the same email again; the
    // repeat came back as "could not move this message to Trash".
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const picture = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Picture day'),
    )!;

    await applyAccountThreadModify(db, userId, account.id, picture.id, { trash: true });
    await expect(
      applyAccountThreadModify(db, userId, account.id, picture.id, { trash: true }),
    ).resolves.toBeTruthy();
  });

  it('imap: archiving an email a second time is done, not refused', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const picture = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Picture day'),
    )!;

    await applyAccountThreadModify(db, userId, account.id, picture.id, { archive: true });
    await expect(
      applyAccountThreadModify(db, userId, account.id, picture.id, { archive: true }),
    ).resolves.toBeTruthy();
  });

  it('imap: no Trash folder refuses, and the thread stays in the inbox', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const picture = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Picture day'),
    )!;
    __setImapMockNoTrashFolder(account.id, true);

    await expect(
      applyAccountThreadModify(db, userId, account.id, picture.id, { trash: true }),
    ).rejects.toThrow(/Trash/);

    const listed = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    expect(listed.some((t) => t.id === picture.id)).toBe(true);
  });

  it('imap: an archived thread is refused rather than moved by a stale UID', async () => {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const picture = (await accountThreads(account.id)).find((t) =>
      t.subject.includes('Picture day'),
    )!;
    await applyAccountThreadModify(db, userId, account.id, picture.id, { archive: true });

    await expect(
      applyAccountThreadModify(db, userId, account.id, picture.id, { trash: true }),
    ).rejects.toThrow(/inbox/);
    expect(__imapMockTrashed(account.id)).not.toContain('<yh-101@school.example>');
  });

  it('secondary gmail: trash uses the trash call and leaves every folder', async () => {
    await connectGmailAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const [account] = await accountRows();
    await syncAccount(db, account);
    const pkg = (await accountThreads(account.id)).find((t) => t.subject.includes('package'))!;
    const prop = await stageProposal(pkg.gmail_thread_id);

    await applyAccountThreadModify(db, userId, account.id, pkg.id, { trash: true });

    expect(await proposalStatus(prop)).toBe('expired');
    const inbox = await listThreads(db, userId, { mode: 'traditional', limit: 100 });
    const archive = await listThreads(db, userId, { mode: 'traditional', folder: 'archive', limit: 100 });
    expect(inbox.some((t) => t.id === pkg.id)).toBe(false);
    expect(archive.some((t) => t.id === pkg.id)).toBe(false);
  });

  it('a folded mailbox carries what its mail made to its new account id', async () => {
    // Audit (ADR 0293 addendum + 0312): the fold reconnects a mailbox under a
    // NEW account id, but the rows its mail made kept `gmail:<old id>:…`, so
    // disconnecting the moved mailbox later removed none of them, and the
    // fresh mirror was mined a second time.
    const account = await connectOutlook();
    await settleBackgroundWork();
    const [thread] = await accountThreads(account.id);
    const native = thread!.gmail_thread_id.slice(account.id.length + 1);
    const groupId = (await ensurePersonalGroup(db, userId)).id;
    const task = await createTask(db, {
      groupId,
      createdBy: userId,
      title: 'Return the permission slip',
      sourceRawContext: `gmail:${thread!.gmail_thread_id}`,
    });
    await db
      .insertInto('email_extraction_marks')
      .values({ user_id: userId, gmail_thread_id: thread!.gmail_thread_id, kind: 'magic', created_at: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const target = await createUser(db, 'google-account');

    expect(await moveMailboxesTo(db, userId, target)).toEqual({ moved: 1, dropped: 0 });
    await settleBackgroundWork();

    const [moved] = await listAccounts(db, target);
    const ctx = await db.selectFrom('tasks').select('source_raw_context').where('id', '=', task.id).executeTakeFirstOrThrow();
    expect(ctx.source_raw_context).toBe(`gmail:${moved!.id}:${native}`);
    const marks = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', target)
      .execute();
    expect(marks.map((m) => m.gmail_thread_id)).toContain(`${moved!.id}:${native}`);
  });

  it('gmail backfill reverse-delete ignores account messages', async () => {
    const account = await connectOutlook();
    const before = (
      await db.selectFrom('email_messages').select('id').where('account_id', '=', account.id).execute()
    ).length;
    expect(before).toBeGreaterThan(0);

    // A full (untruncated) Gmail backfill reconciles absences — account rows
    // are not part of the Gmail snapshot and must survive.
    await backfillGmail(db, userId);
    const after = (
      await db.selectFrom('email_messages').select('id').where('account_id', '=', account.id).execute()
    ).length;
    expect(after).toBe(before);
  });
});
