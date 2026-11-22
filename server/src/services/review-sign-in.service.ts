/**
 * ADR 0345 - the app-review account's own sign-in. Store reviewers sign in
 * from devices Google and Microsoft have never seen, and both ask them to
 * prove it on a phone the reviewer does not have. This opens ONE account,
 * named by REVIEW_SIGN_IN_EMAIL, with a password from the deploy's secrets.
 */
import { nanoid } from 'nanoid';
import type { Kysely, Selectable } from 'kysely';

import { env } from '../config/env.js';
import type { DB, UsersTable } from '../db/schema.js';
import { secretsEqual } from '../utils/secret-compare.js';

export const REVIEW_PASSWORD_MIN = 20;

export function reviewSignInConfigured(): boolean {
  return (
    env.REVIEW_SIGN_IN_EMAIL.trim().includes('@') &&
    env.REVIEW_SIGN_IN_PASSWORD.length >= REVIEW_PASSWORD_MIN
  );
}

/** Both halves are checked, always, so a wrong email takes as long as a wrong password. */
export function reviewCredentialsMatch(email: string, password: string): boolean {
  if (!reviewSignInConfigured()) return false;
  const emailOk = secretsEqual(email.trim().toLowerCase(), env.REVIEW_SIGN_IN_EMAIL.trim().toLowerCase());
  const passwordOk = secretsEqual(password, env.REVIEW_SIGN_IN_PASSWORD);
  return emailOk && passwordOk;
}

/**
 * The account a review sign-in opens: the existing (non-shadow) account with
 * that email - the owner signs in once with the demo Google account and
 * connects its mail - else a new, empty one.
 */
export async function reviewAccount(db: Kysely<DB>): Promise<Selectable<UsersTable>> {
  const email = env.REVIEW_SIGN_IN_EMAIL.trim().toLowerCase();
  const existing = await db
    .selectFrom('users')
    .selectAll()
    .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
    .where('shadow', '=', 0)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();
  if (existing) return existing;

  const base = email.split('@')[0].replace(/[^a-z0-9_.-]+/g, '') || 'review';
  let username = base;
  const taken = await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst();
  if (taken) username = `${base}-${nanoid(4).toLowerCase()}`;
  return db
    .insertInto('users')
    .values({
      id: `u_${nanoid(12)}`,
      username,
      display_name: 'App Review',
      first_name: 'App',
      last_name: 'Review',
      created_at: new Date().toISOString(),
      shadow: 0,
      email,
      email_verified: 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
