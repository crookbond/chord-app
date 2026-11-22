import { Kysely, PostgresDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

import { env as readonlyEnv } from '../../../config/env.js';
import type { DB } from '../../schema.js';
import { attachContentCrypto, contentEncryptionEnabled, detachContentCrypto, setContentEncryption } from '../index.js';

const env = readonlyEnv as { NODE_ENV: string; CONTENT_KEK: string };

function bareDb(): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ max: 1 }) }) });
}

describe('opening the database in production without a KEK', () => {
  const saved = { nodeEnv: env.NODE_ENV, kek: env.CONTENT_KEK, on: contentEncryptionEnabled() };
  const opened: Kysely<DB>[] = [];

  beforeEach(() => {
    env.NODE_ENV = 'production';
    env.CONTENT_KEK = '';
  });

  afterEach(() => {
    env.NODE_ENV = saved.nodeEnv;
    env.CONTENT_KEK = saved.kek;
    setContentEncryption(saved.on);
    for (const db of opened.splice(0)) detachContentCrypto(db);
  });

  function attach(): Kysely<DB> {
    const handle = attachContentCrypto(bareDb(), { keyDb: bareDb() });
    opened.push(handle);
    return handle;
  }

  // The prod deploy runs `npm run migrate` with NODE_ENV=production and no
  // CONTENT_KEK before the flag is ever switched on; the provider used to be
  // built while opening the database and the migration died with
  // "CONTENT_KEK is required for the local key provider in production".
  it('does not need a KEK while encryption is off', () => {
    setContentEncryption(false);
    expect(() => attach()).not.toThrow();
  });

  it('still refuses to start when encryption is on and the KEK is missing', () => {
    setContentEncryption(true);
    expect(() => attach()).toThrow(/CONTENT_KEK is required/);
  });
});
