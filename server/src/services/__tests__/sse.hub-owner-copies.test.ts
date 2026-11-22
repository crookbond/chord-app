/**
 * A group event fans out into one copy per member (ADR 0040), each tagged with
 * its owner, and every copy used to be broadcast to the whole group channel: N
 * members meant N broadcasts each written to N sockets. The client acts only on
 * the copy it owns, so a copy now goes only to its owner's streams.
 */
import { describe, expect, it, vi } from 'vitest';

import { SSE } from '@chord/kernel';

import { SseHub } from '../sse.hub.js';

function fakeResponse() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as import('express').Response & { write: ReturnType<typeof vi.fn> };
}

/** Frames written after the initial ": subscribed" comment. */
const frames = (res: { write: ReturnType<typeof vi.fn> }): string[] =>
  res.write.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('event:'));

const copy = (ownerUserId: string | undefined) =>
  ({ id: `e_${ownerUserId ?? 'none'}`, groupId: 'g1', title: 'Potluck', ownerUserId }) as never;

describe('SseHub owner-scoped event copies', () => {
  it('delivers a member’s copy only to that member', () => {
    const hub = new SseHub();
    const alice = fakeResponse();
    const bob = fakeResponse();
    hub.subscribe('g1', alice, 'alice');
    hub.subscribe('g1', bob, 'bob');

    hub.broadcast('g1', SSE.eventCreated, copy('alice'));

    expect(frames(alice)).toHaveLength(1);
    expect(frames(bob)).toHaveLength(0);
    hub.closeAll('shutdown');
  });

  it('covers created, updated and deleted', () => {
    const hub = new SseHub();
    const alice = fakeResponse();
    const bob = fakeResponse();
    hub.subscribe('g1', alice, 'alice');
    hub.subscribe('g1', bob, 'bob');

    hub.broadcast('g1', SSE.eventCreated, copy('bob'));
    hub.broadcast('g1', SSE.eventUpdated, copy('bob'));
    hub.broadcast('g1', SSE.eventDeleted, { id: 'e1', ownerUserId: 'bob' });

    expect(frames(bob)).toHaveLength(3);
    expect(frames(alice)).toHaveLength(0);
    hub.closeAll('shutdown');
  });

  it('an event with no owner (a legacy single copy) still goes to everyone', () => {
    const hub = new SseHub();
    const alice = fakeResponse();
    const bob = fakeResponse();
    hub.subscribe('g1', alice, 'alice');
    hub.subscribe('g1', bob, 'bob');

    hub.broadcast('g1', SSE.eventCreated, copy(undefined));

    expect(frames(alice)).toHaveLength(1);
    expect(frames(bob)).toHaveLength(1);
    hub.closeAll('shutdown');
  });

  it('other events are unaffected: a message reaches every subscriber', () => {
    const hub = new SseHub();
    const alice = fakeResponse();
    const bob = fakeResponse();
    hub.subscribe('g1', alice, 'alice');
    hub.subscribe('g1', bob, 'bob');

    hub.broadcast('g1', SSE.message, { id: 'm1', groupId: 'g1', body: 'hi', ownerUserId: 'alice' } as never);

    expect(frames(alice)).toHaveLength(1);
    expect(frames(bob)).toHaveLength(1);
    hub.closeAll('shutdown');
  });

  it('a person with two open streams gets the copy on both', () => {
    const hub = new SseHub();
    const phone = fakeResponse();
    const laptop = fakeResponse();
    hub.subscribe('g1', phone, 'alice');
    hub.subscribe('g1', laptop, 'alice');

    hub.broadcast('g1', SSE.eventCreated, copy('alice'));

    expect(frames(phone)).toHaveLength(1);
    expect(frames(laptop)).toHaveLength(1);
    hub.closeAll('shutdown');
  });

  it('still tells onBroadcast listeners about every copy', () => {
    const hub = new SseHub();
    const seen: string[] = [];
    hub.onBroadcast((_ch, event) => seen.push(event));
    hub.subscribe('g1', fakeResponse(), 'alice');

    hub.broadcast('g1', SSE.eventCreated, copy('alice'));
    hub.broadcast('g1', SSE.eventCreated, copy('bob'));

    expect(seen).toEqual([SSE.eventCreated, SSE.eventCreated]);
    hub.closeAll('shutdown');
  });

  it('a 100-member group costs 100 socket writes per event, not 10,000', () => {
    const hub = new SseHub();
    const members = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, res: fakeResponse() }));
    for (const m of members) hub.subscribe('g1', m.res, m.id);

    // What createEvent does: one broadcast per fanned-out copy.
    for (const m of members) hub.broadcast('g1', SSE.eventCreated, copy(m.id));

    const writes = members.reduce((n, m) => n + frames(m.res).length, 0);
    expect(writes).toBe(100);
    for (const m of members) expect(frames(m.res)).toHaveLength(1);
    hub.closeAll('shutdown');
  });
});
