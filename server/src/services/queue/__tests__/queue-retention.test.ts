/**
 * The 2026-10-03 outage: the proactive tick queue kept every finished job
 * until Redis ran out of memory, and the three queue workers then logged the
 * same refusal on every poll until the disk was full.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bull = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(async () => ({})),
  clean: vi.fn(async () => []),
  workerOn: vi.fn(),
}));

vi.mock('bullmq', () => ({
  // `function`, not an arrow: vitest 4 refuses `new` on an arrow-function mock.
  Queue: vi.fn(function () {
    return {
      upsertJobScheduler: bull.upsertJobScheduler,
      clean: bull.clean,
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    };
  }),
  Worker: vi.fn(function () {
    return { on: bull.workerOn, close: vi.fn(async () => undefined) };
  }),
}));
vi.mock('../redis.js', async (orig) => ({
  ...(await orig<typeof import('../redis.js')>()),
  makeQueueConnection: vi.fn(() => ({ disconnect: vi.fn() })),
}));
vi.mock('../../proactive.service.js', () => ({
  drainOnce: vi.fn(async () => undefined),
  seedDailyScan: vi.fn(async () => undefined),
}));

import { startProactiveQueue } from '../../proactive.queue.js';
import { QUEUE_ERROR_LOG_INTERVAL_MS, queueErrorLogger } from '../redis.js';

describe('proactive tick queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes a tick once it has run, so finished ticks cannot pile up in Redis', async () => {
    const handle = await startProactiveQueue({} as never, 'redis://unused');

    const template = bull.upsertJobScheduler.mock.calls[0] as unknown as [
      string,
      unknown,
      { opts?: { removeOnComplete?: unknown; removeOnFail?: unknown } },
    ];
    expect(template[2].opts?.removeOnComplete).toBe(true);
    // Failures are kept, but a bounded number of them.
    expect(template[2].opts?.removeOnFail).toEqual({ count: 50 });
    await handle.stop();
  });

  it('clears finished ticks left behind by a version that kept them', async () => {
    const handle = await startProactiveQueue({} as never, 'redis://unused');

    expect(bull.clean).toHaveBeenCalledWith(0, expect.any(Number), 'completed');
    await handle.stop();
  });
});

describe('queueErrorLogger', () => {
  // The shape from prod: a Redis reply error whose message is the only useful
  // part, arriving on every poll.
  const oom = (): Error => new Error("OOM command not allowed when used memory > 'maxmemory'.");

  it('writes one line for a burst, not one per error', () => {
    let t = 1_000;
    const log = vi.fn();
    const onError = queueErrorLogger('proactive queue worker error', log, () => t);

    for (let i = 0; i < 3_481; i++) {
      onError(oom());
      t += 5;
    }

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('says what Redis said', () => {
    const log = vi.fn();
    queueErrorLogger('mail sync queue worker error', log, () => 0)(oom());

    expect(log).toHaveBeenCalledWith('mail sync queue worker error', {
      err: "OOM command not allowed when used memory > 'maxmemory'.",
    });
  });

  it('keeps reporting while the fault lasts, with how many it left out', () => {
    let t = 0;
    const log = vi.fn();
    const onError = queueErrorLogger('bot turn queue worker error', log, () => t);

    onError(oom());
    t += 10;
    onError(oom());
    onError(oom());
    t += QUEUE_ERROR_LOG_INTERVAL_MS;
    onError(oom());

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][1]).toMatchObject({ suppressedSinceLast: 2 });
  });

  it('reports a new fault at once after a quiet spell', () => {
    let t = 0;
    const log = vi.fn();
    const onError = queueErrorLogger('x', log, () => t);

    onError(oom());
    t += QUEUE_ERROR_LOG_INTERVAL_MS * 10;
    onError(new Error('READONLY'));

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][1]).toEqual({ err: 'READONLY' });
  });
});
