/**
 * Invitees still waiting on an email address (ADR 0157, structural fix ADR 0166).
 *
 * Tool results do not survive a turn (ADR 0093 — `buildConvo` replays prose
 * only), so once `create_event`/`update_event` returns `unresolvedInvitees`,
 * only the bot's own chat sentence carries that fact forward. A later reply
 * like "Karl's email is x@y.com" has no imperative verb and nothing forces
 * the model to connect it back to a sentence several turns behind it — this
 * is the server's record of who is still owed an email, read back into the
 * system prompt every turn until it is resolved or goes stale.
 *
 * Lives in Postgres (ADR 0280), so the answer can reach any web copy and a
 * deploy does not forget it. A longer TTL than `enumeration.ts`'s 30 minutes:
 * an enumerated list goes stale the moment the underlying data could have
 * changed, but "text me their email" is a real-world errand that can take
 * hours, not minutes.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { addressesIn } from '../email/known-addresses.js';
import { deletePendingState, getPendingState, putPendingState } from './pending-state.js';

const TTL_MS = 24 * 60 * 60_000;

export interface PendingInvite {
  eventId: string;
  eventTitle: string;
  name: string;
  at: number;
}

function keyFor(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

function fresh(list: PendingInvite[]): PendingInvite[] {
  const cutoff = Date.now() - TTL_MS;
  return list.filter((e) => e.at >= cutoff);
}

/**
 * Replace this event's pending set with whatever names are still unresolved
 * after a `create_event`/`update_event` call. Called every time either tool
 * touches invitees — including with an empty `names`, which is how a later
 * call that fully resolves the guest list clears the reminder.
 */
export async function recordPendingInvitees(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  eventId: string,
  eventTitle: string,
  names: string[],
): Promise<void> {
  const k = keyFor(groupId, userId);
  const current = (await getPendingState<PendingInvite[]>(db, 'invitees', k)) ?? [];
  const rest = fresh(current).filter((e) => e.eventId !== eventId);
  const added = names.map((name) => ({ eventId, eventTitle, name, at: Date.now() }));
  const next = [...rest, ...added];
  if (next.length === 0) await deletePendingState(db, 'invitees', k);
  else await putPendingState(db, 'invitees', k, next, TTL_MS);
}

/** Everything still waiting on an email for this user, in this group. */
export async function listPendingInvitees(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<PendingInvite[]> {
  return fresh((await getPendingState<PendingInvite[]>(db, 'invitees', keyFor(groupId, userId))) ?? []);
}

/**
 * The STRICT-mode instruction for a turn whose message supplies an address
 * while invitees are still waiting on one, or null when there is nothing to
 * finish. The prompt block only asks; a bare address has no verb, so the
 * imperative retry never fired and a prose-only reply left the invite unsent.
 */
export async function pendingInviteRetryInstruction(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  body: string,
): Promise<string | null> {
  const addresses = addressesIn(body);
  if (addresses.length === 0) return null;
  const pending = await listPendingInvitees(db, groupId, userId);
  if (pending.length === 0) return null;
  const lines = pending.map((p) => `- "${p.name}" for event "${p.eventTitle}" (eventId ${p.eventId})`);
  return (
    `STRICT MODE: The user's last message gives the email address ${addresses.join(', ')}. ` +
    'You asked them for an email for:\n' +
    lines.join('\n') +
    '\nYour previous reply did not add it to the event. Call update_event NOW with that eventId and ' +
    'invitees: [the address]. If several people are waiting and the message does not say whose ' +
    'address it is, ask whose it is instead. Do not claim anyone was invited unless update_event says so.'
  );
}
