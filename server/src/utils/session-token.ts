import { createHash } from 'node:crypto';

import { nanoid } from 'nanoid';

/**
 * Session tokens are stored hashed (ADR 0269): `sessions.token` holds
 * `h_<sha256 hex>` of the token the client holds, never the token itself, so a
 * read of the table (a backup, a leaked dump) yields nothing that signs anyone
 * in. The token has 144 bits of entropy, so a plain SHA-256 is enough — there
 * is no low-entropy secret here for a slow hash to protect.
 *
 * The `h_` prefix is what makes migration 112 idempotent: a raw token is `t_…`,
 * so a row that already starts `h_` is never hashed twice.
 */
export const SESSION_HASH_PREFIX = 'h_';

export function newSessionToken(): string {
  return `t_${nanoid(24)}`;
}

export function hashSessionToken(token: string): string {
  return SESSION_HASH_PREFIX + createHash('sha256').update(token, 'utf8').digest('hex');
}
