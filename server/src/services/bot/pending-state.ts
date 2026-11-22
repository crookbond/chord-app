/**
 * ADR 0280 — what the bot is still waiting on an answer to, shared by every
 * process. The next message in a conversation can land on a different web copy
 * than the turn that asked, so the follow-up window (ADR 0051), the numbered
 * list (0093), the event waiting on a guest's email (0166) and the pending
 * share offer (0232/0233) live here rather than in one process's memory.
 *
 * A row is dead at `expires_at`: reads ignore it, and `pruneExpiredPendingState`
 * (the daily retention pass) removes what nobody read again.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

/**
 * 'phone' — ADR 0299: the number a verification code was just texted to.
 * 'past_date' — ADR 0319 addendum: a past date Chord refused and asked about,
 * which is what a later `confirmPast` has to be answering.
 * 'trip_travelers' — ADR 0289 addendum: trips Chord asked "who is going?" about.
 */
export type PendingKind =
  | 'followup'
  | 'enumeration'
  | 'invitees'
  | 'fanout'
  | 'phone'
  | 'past_date'
  | 'trip_travelers'
  | 'last_event';

export async function putPendingState(
  db: Kysely<DB>,
  kind: PendingKind,
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  await sql`
    INSERT INTO bot_pending_state (kind, scope_key, value, expires_at)
    VALUES (${kind}, ${key}, ${JSON.stringify(value)}::jsonb,
            now() + make_interval(secs => ${ttlMs / 1000}))
    ON CONFLICT (kind, scope_key)
    DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
  `.execute(db);
}

export async function getPendingState<T>(
  db: Kysely<DB>,
  kind: PendingKind,
  key: string,
): Promise<T | null> {
  const r = await sql<{ value: T }>`
    SELECT value FROM bot_pending_state
    WHERE kind = ${kind} AND scope_key = ${key} AND expires_at > now()
  `.execute(db);
  return r.rows[0]?.value ?? null;
}

export async function deletePendingState(
  db: Kysely<DB>,
  kind: PendingKind,
  key: string,
): Promise<void> {
  await sql`DELETE FROM bot_pending_state WHERE kind = ${kind} AND scope_key = ${key}`.execute(db);
}

/** Remove every expired row. Returns how many went. */
export async function pruneExpiredPendingState(db: Kysely<DB>): Promise<number> {
  const r = await sql`DELETE FROM bot_pending_state WHERE expires_at <= now()`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}
