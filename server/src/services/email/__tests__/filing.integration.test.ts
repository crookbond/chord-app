/**
 * Filing rules (ADR 0309): mail from a sender or a domain goes into a folder
 * on the user's own mailbox, made there if it does not exist, after a sync.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { connectImapAccount, connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { __imapMockFiled, __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { __outlookMockFiled, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import {
  __resetFilingFailures,
  addFilingRule,
  applyFilingRules,
  checkFolderName,
  listFilingRules,
  parseMatch,
  ruleFor,
  type FilingRule,
} from '@/services/email/filing.service.js';
import { setAutoTrash } from '@/services/email/auto-trash.service.js';
import { closeParallelHandle, closeTestDb, createUser, openParallelHandle, openTestDb } from '@/__test-helpers__/db.js';

describe('filing rule matching', () => {
  const rule = (kind: 'sender' | 'domain', value: string, folder: string): FilingRule => ({
    id: `${kind}:${value}`,
    kind,
    value,
    folder,
    since: new Date(0).toISOString(),
  });

  it('reads an address as a sender and a bare domain as a domain', () => {
    expect(parseMatch('Bill@Example.com')).toEqual({ kind: 'sender', value: 'bill@example.com' });
    expect(parseMatch('@school.org')).toEqual({ kind: 'domain', value: 'school.org' });
    expect(parseMatch('Bill Mills')).toBeNull();
  });

  it('matches a domain and its subdomains, and an exact sender beats a domain', () => {
    const rules = [rule('domain', 'school.org', 'School'), rule('sender', 'principal@school.org', 'Principal')];
    expect(ruleFor(rules, 'news@school.org')?.folder).toBe('School');
    expect(ruleFor(rules, 'alerts@mail.school.org')?.folder).toBe('School');
    expect(ruleFor(rules, 'x@notschool.org')).toBeNull();
    expect(ruleFor(rules, 'Principal@School.org')?.folder).toBe('Principal');
  });

  it('refuses the mailbox\'s own folders and malformed names', () => {
    expect(checkFolderName('  Inbox ')).toEqual({ ok: false, reason: 'reserved_folder' });
    expect(checkFolderName('Trash')).toEqual({ ok: false, reason: 'reserved_folder' });
    expect(checkFolderName('/School')).toEqual({ ok: false, reason: 'bad_folder' });
    expect(checkFolderName('Kids/School')).toEqual({ ok: true, folder: 'Kids/School' });
  });
});

describe('filing rules on a mailbox', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    __resetOutlookMock();
    __resetImapMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'filer');
  });
  afterEach(async () => {
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
    await closeTestDb(db);
  });

  const inboxThread = async (subjectLike: string) =>
    db
      .selectFrom('email_threads')
      .select(['id', 'from_email', 'subject', 'is_archived'])
      .where('user_id', '=', userId)
      .where('subject', 'like', subjectLike)
      .executeTakeFirstOrThrow();

  it('files Outlook mail into a folder it creates, and the thread leaves the inbox', async () => {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const soccer = await inboxThread('Soccer%');
    const domain = soccer.from_email!.split('@')[1]!;

    const added = await addFilingRule(db, userId, { from: domain, folder: 'Sports', alsoExisting: true });
    expect(added.ok).toBe(true);
    expect(await applyFilingRules(db, userId)).toBeGreaterThanOrEqual(1);

    expect(__outlookMockFiled(account!.id).get('Sports')).toContain(soccer.subject);
    expect((await inboxThread('Soccer%')).is_archived).toBe(1);
  });

  it('a thread the mailbox refuses is not retried on every sync', async () => {
    // Audit: a refused thread was tried again on every pass forever - a
    // provider call (an IMAP login) per thread per sync.
    __resetFilingFailures();
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const soccer = await inboxThread('Soccer%');
    // Outlook refuses nested folders (Gmail-only).
    await addFilingRule(db, userId, { from: soccer.from_email!, folder: 'Sports/Kids', alsoExisting: true });
    const warn = vi.spyOn(logger, 'warn');
    const refusals = () => warn.mock.calls.filter((c) => (c[0] as unknown) === 'filing rule could not file a thread').length;

    await applyFilingRules(db, userId);
    expect(refusals()).toBe(1);
    await applyFilingRules(db, userId);
    await applyFilingRules(db, userId);
    expect(refusals()).toBe(1);
    warn.mockRestore();
    __resetFilingFailures();
  });

  it('files IMAP mail into a mailbox it creates', async () => {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const picture = await inboxThread('Picture day%');

    await addFilingRule(db, userId, { from: picture.from_email!, folder: 'School', alsoExisting: true });
    expect(await applyFilingRules(db, userId)).toBe(1);

    expect(__imapMockFiled(account!.id).get('School')).toEqual([picture.subject]);
    expect((await inboxThread('Picture day%')).is_archived).toBe(1);
  });

  it('leaves mail that was already there when the rule only covers new mail', async () => {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const picture = await inboxThread('Picture day%');

    await addFilingRule(db, userId, { from: picture.from_email!, folder: 'School' });
    expect(await applyFilingRules(db, userId)).toBe(0);
    expect((await inboxThread('Picture day%')).is_archived).toBe(0);
  });

  it('does not file a sender whose mail goes to Trash', async () => {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const picture = await inboxThread('Picture day%');

    await addFilingRule(db, userId, { from: picture.from_email!, folder: 'School', alsoExisting: true });
    await setAutoTrash(db, userId, [picture.from_email!], true);
    expect(await applyFilingRules(db, userId)).toBe(0);
  });

  it('moves an existing rule to a new folder instead of adding a second', async () => {
    await addFilingRule(db, userId, { from: 'school.org', folder: 'School' });
    await addFilingRule(db, userId, { from: 'School.org', folder: 'Kids' });
    expect((await listFilingRules(db, userId)).map((r) => [r.value, r.folder])).toEqual([['school.org', 'Kids']]);
  });
});

describe('filing rules under concurrent writes', () => {
  // Audit: addFilingRule was a read-modify-write of users.defaults with no
  // lock, so rules added at the same moment overwrote each other.
  let db: Kysely<DB>;
  let par: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    par = openParallelHandle(db);
    userId = await createUser(db, 'filer');
  });
  afterEach(async () => {
    await closeParallelHandle(par);
    await closeTestDb(db);
  });

  it('rules added at once all land', async () => {
    const from = Array.from({ length: 6 }, (_, i) => `coach${i}@league.example`);
    const results = await Promise.all(from.map((f) => addFilingRule(par, userId, { from: f, folder: 'Soccer' })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await listFilingRules(db, userId)).map((r) => r.value).sort()).toEqual([...from].sort());
  });
});
