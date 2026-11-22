import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { disconnectGmail, hasGmailScope } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const CAL = 'https://www.googleapis.com/auth/calendar';
const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';

describe('disconnectGmail', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    // The mock provider answers hasGmailScope with a constant true, which is
    // exactly what hid this: the real gate reads the stored scope list.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    db = await openTestDb();
    userId = await createUser(db, 'gmail-disconnect');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const scopes = async () =>
    (
      await db
        .selectFrom('users')
        .select('refresh_token_scopes')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
    ).refresh_token_scopes;

  it('stops reading the mailbox, and keeps Calendar', async () => {
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: `openid email profile ${CAL} ${GMAIL}` })
      .where('id', '=', userId)
      .execute();
    expect(await hasGmailScope(db, userId)).toBe(true);

    await disconnectGmail(db, userId);

    expect(await hasGmailScope(db, userId)).toBe(false);
    expect(await scopes()).toBe(`openid email profile ${CAL}`);
  });

  it('leaves a user with no stored token alone', async () => {
    await disconnectGmail(db, userId);
    expect(await scopes()).toBeNull();
  });
});
