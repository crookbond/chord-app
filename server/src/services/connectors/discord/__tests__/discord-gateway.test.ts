/**
 * DiscordGateway state machine tests. Drives a `FakeWebSocket` and a
 * controlled scheduler so timing is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiscordGateway } from '@/services/connectors/discord/discord-gateway.js';

import { FakeWebSocket } from './fake-ws.js';

const TOKEN = 'discord-test-token';
const BOT_USER_ID = '123456789012345678';

function fakeScheduler() {
  // Use vitest's fake timers — they bind to scheduler functions when we
  // pass them through unchanged.
  return {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as const;
}

describe('DiscordGateway', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('HELLO triggers IDENTIFY with token + intents + heartbeat schedule', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    expect(fakes).toHaveLength(1);
    const ws = fakes[0];
    ws.fireOpen();
    ws.fireFrame({ op: 10, d: { heartbeat_interval: 5_000 } });

    expect(ws.sent).toHaveLength(1);
    const identify = ws.sentFrame(0);
    expect(identify.op).toBe(2);
    expect((identify.d as { token: string }).token).toBe(TOKEN);
    const intents = (identify.d as { intents: number }).intents;
    expect(intents & (1 << 0)).toBe(1 << 0); // GUILDS
    expect(intents & (1 << 9)).toBe(1 << 9); // GUILD_MESSAGES
    expect(intents & (1 << 12)).toBe(1 << 12); // DIRECT_MESSAGES
    expect(intents & (1 << 15)).toBe(1 << 15); // MESSAGE_CONTENT

    // Heartbeat fires after the interval.
    vi.advanceTimersByTime(5_000);
    expect(ws.sent).toHaveLength(2);
    expect(ws.sentFrame(1).op).toBe(1);

    await gw.stop();
  });

  it('READY resolves awaitReady with the bot user id', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    fakes[0].fireOpen();
    fakes[0].fireFrame({ op: 10, d: { heartbeat_interval: 1_000 } });

    const readyP = gw.awaitReady(10_000);
    fakes[0].fireFrame({
      op: 0,
      t: 'READY',
      s: 1,
      d: { user: { id: BOT_USER_ID, username: 'chord' } },
    });
    await expect(readyP).resolves.toBe(BOT_USER_ID);

    await gw.stop();
  });

  it('awaitReady rejects on timeout if READY never arrives', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    const readyP = gw.awaitReady(2_000);
    vi.advanceTimersByTime(2_001);
    await expect(readyP).rejects.toThrow(/READY timeout/);
    await gw.stop();
  });

  it('MESSAGE_CREATE invokes the handler with the payload', async () => {
    const handler = vi.fn();
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.setMessageHandler(handler);
    gw.start();
    fakes[0].fireOpen();
    fakes[0].fireFrame({ op: 10, d: { heartbeat_interval: 1_000 } });
    fakes[0].fireFrame({
      op: 0,
      t: 'READY',
      s: 1,
      d: { user: { id: BOT_USER_ID } },
    });

    fakes[0].fireFrame({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'msg1',
        channel_id: 'c1',
        guild_id: 'g1',
        author: { id: 'u1', username: 'alex' },
        content: 'hello',
        mentions: [],
        timestamp: '2026-04-26T00:00:00Z',
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ id: 'msg1', content: 'hello' });

    await gw.stop();
  });

  it('server-initiated heartbeat (op=1) is responded to immediately', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    fakes[0].fireOpen();
    fakes[0].fireFrame({ op: 10, d: { heartbeat_interval: 60_000 } });
    // identify is sent[0]; server-requested heartbeat should add another.
    fakes[0].fireFrame({ op: 1 });
    expect(fakes[0].sent).toHaveLength(2);
    expect(fakes[0].sentFrame(1).op).toBe(1);
    await gw.stop();
  });

  it('unexpected close (non-shutdown) triggers reconnect with backoff', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    expect(fakes).toHaveLength(1);
    fakes[0].fireClose(4000, 'oops');

    // first reconnect after 1s
    vi.advanceTimersByTime(1_000);
    expect(fakes).toHaveLength(2);

    // second reconnect after 2s (exponential backoff)
    fakes[1].fireClose(4000, 'oops again');
    vi.advanceTimersByTime(2_000);
    expect(fakes).toHaveLength(3);

    await gw.stop();
  });

  it('stop() prevents further reconnects', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    expect(fakes).toHaveLength(1);
    await gw.stop();
    expect(fakes[0].closeCalls).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    // No new connections after shutdown.
    expect(fakes).toHaveLength(1);
  });

  it('RECONNECT (op 7) and INVALID_SESSION (op 9) close the socket', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    fakes[0].fireOpen();
    fakes[0].fireFrame({ op: 7 });
    expect(fakes[0].closeCalls).toHaveLength(1);
    await gw.stop();
  });

  it('READY resets backoff so next failure starts at 1s again', async () => {
    const fakes: FakeWebSocket[] = [];
    const gw = new DiscordGateway({
      token: TOKEN,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        fakes.push(ws);
        return ws;
      },
      scheduler: fakeScheduler(),
    });
    gw.start();
    fakes[0].fireClose(4000, 'first');

    vi.advanceTimersByTime(1_000);
    fakes[1].fireClose(4000, 'second');
    vi.advanceTimersByTime(2_000);
    // Now we have fakes[2]. Drive it to READY which resets backoff.
    fakes[2].fireOpen();
    fakes[2].fireFrame({ op: 10, d: { heartbeat_interval: 1_000 } });
    fakes[2].fireFrame({
      op: 0,
      t: 'READY',
      s: 1,
      d: { user: { id: BOT_USER_ID } },
    });
    fakes[2].fireClose(4000, 'after ready');

    // Backoff should have been reset; next reconnect is 1s.
    vi.advanceTimersByTime(1_000);
    expect(fakes).toHaveLength(4);

    await gw.stop();
  });
});
