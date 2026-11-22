/**
 * Hash existing session tokens in place (migration 112, ADR 0269).
 *
 * `sessions.token` used to hold the token the client presents. Sign-in now
 * stores `h_<sha256 hex>` of it (`hashSessionToken`), and `loadSession` hashes
 * what it is shown before looking it up, so every row written before this
 * migration would stop matching — signing every user out. This rewrites those
 * rows to the hashed form, which keeps them valid.
 *
 * Postgres's `sha256()` over the UTF-8 bytes gives the same digest as Node's
 * `createHash('sha256').update(token, 'utf8')`, which the test pins.
 *
 * Idempotent: a row already starting `h_` is skipped, so a re-run cannot hash
 * a hash. Raw tokens are `t_…` (and fixtures' `t_…` ids), never `h_…`.
 *
 * Extracted from the migration list so it can be tested against a real
 * database, the same way `mergeDuplicateLists` and `scopeEmailCategoryIds` are.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from './schema.js';

export async function hashSessionTokens(db: Kysely<DB>): Promise<void> {
  await sql`UPDATE sessions
    SET token = 'h_' || encode(sha256(convert_to(token, 'UTF8')), 'hex')
    WHERE left(token, 2) <> 'h_'`.execute(db);
}
