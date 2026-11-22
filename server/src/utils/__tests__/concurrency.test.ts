import { describe, expect, it } from 'vitest';

import { coalescePerKey, mapConcurrent } from '../concurrency.js';

describe('mapConcurrent', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapConcurrent(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('never runs more than `limit` at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapConcurrent(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    const results = await mapConcurrent([], 5, async (x: number) => x);
    expect(results).toEqual([]);
  });

  it('handles limit larger than the item count', async () => {
    const results = await mapConcurrent([1, 2, 3], 100, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it('propagates a rejection', async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      })
    ).rejects.toThrow('boom');
  });
});

describe('coalescePerKey', () => {
  it('shares one run per key and queues at most one follow-up', async () => {
    const run = coalescePerKey<number>();
    let started = 0;
    const releases: Array<() => void> = [];
    const fn = () => {
      started++;
      const n = started;
      return new Promise<number>((resolve) => releases.push(() => resolve(n)));
    };
    const a = run('u', fn);
    const b = run('u', fn);
    const c = run('u', fn);
    const other = run('v', fn);
    expect(started).toBe(2); // 'u' once, 'v' once
    releases.shift()!();
    expect(await a).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(3); // the one follow-up for b and c
    releases.shift()!();
    releases.shift()!();
    expect(await other).toBe(2);
    expect(await b).toBe(3);
    expect(await c).toBe(3);
    // Idle again: a new call starts fresh.
    const d = run('u', fn);
    expect(started).toBe(4);
    releases.shift()!();
    expect(await d).toBe(4);
  });

  it('runs the follow-up even when the current run fails', async () => {
    const run = coalescePerKey<string>();
    let calls = 0;
    const first = run('u', async () => {
      calls++;
      throw new Error('boom');
    });
    const second = run('u', async () => {
      calls++;
      return 'ok';
    });
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('ok');
    expect(calls).toBe(2);
  });
});
