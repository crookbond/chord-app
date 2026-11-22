/**
 * SEED_TG_EMAIL_PAIRS: boot-time pre-linking of (telegram_id, email)
 * pairs. Tests pin the idempotent + claim-in-place semantics:
 *   - Empty env → no-op.
 *   - Malformed JSON → logged + ignored, no rows.
 *   - Fresh pair → user + personal group + external_identities created.
 *   - Existing user (same email) → reused; identity added.
 *   - Existing identity on a *shadow* user → re-pointed at seeded user.
 *   - Existing identity on a real user → left alone (no overwrite).
 *   - Re-running the seed → idempotent.
 *   - AUTH_MODE=demo → no-op.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { seedTgEmailPairs } from '@/services/connectors/seed-tg-email-pairs.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('seedTgEmailPairs', () => {
  let db: Kysely<DB>;
  let savedSeed: string;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    savedSeed = env.SEED_TG_EMAIL_PAIRS;
    savedAuthMode = env.AUTH_MODE;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
  });

  afterEach(async () => {
    (env as { SEED_TG_EMAIL_PAIRS: string }).SEED_TG_EMAIL_PAIRS = savedSeed;
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    await closeTestDb(db);
  });

  function setPairs(pairs: unknown): void {
    (env as { SEED_TG_EMAIL_PAIRS: string }).SEED_TG_EMAIL_PAIRS =
      typeof pairs === 'string' ? pairs : JSON.stringify(pairs);
  }

  it('empty env → no-op', async () => {
    setPairs('');
    await seedTgEmailPairs(db);
    const users = await db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(0);
  });

  it('malformed JSON → logged + ignored', async () => {
    setPairs('not json {');
    await seedTgEmailPairs(db);
    const users = await db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(0);
  });

  it('fresh pair → creates user, personal group, identity', async () => {
    setPairs([
      { tg_id: '111', email: 'alice@example.test', display_name: 'Alice' },
    ]);
    await seedTgEmailPairs(db);

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', 'alice@example.test')
      .executeTakeFirstOrThrow();
    expect(user.shadow).toBe(0);
    expect(user.google_sub).toBeNull();
    expect(user.email_verified).toBe(0);
    expect(user.display_name).toBe('Alice');

    const personal = await db
      .selectFrom('groups')
      .selectAll()
      .where('kind', '=', 'personal')
      .where('created_by', '=', user.id)
      .executeTakeFirst();
    expect(personal).toBeDefined();

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_id', '=', '111')
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe(user.id);
  });

  it('existing user (same email) is reused; identity added', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u_pre',
        username: 'alice',
        display_name: 'Alice',
        created_at: now,
        shadow: 0,
        email: 'alice@example.test',
        email_verified: 0,
      })
      .execute();
    setPairs([{ tg_id: '111', email: 'alice@example.test' }]);
    await seedTgEmailPairs(db);

    const userCount = await db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(userCount.n).toBe(1);

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('external_id', '=', '111')
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe('u_pre');
  });

  it('identity on a shadow user → re-pointed to seeded user', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u_shadow',
        username: 'tg_222',
        display_name: 'Shadow',
        created_at: now,
        shadow: 1,
      })
      .execute();
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: '222',
        external_display: 'Shadow',
        user_id: 'u_shadow',
        created_at: now,
      })
      .execute();

    setPairs([
      { tg_id: '222', email: 'bob@example.test', display_name: 'Bob' },
    ]);
    await seedTgEmailPairs(db);

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('external_id', '=', '222')
      .executeTakeFirstOrThrow();
    const seeded = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', 'bob@example.test')
      .executeTakeFirstOrThrow();
    expect(ident.user_id).toBe(seeded.id);
  });

  it('identity on a real user → left alone (no overwrite)', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'u_other',
        username: 'other',
        display_name: 'Other',
        created_at: now,
        shadow: 0,
        google_sub: 'sub_other',
        email: 'other@example.test',
        email_verified: 1,
      })
      .execute();
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: '333',
        external_display: 'Other',
        user_id: 'u_other',
        created_at: now,
      })
      .execute();

    setPairs([{ tg_id: '333', email: 'carol@example.test' }]);
    await seedTgEmailPairs(db);

    const ident = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('external_id', '=', '333')
      .executeTakeFirstOrThrow();
    // Identity NOT re-pointed.
    expect(ident.user_id).toBe('u_other');
  });

  it('idempotent on re-run', async () => {
    setPairs([
      { tg_id: '111', email: 'alice@example.test' },
      { tg_id: '222', email: 'bob@example.test' },
    ]);
    await seedTgEmailPairs(db);
    await seedTgEmailPairs(db);
    const users = await db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(2);
    const idents = await db.selectFrom('external_identities').selectAll().execute();
    expect(idents).toHaveLength(2);
  });

  it('AUTH_MODE=demo → no-op', async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'demo';
    setPairs([{ tg_id: '111', email: 'alice@example.test' }]);
    await seedTgEmailPairs(db);
    const users = await db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(0);
  });
});
