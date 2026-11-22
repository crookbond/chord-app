/**
 * SseHub — Redis pub/sub fanout (SSE fanout over Redis, ADR pending).
 *
 * ioredis is stubbed with an in-memory fake that mimics a shared Redis
 * broker across instances (a `publish` on one fake client delivers to every
 * *other* fake client subscribed to that channel, from any instance) so we
 * can simulate two Node processes talking through one Redis without a real
 * Redis server. Each fake client is one ioredis connection; `SseHub` opens
 * two per instance (pub, sub) exactly as it does against real Redis.
 */
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeRedisClient extends EventEmitter {
  private static bus = new Map<string, Set<FakeRedisClient>>();
  private subscribed = new Set<string>();

  constructor(public url?: string) {
    super();
  }

  async subscribe(...channels: string[]): Promise<void> {
    for (const channel of channels) {
      this.subscribed.add(channel);
      let set = FakeRedisClient.bus.get(channel);
      if (!set) {
        set = new Set();
        FakeRedisClient.bus.set(channel, set);
      }
      set.add(this);
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    const set = FakeRedisClient.bus.get(channel);
    if (!set) return 0;
    let delivered = 0;
    for (const client of set) {
      if (client.subscribed.has(channel)) {
        client.emit('message', channel, message);
        delivered++;
      }
    }
    return delivered;
  }

  disconnect(): void {
    for (const channel of this.subscribed) {
      FakeRedisClient.bus.get(channel)?.delete(this);
    }
    this.subscribed.clear();
  }

  static reset(): void {
    FakeRedisClient.bus.clear();
  }
}

vi.mock('ioredis', () => ({ default: FakeRedisClient }));

// Real env.ts loads normally here — every test constructs SseHub directly
// with an explicit redisUrl argument, so the module-level `sseHub` singleton
// (built from env.REDIS_URL) is never exercised by these tests.
const { SseHub } = await import('../sse.hub.js');
const { SSE } = await import('@chord/kernel');

function fakeResponse() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as import('express').Response;
}

beforeEach(() => {
  FakeRedisClient.reset();
});

describe('SseHub — no REDIS_URL (default)', () => {
  it('two instances never see each other’s broadcasts', () => {
    const hubA = new SseHub();
    const hubB = new SseHub();
    const res = fakeResponse();
    hubB.subscribe('group1', res);

    hubA.broadcast('group1', SSE.todosChanged, { groupId: 'group1' });

    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('todos.changed'));
    hubA.closeAll('shutdown');
    hubB.closeAll('shutdown');
  });
});

describe('SseHub — REDIS_URL set (fanout across two “nodes”)', () => {
  it('a broadcast on one hub reaches a subscriber connected to another hub', () => {
    const hubA = new SseHub('redis://fake');
    const hubB = new SseHub('redis://fake');
    const res = fakeResponse();
    hubB.subscribe('group1', res);

    hubA.broadcast('group1', SSE.todosChanged, { groupId: 'group1' });

    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('event: todos.changed'),
    );
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"groupId":"group1"'));

    hubA.closeAll('shutdown');
    hubB.closeAll('shutdown');
  });

  it('does not double-deliver to a subscriber on the originating hub', () => {
    const hubA = new SseHub('redis://fake');
    const res = fakeResponse();
    hubA.subscribe('group1', res);

    hubA.broadcast('group1', SSE.todosChanged, { groupId: 'group1' });

    // Local delivery happens once (direct write) — the Redis echo of this
    // hub's own publish must be ignored via the origin tag, not delivered
    // a second time.
    const calls = (res.write as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([payload]) => typeof payload === 'string' && payload.includes('todos.changed'),
    );
    expect(calls).toHaveLength(1);

    hubA.closeAll('shutdown');
  });

  it('fires onBroadcast listeners on every hub exactly once per event', () => {
    const hubA = new SseHub('redis://fake');
    const hubB = new SseHub('redis://fake');
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    hubA.onBroadcast(listenerA);
    hubB.onBroadcast(listenerB);

    hubA.broadcast('group1', SSE.todosChanged, { groupId: 'group1' });

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);

    hubA.closeAll('shutdown');
    hubB.closeAll('shutdown');
  });

  it('closeAll disconnects the redis connections without throwing', () => {
    const hub = new SseHub('redis://fake');
    expect(() => hub.closeAll('shutdown')).not.toThrow();
  });
});

// ADR 0280 — the phone's contact answer can land on a web copy that is not
// the one waiting for it.
describe('SseHub — peer messages', () => {
  it('reach the other process’s handler and not the sender’s own', () => {
    const hubA = new SseHub('redis://fake');
    const hubB = new SseHub('redis://fake');
    const onA = vi.fn();
    const onB = vi.fn();
    hubA.onPeerMessage('t', onA);
    hubB.onPeerMessage('t', onB);

    expect(hubA.sendToPeers('t', { x: 1 })).toBe(true);

    expect(onB).toHaveBeenCalledWith({ x: 1 });
    expect(onA).not.toHaveBeenCalled();
    hubA.closeAll('shutdown');
    hubB.closeAll('shutdown');
  });

  it('are not mistaken for a broadcast', () => {
    const hubA = new SseHub('redis://fake');
    const hubB = new SseHub('redis://fake');
    const listener = vi.fn();
    hubB.onBroadcast(listener);
    hubA.sendToPeers('t', { x: 1 });
    expect(listener).not.toHaveBeenCalled();
    hubA.closeAll('shutdown');
    hubB.closeAll('shutdown');
  });

  it('report that nobody can be reached without Redis', () => {
    const hub = new SseHub();
    expect(hub.sendToPeers('t', {})).toBe(false);
    hub.closeAll('shutdown');
  });
});
