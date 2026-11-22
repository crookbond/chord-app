/**
 * ADR 0311 - one answer to "can we reach the server?", shared by every
 * request, stream and screen.
 *
 * Without it each screen found out on its own: every focus, foreground return
 * and pull fired a request that failed, and every live stream re-polled every
 * few seconds, forever. Now a request that never left the device asks for one
 * check of the server; if that fails too the app is offline, requests fail at
 * once without touching the network, streams park, and a single check runs on
 * a widening timer (and on every return to the foreground) until the server
 * answers again.
 *
 * Decided by what requests actually do, not by an OS network library: none is
 * in the shipped native builds, and "the phone has Wi-Fi" is not "Chord's
 * server answers" anyway.
 */
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { offlineProbeDelay } from '@chord/kernel';

export class OfflineError extends Error {
  constructor(message = "You're offline. Chord will catch up when the network is back.") {
    super(message);
    this.name = 'OfflineError';
  }
}

/**
 * A request ran out of time while the server still answers its health check:
 * the network is fine, the server (or a mailbox behind it) is slow. Handled
 * everywhere as OfflineError is - a saved copy is used, a queued send waits -
 * but it says what is true, and no offline bar is shown for it.
 */
export class SlowServerError extends OfflineError {
  constructor() {
    super('This is taking longer than usual. Try again in a moment.');
    this.name = 'SlowServerError';
  }
}

/** A screen's load failed: the text to show, or null when the offline bar already says it. */
export function loadErrorText(e: unknown): string | null {
  if (e instanceof SlowServerError) return e.message;
  return e instanceof OfflineError ? null : (e as Error).message;
}

let online = true;
const listeners = new Set<(online: boolean) => void>();
let probe: (() => Promise<boolean>) | null = null;
let probing: Promise<boolean> | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isOnline(): boolean {
  return online;
}

/** `api.ts` supplies the check (it owns the server address); kept out of here to avoid an import cycle. */
export function setConnectionProbe(fn: () => Promise<boolean>): void {
  probe = fn;
}

export function onNetworkChange(fn: (online: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(onNetworkChange, isOnline, isOnline);
}

function setOnline(next: boolean): void {
  if (online === next) return;
  online = next;
  attempt = 0;
  clearTimer();
  if (!next) scheduleCheck();
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* one listener must not stop the rest */
    }
  }
}

/** Any answer from the server, error statuses included, means it is reachable. */
export function noteServerAnswered(): void {
  setOnline(true);
}

/**
 * A request never reached the server. One failure is not proof (a lift, a
 * tunnel, a Wi-Fi handover), so check once; only a failed check goes offline.
 */
export function noteNetworkFailure(): void {
  if (online) void checkConnection();
}

/** Check the server now. Concurrent callers share one check. */
export function checkConnection(): Promise<boolean> {
  if (!probe) return Promise.resolve(online);
  probing ??= probe()
    .catch(() => false)
    .then((ok) => {
      setOnline(ok);
      return ok;
    })
    .finally(() => {
      probing = null;
    });
  return probing;
}

function inFront(): boolean {
  if (Platform.OS === 'web') {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }
  return AppState.currentState === 'active';
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** While offline and in front: one check after 5s, doubling to a minute. */
function scheduleCheck(): void {
  if (online || timer || !inFront()) return;
  timer = setTimeout(() => {
    timer = null;
    attempt += 1;
    void checkConnection().then((ok) => {
      if (!ok) scheduleCheck();
    });
  }, offlineProbeDelay(attempt));
}

function onFront(): void {
  if (online) return;
  clearTimer();
  // Coming back to the app is when someone is looking: check now, not on the timer.
  void checkConnection().then((ok) => {
    if (!ok) scheduleCheck();
  });
}

function onBack(): void {
  clearTimer();
}

if (Platform.OS === 'web') {
  if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => setOnline(false));
    window.addEventListener('online', onFront);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onBack();
      else onFront();
    });
  }
} else {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') onFront();
    else if (state === 'background') onBack();
  });
}
