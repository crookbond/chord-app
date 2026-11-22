/**
 * Chord label push (ADR 0142) + label: search coverage beyond the operator
 * unit tests. Fixtures always include a message (ADR 0128 vacuous-thread trap).
 */
import { chordImapKeyword, chordProviderLabel } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  applyAccountThreadModify,
  connectImapAccount,
  connectOutlookAccount,
  setAccountPrefs,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { AccountValidationError } from '@/services/email-accounts/account-utils.js';
import {
  __imapMockKeywordOps,
  __resetImapMock,
  __setImapMockKeywordSupport,
} from '@/services/email-accounts/imap-api.js';
import {
  __outlookMockCategories,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import { applyChordLabelPatch } from '@/services/email/chord-labels.js';
import { pushChordLabels } from '@/services/email/chord-label-push.js';
import { listBrowsableLabels } from '@/services/email/labels.js';
import * as gmailApi from '@/services/google/gmail-api.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import {
  applyThreadModify,
  listThreads,
} from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

async function thread(): Promise<{ id: string; gid: string }> {
  const now = new Date().toISOString();
  const id = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'hi',
      from_email: 'a@x.example',
      gmail_label_ids: JSON.stringify(['INBOX']),
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: 'hi',
      snippet: 'hi',
      from_email: 'a@x.example',
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      gmail_label_ids: JSON.stringify(['INBOX']),
      is_unread: 0,
      ics_text: '',
      internal_date: now,
      created_at: now,
    })
    .execute();
  return { id, gid };
}

beforeEach(async () => {
  __resetGmailMock();
  __resetOutlookMock();
  __resetImapMock();
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  vi.restoreAllMocks();
  await closeTestDb(db);
});

describe('chordProviderLabel / chordImapKeyword', () => {
  it('prefixes Chord/ for Gmail and Outlook', () => {
    expect(chordProviderLabel('Family')).toBe('Chord/Family');
  });

  it('encodes IMAP atoms without spaces', () => {
    const kw = chordImapKeyword('School stuff');
    expect(kw.startsWith('Chord_')).toBe(true);
    expect(kw.includes(' ')).toBe(false);
  });
});

describe('push opt-in', () => {
  it('does not call the provider when push is off', async () => {
    const { id } = await thread();
    const spy = vi.spyOn(gmailApi, 'getGmailApi');

    await applyThreadModify(db, userId, id, { addChordLabels: ['Family'] });

    const row = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.chord_label_ids).toEqual(['Family']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still applies locally when push throws', async () => {
    const { id } = await thread();
    await db
      .updateTable('users')
      .set({ chord_label_push_enabled: 1 })
      .where('id', '=', userId)
      .execute();

    vi.spyOn(gmailApi, 'getGmailApi').mockRejectedValue(new Error('provider down'));

    await applyChordLabelPatch(db, userId, id, { addChordLabels: ['Family'] });
    await pushChordLabels(db, userId, id, { addChordLabels: ['Family'] });

    const row = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.chord_label_ids).toEqual(['Family']);
  });
});

describe('Gmail push', () => {
  it('creates Chord/Family and modifies the thread when opted in', async () => {
    const { id } = await thread();
    await db
      .updateTable('users')
      .set({ chord_label_push_enabled: 1 })
      .where('id', '=', userId)
      .execute();

    await applyThreadModify(db, userId, id, { addChordLabels: ['Family'] });

    const api = await gmailApi.getGmailApi(db, userId);
    const labels = await api.listLabels();
    expect(labels.some((l) => l.name === 'Chord/Family')).toBe(true);

    const row = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.chord_label_ids).toEqual(['Family']);
  });

  it('browse still finds labelled+archived mail after a push path', async () => {
    const { id } = await thread();
    await db
      .updateTable('users')
      .set({ chord_label_push_enabled: 1 })
      .where('id', '=', userId)
      .execute();

    await applyThreadModify(db, userId, id, { addChordLabels: ['Family'] });
    await db
      .updateTable('email_threads')
      .set({ is_archived: 1, gmail_label_ids: JSON.stringify([]) })
      .where('id', '=', id)
      .execute();

    const labels = await listBrowsableLabels(db, userId);
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'Family', scope: 'chord', threads: 1 }),
      ]),
    );
    const rows = await listThreads(db, userId, { labelId: 'Family' });
    expect(rows.map((r) => r.id)).toEqual([id]);
  });
});

