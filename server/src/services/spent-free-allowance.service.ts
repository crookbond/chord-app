/**
 * ADR 0342 — a deleted account's free tokens stay spent. Deletion records
 * one-way fingerprints of the account's sign-in identities; the free allowance
 * is 0 for any account that holds one of them.
 */
import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';

/** The identity columns read off a user row. */
export interface IdentityRow {
  email?: string | null;
  google_sub?: string | null;
  apple_sub?: string | null;
  microsoft_sub?: string | null;
  phone_hash?: string | null;
  phone_verified?: number | null;
}

const IDENTITY_COLUMNS = [
  'email',
  'google_sub',
  'apple_sub',
  'microsoft_sub',
  'phone_hash',
  'phone_verified',
] as const;

function fingerprint(kind: string, value: string): string {
  return createHash('sha256').update(`v1:${kind}:${value}`).digest('hex');
}

/** Every identity on the row, fingerprinted. An unverified phone is not an
 *  identity (anyone can type a number), so it is left out. */
export function identityFingerprints(row: IdentityRow): string[] {
  const out: string[] = [];
  const email = row.email?.trim().toLowerCase();
  if (email) out.push(fingerprint('email', email));
  if (row.google_sub) out.push(fingerprint('google', row.google_sub));
  if (row.apple_sub) out.push(fingerprint('apple', row.apple_sub));
  if (row.microsoft_sub) out.push(fingerprint('microsoft', row.microsoft_sub));
  if (row.phone_hash && row.phone_verified === 1) out.push(fingerprint('phone', row.phone_hash));
  return out;
}

/** Called inside the deletion transaction, before the user row goes. */
export async function recordSpentFreeAllowance(db: Kysely<DB>, userId: string): Promise<number> {
  const row = await db.selectFrom('users').select(IDENTITY_COLUMNS).where('id', '=', userId).executeTakeFirst();
  if (!row) return 0;
  const prints = identityFingerprints(row);
  if (prints.length === 0) return 0;
  const now = new Date().toISOString();
  await db
    .insertInto('spent_free_allowances')
    .values(prints.map((p) => ({ fingerprint: p, created_at: now })))
    .onConflict((oc) => oc.column('fingerprint').doNothing())
    .execute();
  return prints.length;
}

/** True when any identity of this account belonged to a deleted account. */
export async function freeAllowanceSpentBefore(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db.selectFrom('users').select(IDENTITY_COLUMNS).where('id', '=', userId).executeTakeFirst();
  if (!row) return false;
  const prints = identityFingerprints(row);
  if (prints.length === 0) return false;
  const hit = await db
    .selectFrom('spent_free_allowances')
    .select('fingerprint')
    .where('fingerprint', 'in', prints)
    .limit(1)
    .executeTakeFirst();
  return !!hit;
}
