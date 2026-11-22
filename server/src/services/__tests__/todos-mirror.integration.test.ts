/**
 * The To Do's hub hears about changes made elsewhere (ADR 0105).
 *
 * Tasks, lists and saves broadcast on their group channel — right for a chat
 * screen, useless for a hub that spans every group and subscribed to nothing.
 * A task ticked off on the web app stayed un-ticked on the phone until a
 * pull-to-refresh or a real background round trip.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SSE, type SseEventName } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { startTodosMirror } from '@/services/todos-mirror.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { settleBackgroundWork } from '@/utils/background.js';

/** Wait for the mirror's fire-and-forget fan-out to land. */
const settle = settleBackgroundWork;

describe('todos mirror', () => {
  let db: Kysely<DB>;
  let stop: () => void;
  let alice: string;
  let bob: string;
  let groupId: string;
  let seen: { channel: string; event: SseEventName; data: unknown }[];
  let unhook: () => void;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice-todos');
    bob = await createUser(db, 'bob-todos');
    await ensurePersonalGroup(db, alice);
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: alice });
    groupId = g.id;
    await addMember(db, groupId, bob);
    seen = [];
    unhook = sseHub.onBroadcast((channel, event, data) => {
      if (channel.startsWith('user:')) seen.push({ channel, event, data });
    });
    stop = startTodosMirror(db);
  });

  afterEach(async () => {
    stop();
    unhook();
    await closeTestDb(db);
  });

  const userChannels = () =>
    seen.filter((s) => s.event === SSE.todosChanged).map((s) => s.channel).sort();

  it('fans a group task change out to every member', async () => {
    sseHub.broadcast(groupId, SSE.taskUpdated, { id: 't1', groupId } as never);
    await settle();

    expect(userChannels()).toEqual([`user:${alice}`, `user:${bob}`].sort());
    // Only the group id travels: the hub refetches, and a payload nobody reads
    // is a payload that can leak.
    expect(seen[0]!.data).toEqual({ groupId });
  });

  it('mirrors list and save changes too — the other two tabs', async () => {
    sseHub.broadcast(groupId, SSE.listUpdated, { listId: 'l1' } as never);
    await settle();
    sseHub.broadcast(groupId, SSE.saveAdded, { id: 's1' } as never);
    await settle();

    expect(seen.filter((s) => s.event === SSE.todosChanged)).toHaveLength(4);
  });

  it('sends one change per member for a burst of writes to one group', async () => {
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: alice });
    sseHub.broadcast(groupId, SSE.taskCreated, { id: 't1', groupId } as never);
    sseHub.broadcast(groupId, SSE.taskCreated, { id: 't2', groupId } as never);
    sseHub.broadcast(groupId, SSE.listUpdated, { listId: 'l1' } as never);
    sseHub.broadcast(other.id, SSE.taskCreated, { id: 't3', groupId: other.id } as never);
    await settle();

    const changes = seen.filter((s) => s.event === SSE.todosChanged);
    expect(changes.map((c) => c.channel).sort()).toEqual(
      [`user:${alice}`, `user:${alice}`, `user:${bob}`].sort(),
    );
  });

  it('ignores events the hub does not render', async () => {
    sseHub.broadcast(groupId, SSE.message, { id: 'm1', groupId } as never);
    await settle();

    expect(userChannels()).toEqual([]);
  });

  it('does not mirror a mirror', async () => {
    // The fan-out itself broadcasts on user channels; re-entering would loop.
    sseHub.broadcastToUser(alice, SSE.todosChanged, { groupId });
    await settle();

    expect(seen.filter((s) => s.event === SSE.todosChanged)).toHaveLength(1);
  });

  it('reaches only members — a stranger hears nothing', async () => {
    const carol = await createUser(db, 'carol-outsider');
    await ensurePersonalGroup(db, carol);
    sseHub.broadcast(groupId, SSE.taskCreated, { id: 't2', groupId } as never);
    await settle();

    expect(userChannels()).not.toContain(`user:${carol}`);
  });
});
