/**
 * ADR 0280 — one owner per singleton duty when a role runs as several copies.
 *
 * Each process holds one dedicated Postgres connection (never one from the app
 * pool) and takes a session advisory lock per duty it competes for. Postgres
 * releases a session lock when the connection drops, so a dead process gives
 * up its duties with nobody cleaning up after it; a periodic `SELECT 1` and the
 * client's error/end events make a live holder notice it lost the connection
 * and stop acting.
 *
 * Never started (tests, a one-off script) means every duty is held: the
 * single-process behaviour every caller had before this existed.
 */
import pg from 'pg';

import { logger } from '../../config/logging.js';

export type DutyName = 'im' | 'worker';

/** First half of the two-int advisory key; the duty name is the second. */
const LOCK_NAMESPACE = 'chord-leader';

interface Options {
  /** How often an unheld duty is retried and a held one health-checked. */
  tickMs: number;
}

type Listener = (held: boolean) => void;

export class Leadership {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private readonly wanted = new Map<string, Set<Listener>>();
  private readonly held = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private stopped = false;

  constructor(
    private readonly connectionString: string,
    private readonly opts: Options = { tickMs: 5_000 },
  ) {}

  start(): void {
    if (this.timer) return;
    // A pass stuck on a dead connection must not pile up timer passes behind it.
    this.timer = setInterval(() => {
      if (this.queued === 0) void this.tick();
    }, this.opts.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  isLeader(name: string): boolean {
    return this.held.has(name);
  }

  /** Compete for `name`. The returned function stops competing and releases it. */
  claim(name: string, listener?: Listener): () => Promise<void> {
    let set = this.wanted.get(name);
    if (!set) {
      set = new Set();
      this.wanted.set(name, set);
    }
    const own: Listener = listener ?? (() => {});
    set.add(own);
    if (this.held.has(name)) own(true);
    void this.tick();
    return async () => {
      const s = this.wanted.get(name);
      s?.delete(own);
      if (this.held.has(name)) own(false);
      if (s && s.size === 0) {
        this.wanted.delete(name);
        await this.release(name);
      }
    };
  }

  /**
   * Run one pass after any pass already running, so a caller that awaits it
   * sees its result (a pass skipped because another was running would not
   * have looked at a duty claimed in between). Exported for tests; the
   * interval calls it otherwise.
   */
  tick(): Promise<void> {
    this.queued += 1;
    const run = this.chain.then(() => this.pass()).finally(() => {
      this.queued -= 1;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async pass(): Promise<void> {
    if (this.stopped) return;
    const client = await this.connection();
    if (!client) return;
    if (this.held.size > 0) {
      try {
        await client.query('SELECT 1');
      } catch (err) {
        this.lose(err);
        return;
      }
    }
    for (const name of [...this.wanted.keys()]) {
      if (this.held.has(name)) continue;
      try {
        const r = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
          [LOCK_NAMESPACE, name],
        );
        if (r.rows[0]?.locked !== true) continue;
        if (!this.wanted.has(name)) {
          // Released while we were asking: give it straight back.
          await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [LOCK_NAMESPACE, name]);
          continue;
        }
        this.held.add(name);
        logger.info('leadership acquired', { duty: name });
        this.notify(name, true);
      } catch (err) {
        this.lose(err);
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const name of [...this.held]) this.notify(name, false);
    this.held.clear();
    const client = this.client;
    this.client = null;
    // Closing the session releases every lock it held.
    await client?.end().catch(() => {});
  }

  private async connection(): Promise<pg.Client | null> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new pg.Client({ connectionString: this.connectionString, keepAlive: true });
        client.on('error', (err) => this.lose(err, client));
        client.on('end', () => this.lose(new Error('connection ended'), client));
        try {
          await client.connect();
          this.client = client;
        } catch (err) {
          logger.warn('leadership: could not connect, will retry', { err: (err as Error).message });
          await client.end().catch(() => {});
        }
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    return this.client;
  }

  /** The session is gone or unusable: every lock it held is gone with it. */
  private lose(err: unknown, client: pg.Client | null = this.client): void {
    if (client !== this.client || !client) return;
    this.client = null;
    if (!this.stopped) {
      logger.warn('leadership: connection lost, duties stopped', {
        err: err instanceof Error ? err.message : String(err),
        duties: [...this.held],
      });
    }
    for (const name of [...this.held]) {
      this.held.delete(name);
      this.notify(name, false);
    }
    void client.end().catch(() => {});
  }

  private async release(name: string): Promise<void> {
    if (!this.held.delete(name)) return;
    logger.info('leadership released', { duty: name });
    await this.client
      ?.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [LOCK_NAMESPACE, name])
      .catch(() => {});
  }

  private notify(name: string, held: boolean): void {
    for (const l of this.wanted.get(name) ?? []) {
      try {
        l(held);
      } catch (err) {
        logger.error('leadership listener threw', { duty: name, held, err });
      }
    }
  }
}

let current: Leadership | null = null;

/** Start competing for duties in this process. Idempotent. */
export function startLeadership(connectionString: string): Leadership {
  if (!current) {
    current = new Leadership(connectionString);
    current.start();
  }
  return current;
}

/** Whether this process holds `name`. True when leadership was never started. */
export function isLeader(name: DutyName): boolean {
  return current ? current.isLeader(name) : true;
}

/**
 * Run a duty that holds something open (a poll loop, a socket) only while this
 * process holds `name`: `start` on acquiring, its returned stopper on losing.
 * Without leadership it simply starts. Returns a function that stops the duty
 * and stops competing.
 */
export function runWhileLeader(name: DutyName, start: () => () => void): () => Promise<void> {
  let stopDuty: (() => void) | null = null;
  const toggle = (held: boolean): void => {
    if (held && !stopDuty) stopDuty = start();
    else if (!held && stopDuty) {
      const s = stopDuty;
      stopDuty = null;
      s();
    }
  };
  if (!current) {
    toggle(true);
    return async () => toggle(false);
  }
  const unclaim = current.claim(name, toggle);
  return async () => {
    await unclaim();
    toggle(false);
  };
}

/** Compete for `name` with no duty to start (listeners just check `isLeader`). */
export function claimDuty(name: DutyName): () => Promise<void> {
  return current ? current.claim(name) : async () => {};
}

export const __testing = {
  reset(): void {
    current = null;
  },
  set(l: Leadership | null): void {
    current = l;
  },
};
