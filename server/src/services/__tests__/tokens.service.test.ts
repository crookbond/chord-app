/**
 * ADR 0193 — the token-usage counter. "Used this month" must sum only this
 * user's rows from the current UTC calendar month, and be 0 (not null/error)
 * for a user with none yet.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { getTokenUsageThisMonth, recordTokenUsage } from '@/services/tokens.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('tokens.service', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'tokens');
    return async () => closeTestDb(db);
  });

  it('is zero for a user with no recorded usage', async () => {
    expect(await getTokenUsageThisMonth(db, userId)).toBe(0);
  });

  it('sums prompt+completion tokens across every row this month', async () => {
    await recordTokenUsage(db, {
      userId,
      source: 'bot_turn',
      ref: 'm1',
      model: 'gpt-x',
      promptTokens: 100,
      completionTokens: 20,
    });
    await recordTokenUsage(db, {
      userId,
      source: 'email_magics',
      ref: 'et1',
      model: 'gpt-x',
      promptTokens: 50,
      completionTokens: 5,
    });
    expect(await getTokenUsageThisMonth(db, userId)).toBe(175);
  });

  it('never mixes one user’s usage into another’s total', async () => {
    const other = await createUser(db, 'tokens-other');
    await recordTokenUsage(db, {
      userId: other,
      source: 'bot_turn',
      ref: 'm2',
      model: 'gpt-x',
      promptTokens: 900,
      completionTokens: 100,
    });
    expect(await getTokenUsageThisMonth(db, userId)).toBe(0);
    expect(await getTokenUsageThisMonth(db, other)).toBe(1000);
  });

  it('excludes usage from before the current UTC calendar month', async () => {
    await recordTokenUsage(db, {
      userId,
      source: 'bot_turn',
      ref: 'old',
      model: 'gpt-x',
      promptTokens: 500,
      completionTokens: 50,
    });
    await db
      .updateTable('token_usage')
      .set({ created_at: '2020-01-15T00:00:00.000Z' })
      .where('ref', '=', 'old')
      .execute();
    expect(await getTokenUsageThisMonth(db, userId)).toBe(0);
  });
});
