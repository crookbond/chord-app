/**
 * "Show me emails from deloitte", as asked in prod (2026-10-23). The user's
 * Deloitte mail was mostly mail THEY sent, to jeobrien@ and andrewallen5@:
 *   - the company word matched every Deloitte address through its domain, the
 *     people tied, and the bot asked "which one" instead of searching the domain;
 *   - the people it offered came from To/Cc, so "from Jessica" then found
 *     nothing - she had never sent the user mail;
 *   - a To/Cc address has no name, and the bot was told to list names, so it
 *     made one up: andrewallen5@ became "Andrea Allen".
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { findEmailThreads } from '@/services/email/email-search.js';
import { askWhichPersonInstruction, prepareMailQuery } from '@/services/email/mail-query.js';
import { resolveCorrespondent } from '@/services/email/person-resolve.js';
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
  return rows.map((r) => r.subject).sort();
}

beforeEach(async () => {
  legacy.CONTENT_LEGACY_TSV = false;
  db = await openTestDb();
  setContentEncryption(true);
  userId = await createUser(db, 'pat');
  await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();

  // Mail the user sent to Deloitte people, who never wrote back.
  await seedSyncedMail(db, userId, { subject: 'Engagement scope', fromName: 'Me', fromEmail: ME, toEmails: ['jodaly@deloitte.com'], at: daysAgo(9) });
  await seedSyncedMail(db, userId, { subject: 'Follow-up on audit', fromName: 'Me', fromEmail: ME, toEmails: ['andrewallen5@deloitte.com'], ccEmails: ['akstone9@deloitte.com'], at: daysAgo(8) });
  await seedSyncedMail(db, userId, { subject: 'Kickoff notes', fromName: 'Me', fromEmail: ME, toEmails: ['akturner@deloitte.com', 'rbrown@deloitte.com'], at: daysAgo(7) });
  // What Deloitte actually sent the user.
  await seedSyncedMail(db, userId, { subject: 'Your engagement letter', fromName: 'Priya Shah', fromEmail: 'priya.shah@deloitte.com', toEmails: [ME], at: daysAgo(3) });
  await seedSyncedMail(db, userId, { subject: 'Invoice 4471', fromName: 'Deloitte Billing', fromEmail: 'billing@deloitte.com', toEmails: [ME], at: daysAgo(2) });
  await seedSyncedMail(db, userId, { subject: 'Unrelated', fromName: 'Ann Lee', fromEmail: 'ann@x.test', toEmails: [ME], at: daysAgo(1) });
});

afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  setContentEncryption(false);
  await closeTestDb(db);
});

describe('a company name', () => {
  it('searches the whole domain instead of asking which person', async () => {
    const r = await resolveCorrespondent(db, userId, 'deloitte');
    expect(r.status).toBe('domain');
    expect(r.domains).toEqual(['deloitte.com']);
    const p = await prepareMailQuery(db, userId, '', { from: 'deloitte' });
    expect(p.blocked).toBe(false);
    expect(await find('', { from: 'deloitte' })).toEqual(['Invoice 4471', 'Your engagement letter']);
    expect(await find('emails from deloitte')).toEqual(['Invoice 4471', 'Your engagement letter']);
  });

  it('finds what the user sent to the company the same way', async () => {
    expect(await find('', { to: 'deloitte' })).toEqual(['Engagement scope', 'Follow-up on audit', 'Kickoff notes']);
  });

  it('is still a person when the name matches the person too', async () => {
    const r = await resolveCorrespondent(db, userId, 'priya deloitte', { direction: 'from' });
    expect(r.status).toBe('resolved');
    expect(r.addresses).toEqual(['priya.shah@deloitte.com']);
  });
});

describe('who is offered for "from"', () => {
  beforeEach(async () => {
    await seedSyncedMail(db, userId, { subject: 'Lunch?', fromName: 'Jessica Park', fromEmail: 'jpark@park.test', toEmails: [ME], at: daysAgo(4) });
    await seedSyncedMail(db, userId, { subject: 'Draft memo', fromName: 'Me', fromEmail: ME, toEmails: ['jessica.obrien@deloitte.com'], at: daysAgo(4) });
  });

  it('offers only people who sent the user mail', async () => {
    const r = await resolveCorrespondent(db, userId, 'jessica', { direction: 'from' });
    expect(r.status).toBe('resolved');
    expect(r.addresses).toEqual(['jpark@park.test']);
    expect(await find('', { from: 'jessica' })).toEqual(['Lunch?']);
  });

  it('offers only people the user wrote to for "to"', async () => {
    const r = await resolveCorrespondent(db, userId, 'jessica', { direction: 'to' });
    expect(r.status).toBe('resolved');
    expect(r.addresses).toEqual(['jessica.obrien@deloitte.com']);
  });
});

describe('asking which one', () => {
  it('lists a nameless address as an address, never a made-up name', () => {
    const text = askWhichPersonInstruction([
      {
        role: 'to',
        asked: 'allen',
        status: 'ambiguous',
        candidates: [
          { name: null, emails: ['andrewallen5@deloitte.com'], count: 1 },
          { name: 'Ravi Allen', emails: ['ravi@allen.test'], count: 1 },
        ],
      },
    ]);
    expect(text).toContain('andrewallen5@deloitte.com (name not known)');
    expect(text).toContain('Ravi Allen <ravi@allen.test>');
    expect(text).not.toMatch(/Andrea/);
  });
});
