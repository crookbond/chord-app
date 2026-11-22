/**
 * The To Do's hub learns about changes made elsewhere (ADR 0105).
 *
 * Tasks, lists and saves broadcast on their GROUP channel, which is right for
 * a chat screen — but the To Do's hub is not one group, it is every group the
 * user belongs to. It subscribed to nothing, so a task ticked off on the web
 * app stayed un-ticked on the phone until a pull-to-refresh, a real
 * background→foreground round trip, or a tab change after the 30s cache
 * window. In practice: the phone showed everything as still to do.
 *
 * Rather than have that screen open one stream per group — the battery cost
 * ADR 0082 exists to avoid — the events are mirrored onto each member's own
 * user channel, which the hub already has one connection to.
 *
 * A single `todos.changed` carrying only the group id, not the entity: the
 * hub refetches whichever tab is showing, so a faithful per-entity payload
 * would be work nobody reads. Same `onBroadcast` seam the push publisher uses
 * (ADR 0054), so no write path has to remember to call this.
 */
import type { Kysely } from 'kysely';

import { SSE, type SseEventName } from '@chord/kernel';

import { logger } from '../config/logging.js';
import { runInBackground } from '../utils/background.js';
import type { DB } from '../db/schema.js';
import { isLeader } from './cluster/leadership.js';
import { sseHub } from './sse.hub.js';

/** Group-channel events that change what the To Do's hub renders. */
const TODO_EVENTS: ReadonlySet<SseEventName> = new Set<SseEventName>([
  SSE.taskCreated,
  SSE.taskUpdated,
  SSE.listUpdated,
  SSE.saveAdded,
  // Action Items lists pending proposals, so one arriving or being settled
  // (confirmed, dismissed, or cancelled with its deleted email) changes it.
  SSE.proposalCreated,
  SSE.proposalResolved,
]);

/** One bot turn writes several rows at once; their events reach a member as
 *  one `todos.changed` per group, sent this long after the first. */
const COALESCE_MS = 250;

export function startTodosMirror(db: Kysely<DB>): () => void {
  const scheduled = new Set<string>();
  return sseHub.onBroadcast((channel, event) => {
    if (!TODO_EVENTS.has(event)) return;
    // User channels carry the mirror itself; re-mirroring one would loop.
    if (channel.startsWith('user:')) return;
    // ADR 0280 — every worker copy hears every broadcast; one of them mirrors.
    if (!isLeader('worker')) return;
    if (scheduled.has(channel)) return;
    scheduled.add(channel);

    runInBackground(
      new Promise((resolve) => setTimeout(resolve, COALESCE_MS))
        .then(() => {
          // Cleared before the read, so a change landing during it is sent too.
          scheduled.delete(channel);
          return mirror(db, channel);
        })
        .catch((err) => logger.warn('todos mirror: fan-out failed', { err, groupId: channel })),
    );
  });
}

/**
 * Fan out to the group's members. Membership is the scope check (ADR 0004):
 * everyone told about the change is already entitled to read the entity that
 * changed, and nothing about it is in the payload regardless.
 */
async function mirror(db: Kysely<DB>, groupId: string): Promise<void> {
  const members = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .execute();
  for (const m of members) {
    sseHub.broadcastToUser(m.user_id, SSE.todosChanged, { groupId });
  }
}