describe('Outlook categories', () => {
  async function connectOutlook() {
    await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const account = await db
      .selectFrom('email_accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    await syncAccount(db, account);
    return account;
  }

  it('writes Chord/Family categories when the mailbox is opted in', async () => {
    const account = await connectOutlook();
    await setAccountPrefs(db, userId, account.id, { labelPushEnabled: true });

    const soccer = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('account_id', '=', account.id)
      .execute()
      .then((rows) => rows.find((t) => t.subject.includes('Soccer'))!);

    await applyAccountThreadModify(db, userId, account.id, soccer.id, {
      addChordLabels: ['Family'],
    });

    const msg = await db
      .selectFrom('email_messages')
      .select('gmail_message_id')
      .where('thread_id', '=', soccer.id)
      .executeTakeFirstOrThrow();
    const native = msg.gmail_message_id.slice(account.id.length + 1);
    expect(__outlookMockCategories(account.id, native)).toContain('Chord/Family');

    const row = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('id', '=', soccer.id)
      .executeTakeFirstOrThrow();
    expect(row.chord_label_ids).toEqual(['Family']);
  });

  it('still applies locally when Outlook setCategories throws', async () => {
    const account = await connectOutlook();
    await setAccountPrefs(db, userId, account.id, { labelPushEnabled: true });
    const soccer = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('account_id', '=', account.id)
      .execute()
      .then((rows) => rows.find((t) => t.subject.includes('Soccer'))!);

    const outlook = await import('@/services/email-accounts/outlook-api.js');
    vi.spyOn(outlook, 'getOutlookApi').mockRejectedValue(new Error('graph down'));

    await applyAccountThreadModify(db, userId, account.id, soccer.id, {
      addChordLabels: ['Family'],
    });

    const row = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('id', '=', soccer.id)
      .executeTakeFirstOrThrow();
    expect(row.chord_label_ids).toEqual(['Family']);
  });
});

describe('IMAP keywords', () => {
  async function connectImap() {
    await connectImapAccount(db, userId, {
      emailAddress: 'family@yahoo.example',
      password: 'app-password',
      preset: 'yahoo',
    });
    const account = await db
      .selectFrom('email_accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    await syncAccount(db, account);
    return (
      (await db
        .selectFrom('email_accounts')
        .selectAll()
        .where('id', '=', account.id)
        .executeTakeFirstOrThrow())
    );
  }

  it('refuses opt-in when keywords are unsupported; local apply still works', async () => {
    // Connect probe uses verify:<userId>; sync re-probes under account.id.
    __setImapMockKeywordSupport(`verify:${userId}`, false);
    const account = await connectImap();
    __setImapMockKeywordSupport(account.id, false);
    const { recordImapLabelPushSupport } = await import(
      '@/services/email/chord-label-push.js'
    );
    await recordImapLabelPushSupport(db, account.id, false);

    const fresh = await db
      .selectFrom('email_accounts')
      .select(['label_push_supported', 'label_push_enabled'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(Number(fresh.label_push_supported)).toBe(0);

    await expect(
      setAccountPrefs(db, userId, account.id, { labelPushEnabled: true }),
    ).rejects.toBeInstanceOf(AccountValidationError);

    const picture = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('account_id', '=', account.id)
      .execute()
      .then((rows) => rows.find((t) => t.subject.includes('Picture day'))!);

    await applyAccountThreadModify(db, userId, account.id, picture.id, {
      addChordLabels: ['Family'],
    });

    const row = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('id', '=', picture.id)
      .executeTakeFirstOrThrow();
    expect(row.chord_label_ids).toEqual(['Family']);
    expect(__imapMockKeywordOps(account.id)).toHaveLength(0);
  });

  it('batches STORE keywords for every UID on the thread in one call', async () => {
    const account = await connectImap();
    expect(Number(account.label_push_supported)).toBe(1);
    await setAccountPrefs(db, userId, account.id, { labelPushEnabled: true });

    const picture = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('account_id', '=', account.id)
      .execute()
      .then((rows) => rows.find((t) => t.subject.includes('Picture day'))!);

    // Second UID on the same thread so push must batch, not loop logins.
    // 101/102 are both seeded by the mock on DIFFERENT threads, so a second UID
    // for this one has to be a fresh number.
    const now = new Date().toISOString();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: picture.id,
        account_id: account.id,
        gmail_message_id: `${account.id}:u103`,
        gmail_thread_id: picture.gmail_thread_id,
        subject: picture.subject,
        snippet: 'follow-up',
        from_email: 'office@school.example',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        gmail_label_ids: JSON.stringify(['INBOX']),
        is_unread: 0,
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();

    await applyAccountThreadModify(db, userId, account.id, picture.id, {
      addChordLabels: ['School stuff'],
    });

    const ops = __imapMockKeywordOps(account.id);
    expect(ops).toHaveLength(1);
    expect(ops[0].uids.sort((a, b) => a - b)).toEqual([101, 103]);
    expect(ops[0].add).toEqual([chordImapKeyword('School stuff')]);
  });
});
