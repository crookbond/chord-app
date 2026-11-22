/**
 * The event a chat just made, so the next message can correct it.
 *
 * Prod 2026-11-17: "send a calendar invite for 2p EST to arthur@...", then
 * "On Rudderstack Calendar - add to calendar invite ...", then "For tomorrow"
 * made THREE meetings and sent three invitations. Tool results do not survive
 * a turn (ADR 0093/0166), so on the second and third message the model had
 * no event to point at and called create_event each time.
 *
 * Two halves, the same as ADR 0166's pending invites: the event is named in
 * the next turn's prompt, and `create_event` refuses once when it looks like
 * that same meeting again (a guest in common, or the same title) and hands
 * back its id for `update_event`. Asked once per event: if the user really
 * wants a second meeting, the next call goes through.
 *
 * In Postgres (ADR 0280): the next message can land on another web copy.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { getPendingState, putPendingState } from './pending-state.js';

/** Long enough for "for tomorrow" typed after a phone call; not a day. */
const TTL_MS = 2 * 60 * 60_000;

export interface LastEvent {
  eventId: string;
  title: string;
  startsAt: string;
  /** Guest addresses, lower case. */
  invitees: string[];
  /** The turn that made it: the same turn may make several events. */
  turnId: string;
  /** Set once create_event has asked about it. */
  askedSameMeeting?: boolean;
}

const keyFor = (groupId: string, userId: string): string => `${groupId}:${userId}`;

export async function recordLastEvent(db: Kysely<DB>, groupId: string, userId: string, ev: LastEvent): Promise<void> {
  await putPendingState(db, 'last_event', keyFor(groupId, userId), ev, TTL_MS);
}

export async function getLastEvent(db: Kysely<DB>, groupId: string, userId: string): Promise<LastEvent | null> {
  return getPendingState<LastEvent>(db, 'last_event', keyFor(groupId, userId));
}

const normTitle = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Is this create_event the event made a message ago again? A guest in common
 * or the same title, from a later message, not yet asked about.
 */
export function looksLikeLastEvent(
  last: LastEvent | null,
  next: { title: string; invitees: readonly string[]; turnId: string },
): boolean {
  if (!last || last.askedSameMeeting || last.turnId === next.turnId) return false;
  const guests = new Set(last.invitees);
  const shared = next.invitees.some((i) => guests.has(i.trim().toLowerCase()));
  return shared || normTitle(last.title) === normTitle(next.title);
}
