/**
 * A personal event or trip that could be shared with a group, waiting on the
 * user's answer (ADR 0232 / 0233, same reason and shape as ADR 0166's pending
 * invitees).
 *
 * Tool results do not survive a turn (ADR 0093 — `buildConvo` replays prose
 * only), so when the bot offers "want this on the family group too?", the
 * user's next message ("yes") has nothing to point back at except the bot's own
 * sentence. This is the server's record of what was offered and to which
 * groups, read back into the system prompt until it is answered or goes stale.
 *
 * One offer at a time per user and chat: the answer to "yes" must not be
 * ambiguous, so a newer offer replaces an older one.
 *
 * Lives in Postgres (ADR 0280), so "yes" can reach any web copy. The TTL is
 * short: "yes" to a question asked a moment ago means that thing; an answer
 * hours later is a different conversation.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { deletePendingState, getPendingState, putPendingState } from './pending-state.js';

const TTL_MS = 60 * 60_000;

export type FanoutKind = 'event' | 'trip';

export interface PendingFanout {
  kind: FanoutKind;
  /** The event id or the trip id, per `kind`. */
  entityId: string;
  title: string;
  /** Group NAMES, never ids — ADR 0032's scrubber strips ids from anything the
   *  model sees, and a name is what the user answers with. */
  groups: string[];
  at: number;
}

const keyFor = (groupId: string, userId: string): string => `${groupId}:${userId}`;

export async function recordPendingFanout(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  offer: { kind: FanoutKind; entityId: string; title: string; groups: string[] },
): Promise<void> {
  await putPendingState(db, 'fanout', keyFor(groupId, userId), { ...offer, at: Date.now() }, TTL_MS);
}

export async function getPendingFanout(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<PendingFanout | null> {
  return getPendingState<PendingFanout>(db, 'fanout', keyFor(groupId, userId));
}

export async function clearPendingFanout(db: Kysely<DB>, groupId: string, userId: string): Promise<void> {
  await deletePendingState(db, 'fanout', keyFor(groupId, userId));
}
