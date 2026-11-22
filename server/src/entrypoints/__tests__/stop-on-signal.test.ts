import { afterEach, describe, expect, it } from 'vitest';
import { stopOnSignal } from '../stop-on-signal.js';

const added: Array<() => void> = [];
function register(...args: Parameters<typeof stopOnSignal>) {
  const before = { int: process.listeners('SIGINT'), term: process.listeners('SIGTERM') };
  const handle = stopOnSignal(...args);
  const newInt = process.listeners('SIGINT').filter((l) => !before.int.includes(l));
  const newTerm = process.listeners('SIGTERM').filter((l) => !before.term.includes(l));
  added.push(() => {
    for (const l of newInt) process.off('SIGINT', l);
    for (const l of newTerm) process.off('SIGTERM', l);
  });
  return handle;
}

afterEach(() => {
  while (added.length) added.pop()!();
});

describe('stopOnSignal', () => {
  it('stops once and exits 0 when systemd and an operator both send a signal', async () => {
    let stops = 0;
    let release!: () => void;
    const exits: number[] = [];
    const handle = register(
      'worker',
      async () => {
        stops++;
        await new Promise<void>((r) => (release = r));
      },
      (code) => exits.push(code),
    );

    const first = handle('SIGTERM');
    const second = handle('SIGINT');
    release();
    await Promise.all([first, second]);

    expect(stops).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('exits 1 when the stop itself fails, so the crash reporter files it', async () => {
    const exits: number[] = [];
    const handle = register(
      'web',
      async () => {
        throw new Error('pool already closed');
      },
      (code) => exits.push(code),
    );

    await handle('SIGTERM');

    expect(exits).toEqual([1]);
  });
});
