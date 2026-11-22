/**
 * The contract step (ADR 0201, phase 3): dropping the plaintext search columns.
 * It changes the schema, and the worker's database is recycled between test
 * files, so this runs on its own clone and never on the shared one.
 */
import { Kysely, sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { contentCrypto, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { sealExistingMail } from '@/services/encryption/backfill-email.js';
import { FinalizeRefused, finalizeEmailEncryption } from '@/services/encryption/finalize-email.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { searchHits } from '@/services/search.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail, seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let holder: Kysely<DB>; // occupies the shared database so the next open is a real clone
let db: Kysely<DB>;
let userId: string;

beforeAll(async () => {
  holder = await openTestDb();
  db = await openTestDb();
  setContentEncryption(true);
  userId = await createUser(db, 'alice');
}, 120_000);
afterAll(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  await closeTestDb(db);
  await closeTestDb(holder);
});
afterEach(() => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
});

const hasColumn = async (table: string, column: string): Promise<boolean> => {
  const r = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}`.execute(contentCrypto().raw);
  return r.rows[0]!.n === '1';
};

describe('finalizeEmailEncryption', () => {
  it('refuses while the code still reads the legacy columns', async () => {
    legacy.CONTENT_LEGACY_TSV = true;
    await expect(finalizeEmailEncryption(db)).rejects.toThrow(FinalizeRefused);
    await expect(finalizeEmailEncryption(db)).rejects.toThrow(/CONTENT_LEGACY_TSV/);
    expect(await hasColumn('email_threads', 'search_tsv')).toBe(true);
  });

  it('refuses while any row still holds readable content, and says how much', async () => {
    legacy.CONTENT_LEGACY_TSV = false;
    await seedPlainMail(db, userId, { subject: 'Still readable', snippet: 'x', body: 'and this' });

    await expect(finalizeEmailEncryption(db)).rejects.toThrow(/still readable/);
    expect(await hasColumn('email_messages', 'search_tsv')).toBe(true);
  });

  it('drops the plaintext search columns once everything is sealed, and search keeps working', async () => {
    legacy.CONTENT_LEGACY_TSV = false;
    await sealExistingMail(db);
    const id = await seedSyncedMail(db, userId, { subject: 'Written after the backfill', snippet: 'quokka', body: 'wombat' });

    const r = await finalizeEmailEncryption(db, { vacuum: true });

    expect(r.dropped).toEqual(['email_threads.search_tsv', 'email_messages.search_tsv']);
    expect(r.vacuumed).toBe(true);
    expect(await hasColumn('email_threads', 'search_tsv')).toBe(false);
    expect(await hasColumn('email_messages', 'search_tsv')).toBe(false);

    const personal = (await ensurePersonalGroup(db, userId)).id;
    for (const q of ['quokka', 'wombat', 'written']) {
      const res = await searchHits(db, { userId, groupId: personal, crossGroup: true, query: q, limit: 20 });
      expect(res.hits.filter((h) => h.entityType === 'email').map((h) => h.entityId), q).toContain(id);
    }
  });

  it('is safe to run again once the columns are gone', async () => {
    legacy.CONTENT_LEGACY_TSV = false;
    await expect(finalizeEmailEncryption(db)).resolves.toMatchObject({ dropped: expect.any(Array) });
  });
});
