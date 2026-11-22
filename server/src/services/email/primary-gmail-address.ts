/**
 * The primary Gmail's own address (ADR 0080: the mailbox on the user row).
 *
 * It is NOT `users.email`. That is the sign-in email: for an account made with
 * Google it is the Gmail address, but an account made with Microsoft or Apple
 * keeps its own sign-in email when Google is connected later, so labelling the
 * Gmail mailbox with it shows the Outlook or Apple address instead.
 *
 * Kept in `users.defaults.gmail_address`, written when Google tokens arrive
 * and filled once from Gmail's own profile for mailboxes connected before.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { defineUserDefault } from '@/services/user-defaults.service.js';

export const gmailAddressDefault = defineUserDefault('gmail_address', z.string().email());

/** What a row says, before anything is looked up. */
export function primaryGmailAddressFromRow(row: {
  email: string | null;
  apple_sub?: string | null;
  microsoft_sub?: string | null;
  defaults?: Record<string, unknown> | null;
} | null | undefined): string | null {
  if (!row) return null;
  const stored = row.defaults?.gmail_address;
  if (typeof stored === 'string' && stored.includes('@')) return stored.toLowerCase();
  // Made with Google: the sign-in email IS the Gmail address. Made with Apple
  // or Microsoft: it is not, and nothing else is known yet.
  if (row.apple_sub || row.microsoft_sub) return null;
  return row.email?.trim().toLowerCase() || null;
}

export async function primaryGmailAddress(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select(['email', 'apple_sub', 'microsoft_sub', 'defaults'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return primaryGmailAddressFromRow(row);
}

/** Record the address Google named when its tokens were stored. */
export async function recordPrimaryGmailAddress(
  db: Kysely<DB>,
  userId: string,
  address: string | null | undefined,
): Promise<void> {
  const clean = address?.trim().toLowerCase();
  if (!clean || !clean.includes('@')) return;
  await gmailAddressDefault.set(db, userId, clean);
}

export async function forgetPrimaryGmailAddress(db: Kysely<DB>, userId: string): Promise<void> {
  await gmailAddressDefault.set(db, userId, null);
}

const lookupFailedAt = new Map<string, number>();
const RETRY_AFTER_MS = 10 * 60_000;

/**
 * For a mailbox connected before the address was recorded: ask Gmail once.
 * Best-effort - a failure answers null and is not retried for ten minutes,
 * so a status read never waits on Google twice in a row.
 */
export async function fillPrimaryGmailAddress(
  db: Kysely<DB>,
  userId: string,
  readProfile: () => Promise<{ emailAddress?: string }>,
): Promise<string | null> {
  const stored = await gmailAddressDefault.get(db, userId);
  if (stored) return stored.toLowerCase();
  const failed = lookupFailedAt.get(userId);
  if (failed && Date.now() - failed < RETRY_AFTER_MS) return null;
  try {
    const { emailAddress } = await readProfile();
    if (!emailAddress) return null;
    await recordPrimaryGmailAddress(db, userId, emailAddress);
    lookupFailedAt.delete(userId);
    return emailAddress.toLowerCase();
  } catch (err) {
    lookupFailedAt.set(userId, Date.now());
    logger.warn('could not read the primary Gmail address', { userId, err: (err as Error).message });
    return null;
  }
}

/** Test seam. */
export function __resetGmailAddressLookupsForTests(): void {
  lookupFailedAt.clear();
}
