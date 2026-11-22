/**
 * What "number 3" refers to (ADR 0093).
 *
 * Tool results do not survive a bot turn — `buildConvo` replays history as
 * prose only — so when the user answers a numbered list with "mark 3-4-5-6
 * done", the model holds its own sentences and nothing else. This is the
 * server's record of the list it last showed, so the mapping is looked up
 * rather than re-derived from remembered titles.
 *
 * Lives in Postgres (ADR 0280): the "3-4-5-6" can reach a different web copy
 * than the list did. Losing it costs a re-list, never a wrong write. The
 * per-turn allowances below stay in memory, since one turn runs in one process.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { getPendingState, putPendingState } from './pending-state.js';

/** Long enough to answer a list you are looking at; short enough to go stale. */
const TTL_MS = 30 * 60_000;
/** Turn bookkeeping outlives a turn only long enough to be safe to forget. */
const TURN_TTL_MS = 5 * 60_000;
const MAX_TURNS = 500;

const looseTaskMutations = new Map<string, { count: number; at: number }>();
const turnActions = new Map<string, { at: number }>();

function keyFor(groupId: string, userId: string | null): string {
  return `${groupId}:${userId ?? '-'}`;
}

function sweep(map: Map<string, { at: number }>, ttl: number, max: number): void {
  const cutoff = Date.now() - ttl;
  for (const [k, v] of map) {
    if (v.at < cutoff) map.delete(k);
  }
  // Map preserves insertion order and every write re-inserts, so the head is
  // the least recently written.
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Remember the ordered task ids a `list_tasks` call just showed this user. */
export async function recordTaskEnumeration(
  db: Kysely<DB>,
  groupId: string,
  userId: string | null,
  ids: string[],
): Promise<void> {
  await putPendingState(db, 'enumeration', keyFor(groupId, userId), { ids }, TTL_MS);
}

/**
 * The task at each 1-based position of the list last shown, null where there is
 * no live enumeration or the position is off the end. Callers treat any null as
 * a refusal for the whole selection — a partially-resolved set is never written.
 */
export async function resolveTaskOrdinals(
  db: Kysely<DB>,
  groupId: string,
  userId: string | null,
  ns: number[],
): Promise<(string | null)[]> {
  const entry = await getPendingState<{ ids: string[] }>(db, 'enumeration', keyFor(groupId, userId));
  return ns.map((n) =>
    entry && Number.isInteger(n) && n >= 1 && n <= entry.ids.length ? entry.ids[n - 1]! : null,
  );
}

/**
 * Claim this turn's single allowance for a task mutation resolved by id or
 * title. Returns false once it is spent, which is what forces a set of tasks
 * through `ordinals` (and therefore through a real enumeration) rather than
 * through N independent guesses.
 *
 * A null turnId means the caller is not a bot turn (ingest, proposal confirm) —
 * those resolve from data they were handed, not from a conversation, so the
 * allowance does not apply.
 */
export function claimLooseTaskMutation(turnId: string | null | undefined): boolean {
  if (!turnId) return true;
  const now = Date.now();
  const entry = looseTaskMutations.get(turnId);
  if (entry && entry.at >= now - TURN_TTL_MS) {
    if (entry.count >= 1) return false;
    entry.count += 1;
    return true;
  }
  looseTaskMutations.delete(turnId);
  looseTaskMutations.set(turnId, { count: 1, at: now });
  sweep(looseTaskMutations, TURN_TTL_MS, MAX_TURNS);
  return true;
}

/**
 * Claim a one-per-turn allowance for `action` (ADR 0099). The ADR 0005 loop
 * re-streams up to 20 times, so a tool with real cost behind it — a briefing
 * runs an LLM scan and a mailbox sync — needs the turn, not the call, as its
 * unit. Same null-turnId carve-out as `claimLooseTaskMutation`.
 */
export function claimOncePerTurn(
  turnId: string | null | undefined,
  action: string,
): boolean {
  if (!turnId) return true;
  const k = `${turnId}:${action}`;
  const now = Date.now();
  const entry = turnActions.get(k);
  if (entry && entry.at >= now - TURN_TTL_MS) return false;
  turnActions.delete(k);
  turnActions.set(k, { at: now });
  sweep(turnActions, TURN_TTL_MS, MAX_TURNS);
  return true;
}

export const __testing = {
  reset(): void {
    looseTaskMutations.clear();
    turnActions.clear();
  },
};
