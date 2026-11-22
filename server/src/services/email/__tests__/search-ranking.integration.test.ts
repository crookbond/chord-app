/**
 * How chat search orders mail (ADR 0271), through `searchEverything` as the
 * bot's `search` tool calls it, on sealed, blind-indexed mail. Each case is a
 * way the old order went wrong:
 *   - the bot path sorted by date, so a newer email mentioning ONE of the
 *     words beat the older one matching all of them;
 *   - a category the query named replaced the keyword results (ADR 0152), so
 *     a thread with the word in its subject but filed elsewhere vanished.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { searchEverything } from '@/services/search.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let userId: string;
let groupId: string;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function subjects(query: string): Promise<string[]> {
  const r = await searchEverything(db, { userId, groupId, crossGroup: true, query, categories: ['emails'], perCategory: 10 });
  return r.emails.map((e) => e.subject);
}

beforeEach(async () => {
  legacy.CONTENT_LEGACY_TSV = false;
  db = await openTestDb();
  // After opening: openTestDb sets encryption back to its default.
  setContentEncryption(true);
  userId = await createUser(db, 'pat');
  groupId = (await ensurePersonalGroup(db, userId)).id;
});

afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  setContentEncryption(false);
  await closeTestDb(db);
});

describe('relevance, not date', () => {
  it('puts the thread matching every word above a newer one matching one', async () => {
    await seedSyncedMail(db, userId, { subject: 'Your Costco receipt', fromName: 'Costco', fromEmail: 'orders@costco.com', body: 'Total $84.17', at: daysAgo(20) });
    await seedSyncedMail(db, userId, { subject: 'Weekly deals', fromName: 'Target', fromEmail: 'deals@target.test', body: 'Show this receipt at checkout', at: daysAgo(1) });
    expect(await subjects('costco receipt')).toEqual(['Your Costco receipt', 'Weekly deals']);
  });

  it('weighs a subject match over a match deep in a body', async () => {
    await seedSyncedMail(db, userId, { subject: 'Plumber visit Tuesday', fromName: 'Mike', fromEmail: 'mike@fix.test', at: daysAgo(30) });
    await seedSyncedMail(db, userId, { subject: 'Neighborhood news', fromName: 'HOA', fromEmail: 'hoa@street.test', body: 'Ask around if you need a plumber.', at: daysAgo(2) });
    expect((await subjects('plumber'))[0]).toBe('Plumber visit Tuesday');
  });
});

describe('files that came with the mail', () => {
  it('a person search returns their attachments, labelled with the email', async () => {
    const bill = await seedSyncedMail(db, userId, { subject: 'Cabin rental agreement', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', at: daysAgo(5) });
    const other = await seedSyncedMail(db, userId, { subject: 'Invoice', fromName: 'Acme', fromEmail: 'billing@acme.com', at: daysAgo(2) });
    const now = new Date().toISOString();
    for (const [id, filename, thread] of [
      ['att_bill', 'cabin-agreement.pdf', bill],
      ['att_acme', 'invoice-4471.pdf', other],
    ] as const) {
      await db
        .insertInto('attachments')
        .values({
          id,
          scope_kind: 'group',
          scope_id: groupId,
          uploaded_by: userId,
          filename,
          mime_type: 'application/pdf',
          size: 10,
          path: `t/${id}`,
          summary: null,
          extracted_text: null,
          pinned: 0,
          index_requested: 0,
          origin_email_thread_id: thread,
          created_at: now,
        })
        .execute();
    }
    const r = await searchEverything(db, { userId, groupId, crossGroup: true, query: '', mailFilters: { from: 'Bill Smith' } });
    expect(r.files.map((f) => [f.filename, f.emailSubject])).toEqual([['cabin-agreement.pdf', 'Cabin rental agreement']]);
  });
});

describe('a category the query names', () => {
  beforeEach(async () => {
    const now = new Date().toISOString();
    await db.insertInto('email_categories').values({ id: `${userId}:mk:school`, user_id: userId, parent_id: null, title: 'School', depth: 0, sort_order: 0, color: null, icon: null, gmail_label_id: null, updated_at: now }).execute();
    const filed = await seedSyncedMail(db, userId, { subject: 'Picture day reminder', fromName: 'Lincoln Elementary', fromEmail: 'office@lincoln.test', at: daysAgo(3) });
    await db.updateTable('email_threads').set({ category_id: `${userId}:mk:school` }).where('id', '=', filed).execute();
    await seedSyncedMail(db, userId, { subject: 'School supplies list', fromName: 'Staples', fromEmail: 'hello@staples.test', at: daysAgo(4) });
    await seedSyncedMail(db, userId, { subject: 'October district update', fromName: 'District', fromEmail: 'news@district.test', body: 'Bus routes, and the school calendar is online.', at: daysAgo(1) });
  });

  it('adds the subject match to the category, and still leaves out the body-only newsletter', async () => {
    const got = await subjects('school');
    expect(got.slice(0, 2).sort()).toEqual(['Picture day reminder', 'School supplies list']);
    expect(got).not.toContain('October district update');
  });
});
