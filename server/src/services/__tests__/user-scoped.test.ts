/**
 * One account's offline queue, phone drafts and to-do notices are never
 * merged into, shown to, or sent as another (kernel user-scoped). Kernel has
 * no harness of its own, so the rules are tested here.
 */
import { describe, expect, it } from 'vitest';

import { mergeForUser, onlyForUser, nextToSend, type QueuedSend } from '@chord/kernel';

const send = (localId: string, uid: string | null | undefined, queuedAt = 1): QueuedSend => ({
  localId,
  kind: 'chat',
  payload: { body: `from ${uid}` },
  queuedAt,
  status: 'queued',
  uid,
});

describe('mergeForUser', () => {
  it("A's queued message held in memory is not adopted into B's queue", () => {
    // The reported shape: A queued a chat message offline, the app switched to
    // B (Google connect re-pointing the session) without a sign-out, and B's
    // first flush sent A's message with B's session.
    const merged = mergeForUser({
      uid: 'B',
      stored: [send('b1', undefined)],
      held: [send('a1', 'A')],
      key: (m) => m.localId,
      prefer: 'stored',
    });
    expect(merged.map((m) => m.localId)).toEqual(['b1']);
    expect(nextToSend(merged)?.payload).toEqual({ body: 'from undefined' });
  });

  it('what this user queued before their saved copy was read is kept, the saved copy winning', () => {
    const merged = mergeForUser({
      uid: 'B',
      stored: [send('b1', 'B', 1)],
      held: [send('b1', 'B', 9), send('b2', 'B', 2)],
      key: (m) => m.localId,
      prefer: 'stored',
    });
    expect(merged.map((m) => [m.localId, m.queuedAt])).toEqual([
      ['b1', 1],
      ['b2', 2],
    ]);
  });

  it('entries held for nobody are left behind', () => {
    const merged = mergeForUser({
      uid: 'B',
      stored: [],
      held: [send('x', null), send('y', undefined)],
      key: (m) => m.localId,
      prefer: 'held',
    });
    expect(merged).toEqual([]);
  });

  it("what is read from the user's own folder is theirs, tagged or not", () => {
    const merged = mergeForUser({
      uid: 'B',
      stored: [send('old', undefined)],
      held: [],
      key: (m) => m.localId,
      prefer: 'held',
    });
    expect(merged[0].uid).toBe('B');
  });

  it('prefer held: the copy in memory wins over the saved one (drafts edited since)', () => {
    const merged = mergeForUser({
      uid: 'B',
      stored: [send('d', 'B', 1)],
      held: [send('d', 'B', 5)],
      key: (m) => m.localId,
      prefer: 'held',
    });
    expect(merged.map((m) => m.queuedAt)).toEqual([5]);
  });
});

describe('onlyForUser', () => {
  it("never hands another account's sends to the flush", () => {
    const items = [send('a1', 'A'), send('b1', 'B', 2)];
    expect(nextToSend(onlyForUser(items, 'B'))?.localId).toBe('b1');
    expect(onlyForUser(items, null)).toEqual([]);
  });
});
