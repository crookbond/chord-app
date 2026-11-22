/**
 * ADR 0280 — one owner per singleton duty across processes.
 *
 * Each `Leadership` holds its own Postgres session, which is exactly what two
 * processes have. Advisory locks need no schema, so this uses the base test
 * database directly (see proactive-drain-lock.test.ts for why a cloned test
 * database would not contend). Each test uses its own duty name so parallel
 * workers never compete for the same lock.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_URL } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';
import {
  __testing,
  isLeader,
  Leadership,
  runWhileLeader,
} from '@/services/cluster/leadership.js';

const opened: Leadership[] = [];

function process_(): Leadership {
  // A long tick: these tests drive tick() themselves.
  const l = new Leadership(TEST_URL, { tickMs: 60_000 });
  opened.push(l);
  return l;
}

const duty = (): string => `test-${randomUUID()}`;

afterEach(async () => {
  __testing.reset();
  await Promise.all(opened.splice(0).map((l) => l.stop()));
});

describe('Leadership', () => {
  it('only one of two processes holds a duty', async () => {
    const a = process_();
    const b = process_();
    const name = duty();
    a.claim(name);
    await a.tick();
    b.claim(name);
    await b.tick();
    expect(a.isLeader(name)).toBe(true);
    expect(b.isLeader(name)).toBe(false);
  });

  it('the other process takes over when the holder stops', async () => {
    const a = process_();
    const b = process_();
    const name = duty();
    a.claim(name);
    await a.tick();
    b.claim(name);
    await b.tick();
    await a.stop();
    await b.tick();
    expect(b.isLeader(name)).toBe(true);
  });

  it('a holder whose connection dies stops acting, and the other takes over', async () => {
    const a = process_();
    const b = process_();
    const name = duty();
    const seen: boolean[] = [];
    a.claim(name, (held) => seen.push(held));
    await a.tick();
    b.claim(name);
    expect(seen).toEqual([true]);

    // Kill A's session from outside, as a network failure or a database
    // restart would. Postgres drops the lock with it.
    const admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
         WHERE locktype = 'advisory' AND objid = hashtext($1)::oid AND granted`,
        [name],
      );
    } finally {
      await admin.end();
    }

    // A notices on its own (the connection's error/end) or on its next check.
    // Stop ticking A once it has: a later pass would reconnect and could win
    // the freed lock back before B asks, which is correct but not this test.
    expect(
      await waitFor(async () => {
        if (seen.includes(false)) return true;
        await a.tick();
        return seen.includes(false);
      }),
    ).toBe(true);
    expect(a.isLeader(name)).toBe(false);
    await b.tick();
    expect(b.isLeader(name)).toBe(true);
  });

  it('a released claim lets the other process take it', async () => {
    const a = process_();
    const b = process_();
    const name = duty();
    const release = a.claim(name);
    await a.tick();
    b.claim(name);
    await release();
    expect(a.isLeader(name)).toBe(false);
    await b.tick();
    expect(b.isLeader(name)).toBe(true);
  });
});

describe('runWhileLeader', () => {
  it('without leadership started, every duty runs (one process)', async () => {
    let running = false;
    const stop = runWhileLeader('worker', () => {
      running = true;
      return () => {
        running = false;
      };
    });
    expect(isLeader('worker')).toBe(true);
    expect(running).toBe(true);
    await stop();
    expect(running).toBe(false);
  });

  it('starts the duty only while held, and stops it when lost', async () => {
    const a = process_();
    const b = process_();
    // Another process got there first.
    b.claim('worker');
    await b.tick();
    __testing.set(a);
    let running = 0;
    const stopDuty = runWhileLeader('worker', () => {
      running += 1;
      return () => {
        running -= 1;
      };
    });
    await a.tick();
    expect(running).toBe(0);
    expect(isLeader('worker')).toBe(false);

    await b.stop();
    await a.tick();
    expect(running).toBe(1);
    expect(isLeader('worker')).toBe(true);

    await stopDuty();
    expect(running).toBe(0);
  });
});
