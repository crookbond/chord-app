/**
 * Post-invocation follow-up window (ADR 0051).
 *
 * After the bot is explicitly @-mentioned in a group, it should keep answering
 * the *group's* next few messages without forcing a re-mention on every turn —
 * so a back-and-forth ("import the school calendar" → "from online" → "Fairfax
 * County"), possibly spanning multiple members, flows naturally. This module
 * holds that window.
 *
 * State is **per group** (not per user — group-scoped, so any member's reply
 * continues the thread) and lives in Postgres (ADR 0280): the next message can
 * reach a different web copy than the mention did.
 *
 * The window is bounded twice: by a turn count (`BOT_FOLLOWUP_TURNS`, the
 * server-configurable "next N prompts", hard-capped at MAX_FOLLOWUP_TURNS) and
 * by a wall-clock TTL (`BOT_FOLLOWUP_TTL_MINUTES`) so a long-idle window can't
 * surprise the group.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { deletePendingState, getPendingState, putPendingState } from './pending-state.js';

/** Hard ceiling on the configurable turn count — a runaway-cost backstop. */
export const MAX_FOLLOWUP_TURNS = 20;

interface WindowState {
  /** Remaining un-mentioned turns the bot will still answer. */
  remaining: number;
}

/** Configured turns, clamped to [0, MAX_FOLLOWUP_TURNS]. */
function configuredTurns(): number {
  return Math.min(MAX_FOLLOWUP_TURNS, Math.max(0, env.BOT_FOLLOWUP_TURNS));
}

/**
 * Open (or refresh) the window for a group — called when the bot reacts to an
 * explicit @-mention. Resets the count to the configured N and the TTL clock.
 * No-op when the feature is disabled (`BOT_FOLLOWUP_TURNS<=0`).
 */
export async function openFollowupWindow(db: Kysely<DB>, groupId: string): Promise<void> {
  const turns = configuredTurns();
  if (turns <= 0) return;
  await putPendingState(db, 'followup', groupId, { remaining: turns } satisfies WindowState,
    env.BOT_FOLLOWUP_TTL_MINUTES * 60_000);
}

/**
 * True when the group currently has an open, unexpired follow-up window — i.e.
 * the bot should answer the next message even without a mention.
 */
export async function isWithinFollowupWindow(db: Kysely<DB>, groupId: string): Promise<boolean> {
  if (configuredTurns() <= 0) return false;
  const w = await getPendingState<WindowState>(db, 'followup', groupId);
  return !!w && w.remaining > 0;
}

/**
 * Spend one follow-up turn — called when the bot reacts *because* of the
 * window (not a fresh mention). Closes the window once exhausted. One
 * statement, so two copies spending at once each take their own turn.
 */
export async function consumeFollowupTurn(db: Kysely<DB>, groupId: string): Promise<void> {
  const r = await sql<{ remaining: number }>`
    UPDATE bot_pending_state
    SET value = jsonb_build_object('remaining', (value->>'remaining')::int - 1)
    WHERE kind = 'followup' AND scope_key = ${groupId} AND expires_at > now()
    RETURNING (value->>'remaining')::int AS remaining
  `.execute(db);
  const left = r.rows[0]?.remaining;
  if (left !== undefined && left <= 0) await deletePendingState(db, 'followup', groupId);
}
