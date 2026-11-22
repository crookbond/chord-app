/**
 * The list surface (ADR 0119): which mailbox a row came from, filtering to one,
 * and paging past the first screenful.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedAccount(address: string): Promise<string> {
  const id = newId('eac');
  const now = new Date().toISOString();
  await db
    .insertInto('email_accounts')
    .values({
      id,
      user_id: userId,
      provider: 'imap',
      email_address: address,
      status: 'ok',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function seedThread(subject: string, at: string, accountId: string | null): Promise<void> {
  const id = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      account_id: accountId,
      gmail_thread_id: id,
      subject,
      gmail_label_ids: JSON.stringify(['INBOX']),
      last_message_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`;

describe('which mailbox a row came from', () => {
  it('carries the account and its address', async () => {
    const acct = await seedAccount('family@yahoo.example');
    await seedThread('From Yahoo', at(20), acct);

    const [row] = await listThreads(db, userId, {});

    expect(row.accountId).toBe(acct);
    expect(row.accountEmail).toBe('family@yahoo.example');
  });

  it('leaves the primary mailbox unlabelled', async () => {
    // account_id NULL is ADR 0080's convention for the Gmail on the user row,
    // and there is no email_accounts row to join to.
    await seedThread('From Gmail', at(20), null);

    const [row] = await listThreads(db, userId, {});

    expect(row.accountId).toBeNull();
    expect(row.accountEmail).toBeNull();
  });
});

describe('filtering to one mailbox', () => {
  it('shows only that account', async () => {
    const acct = await seedAccount('family@yahoo.example');
    await seedThread('From Yahoo', at(20), acct);
    await seedThread('From Gmail', at(21), null);

    const rows = await listThreads(db, userId, { accountId: acct });

    expect(rows.map((r) => r.subject)).toEqual(['From Yahoo']);
  });

  it('says "primary" for the mailbox whose id is null', async () => {
    // An empty string cannot express "the one with no id", so the filter needs
    // a word for it.
    const acct = await seedAccount('family@yahoo.example');
    await seedThread('From Yahoo', at(20), acct);
    await seedThread('From Gmail', at(21), null);

    const rows = await listThreads(db, userId, { accountId: 'primary' });

    expect(rows.map((r) => r.subject)).toEqual(['From Gmail']);
  });

  it('shows everything with no filter', async () => {
    const acct = await seedAccount('family@yahoo.example');
    await seedThread('From Yahoo', at(20), acct);
    await seedThread('From Gmail', at(21), null);

    expect(await listThreads(db, userId, {})).toHaveLength(2);
  });
});

describe('paging', () => {
  it('continues after the row the client last saw', async () => {
    for (const day of [18, 19, 20, 21]) await seedThread(`Day ${day}`, at(day), null);

    const first = await listThreads(db, userId, { limit: 2 });
    const next = await listThreads(db, userId, {
      limit: 2,
      cursor: first[first.length - 1].lastMessageAt,
    });

    expect(first.map((r) => r.subject)).toEqual(['Day 21', 'Day 20']);
    expect(next.map((r) => r.subject)).toEqual(['Day 19', 'Day 18']);
  });

  it('does not repeat a row when new mail lands mid-scroll', async () => {
    // The reason the cursor is a timestamp rather than an offset: an OFFSET
    // shifts by one when something is inserted above, and the page boundary
    // silently repeats or skips.
    for (const day of [18, 19, 20]) await seedThread(`Day ${day}`, at(day), null);
    const first = await listThreads(db, userId, { limit: 2 });
    await seedThread('Arrived just now', at(28), null);

    const next = await listThreads(db, userId, {
      limit: 2,
      cursor: first[first.length - 1].lastMessageAt,
    });

    expect(next.map((r) => r.subject)).toEqual(['Day 18']);
  });

  it('keeps the folder and account filters across pages', async () => {
    const acct = await seedAccount('family@yahoo.example');
    for (const day of [18, 19, 20]) await seedThread(`Yahoo ${day}`, at(day), acct);
    await seedThread('Gmail 21', at(21), null);

    const first = await listThreads(db, userId, { accountId: acct, limit: 2 });
    const next = await listThreads(db, userId, {
      accountId: acct,
      limit: 2,
      cursor: first[first.length - 1].lastMessageAt,
    });

    expect(first.map((r) => r.subject)).toEqual(['Yahoo 20', 'Yahoo 19']);
    expect(next.map((r) => r.subject)).toEqual(['Yahoo 18']);
  });
});
