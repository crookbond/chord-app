/**
 * ADR 0231 — grandfathering: people who were here before billing went live
 * keep the individual allowance free, permanently.
 *
 * It is a flag on the user, not a subscription object. There is no Stripe or
 * App Store record behind it to expire, drift out of sync, or be cancelled by
 * accident, and "who is grandfathered" is one column to query. The set is
 * decided by an explicit cutoff the owner picks on the day billing goes live
 * (`--before`), not by a migration — a migration can't know that day, and one
 * that ran on deploy would sweep in everyone who signed up in between.
 * Shadow accounts (people who only ever messaged the bot) are never included.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';

export interface GrandfatherPreview {
  /** Real accounts created before the cutoff that are not yet flagged. */
  eligible: number;
  /** Already flagged, for the report. */
  already: number;
}

export async function previewGrandfather(db: Kysely<DB>, beforeIso: string): Promise<GrandfatherPreview> {
  const rows = await db
    .selectFrom('users')
    .select(['grandfathered_at'])
    .where('shadow', '=', 0)
    .where('created_at', '<', beforeIso)
    .execute();
  const already = rows.filter((r) => r.grandfathered_at).length;
  return { eligible: rows.length - already, already };
}

/** Flag every real account created before `beforeIso`. Idempotent: it never
 *  moves an existing `grandfathered_at`. Returns how many were newly flagged. */
export async function grandfatherUsersCreatedBefore(db: Kysely<DB>, beforeIso: string): Promise<number> {
  const res = await db
    .updateTable('users')
    .set({ grandfathered_at: new Date().toISOString() })
    .where('shadow', '=', 0)
    .where('created_at', '<', beforeIso)
    .where('grandfathered_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** Grant (or take back) one person's free allowance — a comp for a friend, or
 *  undoing a mistake. Returns false if the user doesn't exist. */
export async function setGrandfathered(db: Kysely<DB>, userId: string, on: boolean): Promise<boolean> {
  const res = await db
    .updateTable('users')
    .set({ grandfathered_at: on ? new Date().toISOString() : null })
    .where('id', '=', userId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}
