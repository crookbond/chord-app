/**
 * Past dates Chord has actually asked about (ADR 0319 addendum; ADR 0100's
 * `confirmPast` made real).
 *
 * ADR 0100 refuses a `create_event` / `update_event` whose start already went
 * by and has the bot read the date back and ask; only once the user says they
 * really meant it is the tool called again with `confirmPast: true`. Nothing
 * enforced the middle step. `confirmPast` is an optional boolean on the tool
 * schema, and ADR 0229's addendum records that models through OpenRouter fill
 * every optional field — so the one flag that switches the guard off could be
 * set by a model that had asked nobody, filing a stale-year event silently
 * instead of querying it. The same unguarded-optional-field class as `repeat`
 * (0229), the mail search filters (0279) and `videoCall` (0319).
 *
 * So the licence is recorded where the question is asked: every refusal writes
 * the local day it refused, and `confirmPast` is believed only against one of
 * those. Two properties make it the user's confirmation rather than the
 * model's assertion:
 *
 * - **A different turn.** The ADR 0005 loop can re-stream up to 20 times
 *   inside one turn, so a refusal followed by an immediate retry is the model
 *   answering its own question. Honouring only a refusal from an EARLIER turn
 *   (`turnId`, ADR 0093's key) is what makes the user's reply the thing that
 *   licensed it.
 * - **The same day.** The user confirms a date, not a flag. A `confirmPast`
 *   carrying some other past date was never put to them.
 *
 * An ADR 0155 file-triggered refusal records nothing on purpose: that path
 * tells the model NOT to ask, so no answer can exist to license a later
 * confirm.
 *
 * In Postgres (ADR 0280) because the answer can land on a different web copy
 * than the turn that asked.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { getPendingState, putPendingState } from './pending-state.js';

/**
 * Long enough for someone to answer a question in a chat — an hour covers
 * "yes, last March" typed after a school run. Short on purpose: a licence
 * nobody used should not sit around waiting to excuse an unrelated call days
 * later.
 */
const TTL_MS = 60 * 60_000;

/** One day refused, and the turn that refused it. */
interface PastDateAsk {
  day: string;
  turnId: string;
  at: number;
}

/** Several dates can be in flight at once (a term schedule read aloud). */
const MAX_REMEMBERED = 12;

function keyFor(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

function fresh(list: PastDateAsk[]): PastDateAsk[] {
  const cutoff = Date.now() - TTL_MS;
  return list.filter((a) => a.at >= cutoff);
}

/**
 * Record that this turn refused `day` and asked the user about it. Re-asking
 * the same day replaces the entry, so the newest turn to ask is the one a
 * confirm has to be answering.
 */
export async function recordPastDateAsk(
  db: Kysely<DB>,
  groupId: string,
  userId: string | null,
  turnId: string,
  day: string,
): Promise<void> {
  if (!userId) return;
  const k = keyFor(groupId, userId);
  const current = (await getPendingState<PastDateAsk[]>(db, 'past_date', k)) ?? [];
  const rest = fresh(current).filter((a) => a.day !== day);
  const next = [...rest, { day, turnId, at: Date.now() }].slice(-MAX_REMEMBERED);
  await putPendingState(db, 'past_date', k, next, TTL_MS);
}

/**
 * Did the user confirm this day? True only for a refusal recorded against a
 * DIFFERENT turn — the user has had a chance to answer in between. Deliberately
 * left on record afterwards: a confirmed past date that then fails to write
 * (an ambiguous title, a repeat the server cannot express) is re-sent by the
 * model in the same breath, and asking twice for one answer is the nag ADR
 * 0100 was written against.
 */
export async function pastDateWasConfirmed(
  db: Kysely<DB>,
  groupId: string,
  userId: string | null,
  turnId: string,
  day: string,
): Promise<boolean> {
  if (!userId) return false;
  const list = fresh((await getPendingState<PastDateAsk[]>(db, 'past_date', keyFor(groupId, userId))) ?? []);
  return list.some((a) => a.day === day && a.turnId !== turnId);
}
