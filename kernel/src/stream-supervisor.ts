/**
 * Keeps one live stream (SSE) open for as long as a screen wants it (ADR 0082,
 * ADR 0311). The app parks it while backgrounded or offline and resumes it on
 * return; this also brings it back when the SERVER ends it. Every deploy ends
 * every stream with `stream.end` reason `shutdown`, and a browser EventSource
 * gives up for good on a non-200 answer (a 502 while the server restarts):
 * neither is the end of the screen's interest. Only a reason that says the
 * stream will never be allowed again (signed out, not a member, the group is
 * gone) stops it. Pure so it can be tested; `mobile/` has no harness.
 */
import type { StreamEndReason } from './sse';

/** Why the connection is gone: the server's `stream.end` reason, or `closed` when it just stopped. */
export type StreamTransportEnd = StreamEndReason | 'closed';

/** What an opener reports about the connection it made. */
export interface StreamTransportHooks {
  opened(): void;
  ended(reason: StreamTransportEnd): void;
}

export interface ClosableStream {
  close(): void;
}

export const STREAM_REOPEN_BASE_MS = 2_000;
export const STREAM_REOPEN_MAX_MS = 60_000;
/** A connection that lived this long was working; its end starts the backoff over. */
export const STREAM_STABLE_MS = 10_000;

/** Ends after which reopening can only be refused again. */
export function streamEndIsFinal(reason: StreamTransportEnd): boolean {
  return reason === 'unauthorized' || reason === 'forbidden' || reason === 'group_deleted';
}

/**
 * How long to wait before reopening: 2s doubling to a minute, spread over
 * half to one and a half times that, so a deploy's thousands of clients do not
 * all come back in the same second.
 */
export function streamReopenDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  const base = Math.min(STREAM_REOPEN_BASE_MS * 2 ** Math.min(n, 10), STREAM_REOPEN_MAX_MS);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(base * (0.5 + r));
}

export interface StreamSupervisorDeps<H extends ClosableStream> {
  open: (hooks: StreamTransportHooks) => Promise<H>;
  /** In front and the server reachable. */
  allowed: () => boolean;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (token: unknown) => void;
  now?: () => number;
  random?: () => number;
}

export class StreamSupervisor<H extends ClosableStream> {
  private handle: H | null = null;
  private closed = false;
  /** The server said this stream will not be allowed again. */
  private finished = false;
  /** Bumped by every open, park and end: a hook or open from an older connection is ignored. */
  private gen = 0;
  private attempt = 0;
  private openedAt = 0;
  private timer: unknown = null;

  constructor(private readonly deps: StreamSupervisorDeps<H>) {}

  get isOpen(): boolean {
    return this.handle !== null;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get reopenPending(): boolean {
    return this.timer !== null;
  }

  /** The first open. Its failure reaches the caller; later ones retry on their own. */
  async start(): Promise<void> {
    if (!this.deps.allowed()) return;
    const { h, gen } = await this.openOnce();
    this.adopt(h, gen);
  }

  /** Back in front / back online, or the reopen timer fired. */
  async resume(): Promise<void> {
    if (this.closed || this.finished || this.handle || !this.deps.allowed()) return;
    this.cancelTimer();
    try {
      const { h, gen } = await this.openOnce();
      this.adopt(h, gen);
    } catch {
      this.scheduleReopen();
    }
  }

  /** Backgrounded or offline: close the connection, keep the interest. */
  park(): void {
    this.cancelTimer();
    this.gen++;
    this.handle?.close();
    this.handle = null;
  }

  /** The screen is done with it. */
  close(): void {
    this.closed = true;
    this.park();
  }

  private async openOnce(): Promise<{ h: H; gen: number }> {
    const gen = ++this.gen;
    const h = await this.deps.open({
      opened: () => {
        if (gen === this.gen) this.openedAt = this.now();
      },
      ended: (reason) => {
        if (gen !== this.gen) return;
        this.onEnded(reason);
      },
    });
    return { h, gen };
  }

  private adopt(h: H, gen: number): void {
    if (gen !== this.gen || this.closed || this.handle || !this.deps.allowed()) {
      h.close();
      return;
    }
    this.handle = h;
  }

  private onEnded(reason: StreamTransportEnd): void {
    // The opener closed its own connection; anything still in flight from it is stale.
    this.gen++;
    this.handle = null;
    if (this.openedAt > 0 && this.now() - this.openedAt >= STREAM_STABLE_MS) this.attempt = 0;
    this.openedAt = 0;
    if (this.closed) return;
    if (streamEndIsFinal(reason)) {
      this.finished = true;
      return;
    }
    this.scheduleReopen();
  }

  private scheduleReopen(): void {
    if (this.timer !== null || this.closed || this.finished) return;
    const delay = streamReopenDelay(this.attempt++, this.deps.random);
    this.timer = this.deps.schedule(() => {
      this.timer = null;
      void this.resume();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.deps.cancel(this.timer);
    this.timer = null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
