/**
 * Keeping search vectors current, and using them (ADR 0276), on sealed mail.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { MockEmbedder, type Embedder } from '@/services/llm/embeddings.js';
import { runEmbedPass } from '@/services/search/embed-pass.js';
import { __resetSemanticCachesForTests } from '@/services/search/semantic.js';
import { searchEverything } from '@/services/search.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const ME = 'me@family.test';
const flags = env as { EMBEDDINGS_ENABLED: boolean; CONTENT_LEGACY_TSV: boolean };
const saved = { EMBEDDINGS_ENABLED: env.EMBEDDINGS_ENABLED, CONTENT_LEGACY_TSV: env.CONTENT_LEGACY_TSV };

let db: Kysely<DB>;
let userId: string;
let groupId: string;

/** Counts what it was asked to embed; reports tokens like a real provider. */
class CountingEmbedder implements Embedder {
  readonly inner = new MockEmbedder();
  calls: string[][] = [];
  constructor(
    readonly id = 'count@256',
    readonly metered = true,
  ) {}
  readonly dims = 256;
  readonly paidBy = 'chord' as const;
  async embed(texts: string[]) {
    this.calls.push(texts);
    const r = await this.inner.embed(texts);
    return { vectors: r.vectors, tokens: texts.length * 10 };
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(async () => {
  flags.CONTENT_LEGACY_TSV = false;
  db = await openTestDb();
  // After opening: openTestDb sets encryption back to its default.
  setContentEncryption(true);
  userId = await createUser(db, 'pat');
  await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
  groupId = (await ensurePersonalGroup(db, userId)).id;
  __resetSemanticCachesForTests();
});

afterEach(async () => {
  Object.assign(flags, saved);
  setContentEncryption(false);
  await closeTestDb(db);
});

describe('runEmbedPass', () => {
  it('embeds newest first within its budget, sealed, and meters Chord-paid tokens', async () => {
    for (let i = 0; i < 5; i++) await seedSyncedMail(db, userId, { subject: `Note ${i}`, fromEmail: 'a@x.test', at: daysAgo(i) });
    const em = new CountingEmbedder();
    expect(await runEmbedPass(db, userId, { embedder: em, budget: 3 })).toEqual({ threads: 3, files: 0 });
    expect(em.calls[0].map((t) => t.split('\n')[0])).toEqual(['Subject: Note 0', 'Subject: Note 1', 'Subject: Note 2']);

    const rows = await db.selectFrom('email_thread_embeddings').select(['vec', 'model']).execute();
    expect(rows).toHaveLength(3);
    // Sealed: the stored bytes are an envelope, not the 4 + 256 raw ones.
    expect(rows[0].vec.length).toBeGreaterThan(4 + 256);
    const usage = await db.selectFrom('token_usage').select(['source', 'prompt_tokens']).execute();
    expect(usage).toEqual([{ source: 'embedding', prompt_tokens: 30 }]);

    expect(await runEmbedPass(db, userId, { embedder: em, budget: 10 })).toEqual({ threads: 2, files: 0 });
  });

  it('does not pay twice for unchanged text, and re-embeds when the model changes', async () => {
    const id = await seedSyncedMail(db, userId, { subject: 'Cabin', fromEmail: 'a@x.test' });
    const em = new CountingEmbedder();
    await runEmbedPass(db, userId, { embedder: em });
    // The thread is touched (a label) but its text is the same.
    await db.updateTable('email_threads').set({ updated_at: new Date(Date.now() + 1000).toISOString() }).where('id', '=', id).execute();
    await runEmbedPass(db, userId, { embedder: em });
    expect(em.calls).toHaveLength(1);

    const other = new CountingEmbedder('other@256');
    expect((await runEmbedPass(db, userId, { embedder: other })).threads).toBe(1);
    expect((await db.selectFrom('email_thread_embeddings').select('model').executeTakeFirstOrThrow()).model).toBe('other@256');
  });

  it("never meters a key the user pays for", async () => {
    await seedSyncedMail(db, userId, { subject: 'Cabin', fromEmail: 'a@x.test' });
    await runEmbedPass(db, userId, { embedder: new CountingEmbedder('own@256', false) });
    expect(await db.selectFrom('token_usage').selectAll().execute()).toEqual([]);
  });
});

describe('search by meaning', () => {
  beforeEach(async () => {
    await seedSyncedMail(db, userId, { subject: 'Field trip form due Friday', fromName: 'Lincoln Elementary', fromEmail: 'office@lincoln.test', body: 'Sign the permission slip for the aquarium.', at: daysAgo(3) });
    await seedSyncedMail(db, userId, { subject: 'Cabin weekend', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME], body: 'Bring the kayaks.', at: daysAgo(2) });
    await seedSyncedMail(db, userId, { subject: 'Kids outing paperwork', fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com', toEmails: [ME], body: 'The excursion form for scouts.', at: daysAgo(9) });
  });

  const find = async (query: string, from?: string) => {
    const r = await searchEverything(db, { userId, groupId, crossGroup: true, query, categories: ['emails'], mailFilters: from ? { from } : {} });
    return r.emails.map((e) => [e.subject, e.matchedBy ?? 'words']);
  };

  it('finds an email that shares no word with the question', async () => {
    flags.EMBEDDINGS_ENABLED = true;
    await runEmbedPass(db, userId);
    expect(await find('kids excursion paperwork')).toContainEqual(['Field trip form due Friday', 'meaning']);
  });

  it('keeps the person filter: meaning matches from anyone else are left out', async () => {
    flags.EMBEDDINGS_ENABLED = true;
    await runEmbedPass(db, userId);
    const got = await find('trip form', 'Bill Smith');
    expect(got.map(([s]) => s)).toContain('Kids outing paperwork');
    expect(got.map(([s]) => s)).not.toContain('Field trip form due Friday');
  });

  it('is plain keyword search when meaning search is off', async () => {
    expect(await find('kids excursion paperwork')).not.toContainEqual(['Field trip form due Friday', 'meaning']);
  });
});
