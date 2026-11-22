/**
 * Work nobody awaits must not fail silently: runInBackground swallowed every
 * rejection, so a calendar push or a read-time check that threw left no trace.
 */
import { describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ error: [] as Array<[string, unknown]> }));

vi.mock('@/config/logging.js', async (orig) => {
  const real = await orig<typeof import('@/config/logging.js')>();
  return {
    ...real,
    logger: {
      ...real.logger,
      error: (message: string, meta: unknown) => {
        logged.error.push([message, meta]);
      },
    },
  };
});

import { runInBackground, settleBackgroundWork } from '@/utils/background.js';

describe('runInBackground', () => {
  it('logs a rejection at error and still settles', async () => {
    logged.error.length = 0;
    runInBackground(Promise.reject(new Error('push refused')), 'calendar push');
    await settleBackgroundWork();
    expect(logged.error).toHaveLength(1);
    expect(logged.error[0]![0]).toBe('calendar push failed');
    expect(logged.error[0]![1]).toMatchObject({ err: 'push refused' });
  });

  it('logs nothing for work that succeeds', async () => {
    logged.error.length = 0;
    runInBackground(Promise.resolve(1));
    await settleBackgroundWork();
    expect(logged.error).toEqual([]);
  });
});
