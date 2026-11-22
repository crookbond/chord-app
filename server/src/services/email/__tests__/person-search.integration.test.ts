/**
 * Asking for a person's mail (ADR 0270), against mail written through the real
 * sync path with encryption on. Each case is a way it failed before:
 *   - "bill" matched billing@ and "5 bills to automate" as words;
 *   - from: read only the thread's LATEST sender, so a thread Bill started and
 *     the user answered last was not "from Bill";
 *   - nicknames and mail the user sent could not be asked for at all.
 * Plus a guard: date bounds compare instants. Every provider writes mail times
 * in UTC today, so a string compare happened to work; this pins it if one ever
 * keeps an offset.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { findEmailThreads } from '@/services/email/email-search.js';
import { prepareMailQuery } from '@/services/email/mail-query.js';
import { resolveCorrespondent } from '@/services/email/person-resolve.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const ME = 'me@family.test';
const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let userId: string;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function find(query: string, filters = {}): Promise<string[]> {
  const prepared = await prepareMailQuery(db, userId, query, filters);
  if (prepared.blocked) return [];
  const rows = await findEmailThreads(db, { ...prepared.find, userId, limit: 20, order: 'recent' });
  return rows.map((r) => r.subject);
}

beforeEach(async () => {
  legacy.CONTENT_LEGACY_TSV = false;
  db = await openTestDb();
  // After opening: openTestDb sets encryption back to its default.
  setContentEncryption(true);
  userId = await createUser(db, 'pat');
  await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
});

afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  setContentEncryption(false);
  await closeTestDb(db);
});

describe('a person asked for by name', () => {
  beforeEach(async () => {
    await seedSyncedMail(db, userId, { subject: 'Tee time Saturday?', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME], at: daysAgo(10) });
    await seedSyncedMail(db, userId, { subject: 'Your invoice is ready', fromName: 'Acme Billing', fromEmail: 'billing@acme.com', body: 'Your bill is ready.', at: daysAgo(1) });
    await seedSyncedMail(db, userId, { subject: '5 bills to automate', fromName: 'Money Weekly', fromEmail: 'news@moneyweekly.test', body: 'Read this email.', at: daysAgo(1) });
  });

  it('finds Bill, not billing@ or a newsletter about bills', async () => {
    expect(await find('emails from Bill')).toEqual(['Tee time Saturday?']);
    expect(await find('from:bill')).toEqual(['Tee time Saturday?']);
  });

  it('finds William when asked for Bill', async () => {
    await seedSyncedMail(db, userId, { subject: 'Board deck', fromName: 'Robert Jones', fromEmail: 'rjones@northfield.test', at: daysAgo(5) });
    expect(await find('emails from Bob')).toEqual(['Board deck']);
  });

  it('asks which Bill when two people match', async () => {
    await seedSyncedMail(db, userId, { subject: 'Q3 numbers', fromName: 'William Chen', fromEmail: 'wchen@acme-corp.test', at: daysAgo(4) });
    const r = await resolveCorrespondent(db, userId, 'Bill');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates.map((c) => c.name).sort()).toEqual(['Bill Smith', 'William Chen']);
    expect((await prepareMailQuery(db, userId, 'emails from Bill')).blocked).toBe(true);
    // A full name settles it.
    expect(await find('emails from Bill Smith')).toEqual(['Tee time Saturday?']);
  });

  it('leaves words that name nobody as the topic', async () => {
    await seedSyncedMail(db, userId, { subject: 'Field trip form', fromName: 'Lincoln Elementary', fromEmail: 'office@lincoln.test', body: 'aquarium visit', at: daysAgo(3) });
    const p = await prepareMailQuery(db, userId, 'mail from the aquarium');
    expect(p.find.fromAddresses).toBeUndefined();
    expect(await find('mail from the aquarium')).toEqual(['Field trip form']);
  });
});

describe('every message of a thread counts', () => {
  it('finds a thread Bill started even though the user replied last', async () => {
    const gmailThreadId = newId('gt');
    await seedSyncedMail(db, userId, { gmailThreadId, subject: 'Cabin weekend', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME], at: daysAgo(5) });
    await seedSyncedMail(db, userId, { gmailThreadId, subject: 'Re: Cabin weekend', fromName: 'Me', fromEmail: ME, toEmails: ['bill.test@gmail.com'], at: daysAgo(4) });
    await seedSyncedMail(db, userId, { subject: 'Unrelated', fromName: 'Ann Lee', fromEmail: 'ann@x.test', at: daysAgo(1) });
    const thread = await db.selectFrom('email_threads').select(['from_email']).where('gmail_thread_id', '=', gmailThreadId).executeTakeFirstOrThrow();
    expect(thread.from_email).toBe(ME);
    expect(await find('emails from Bill Smith')).toEqual(['Cabin weekend']);
  });
});

describe('mail the user sent', () => {
  it('finds mail sent to Bill by name and by address', async () => {
    await seedSyncedMail(db, userId, { subject: 'Tee time Saturday?', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME], at: daysAgo(10) });
    await seedSyncedMail(db, userId, { subject: 'Directions', fromName: 'Me', fromEmail: ME, toEmails: ['bill.test@gmail.com'], at: daysAgo(2) });
    await seedSyncedMail(db, userId, { subject: 'Note to Ann', fromName: 'Me', fromEmail: ME, toEmails: ['ann@x.test'], at: daysAgo(2) });
    expect(await find('emails I sent to Bill Smith')).toEqual(['Directions']);
    expect(await find('to:bill.test@gmail.com')).toEqual(['Directions']);
  });

  it('says none, rather than guessing, for a recipient the user never wrote to', async () => {
    await seedSyncedMail(db, userId, { subject: 'Note to Ann', fromName: 'Me', fromEmail: ME, toEmails: ['ann@x.test'], at: daysAgo(2) });
    expect(await find('', { to: 'Zelda' })).toEqual([]);
  });
});

describe('filters', () => {
  it('compares dates as instants, not strings', async () => {
    // 2026-10-10T22:00-04:00 is 2026-10-11T02:00Z: after a 2026-10-11T00:00Z bound.
    const id = await seedSyncedMail(db, userId, { subject: 'Late night', fromName: 'Ann', fromEmail: 'ann@x.test', at: '2026-10-10T20:00:00.000Z' });
    await db.updateTable('email_threads').set({ last_message_at: '2026-10-10T22:00:00-04:00' }).where('id', '=', id).execute();
    expect(await find('', { from: 'ann@x.test', after: '2026-10-11T00:00:00.000Z' })).toEqual(['Late night']);
  });

  it('narrows to threads carrying a receipt', async () => {
    const receipt = await seedSyncedMail(db, userId, { subject: 'Your Costco order', fromName: 'Costco', fromEmail: 'orders@costco.com', at: daysAgo(3) });
    await seedSyncedMail(db, userId, { subject: 'Costco weekly deals', fromName: 'Costco', fromEmail: 'deals@costco.com', at: daysAgo(1) });
    await db.updateTable('email_threads').set({ receipt_json: '{"merchant":"Costco"}' }).where('id', '=', receipt).execute();
    expect(await find('costco', { kind: 'receipt' })).toEqual(['Your Costco order']);
  });
});
