/**
 * Decision table for `decideRuntimeState`. Lives in its own file so the
 * mapping from (lastSuccessAt, lastErrorAt) → UI pill is easy to find
 * and change in one place.
 */
import { describe, expect, it } from 'vitest';

import {
  RECENT_ERROR_WINDOW_MS,
  decideRuntimeState,
} from '@/services/connectors/types.js';

const NOW = Date.parse('2026-05-08T12:00:00Z');
const recent = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const old = recent(RECENT_ERROR_WINDOW_MS + 60_000); // 11 min ago

describe('decideRuntimeState', () => {
  it('starting when no events recorded yet', () => {
    expect(decideRuntimeState(null, null, NOW)).toBe('starting');
  });

  it('ok when only successes (recent)', () => {
    expect(decideRuntimeState(recent(30_000), null, NOW)).toBe('ok');
  });

  it('ok when error is old and success is newer', () => {
    expect(decideRuntimeState(recent(60_000), old, NOW)).toBe('ok');
  });

  it('error when error is recent and there is no recent success', () => {
    // Most recent thing is a failure; nothing succeeded in the window.
    expect(decideRuntimeState(null, recent(60_000), NOW)).toBe('error');
    expect(decideRuntimeState(old, recent(60_000), NOW)).toBe('error');
  });

  it('warn (1) when recent error AND a recent success — recovered', () => {
    expect(decideRuntimeState(recent(10_000), recent(120_000), NOW)).toBe('warn');
    // Even if the success was older than the error within the window.
    expect(decideRuntimeState(recent(120_000), recent(60_000), NOW)).toBe('warn');
  });

  it('warn (2) when no recent activity AND last call was an error', () => {
    // Both timestamps stale but error came after success → idle bot whose
    // most recent attempt failed (typical of a stalled outbound send).
    expect(decideRuntimeState(recent(20 * 60_000), recent(15 * 60_000), NOW)).toBe('warn');
    // Stale error, never a success → also warn (only failures, all stale).
    expect(decideRuntimeState(null, old, NOW)).toBe('warn');
  });

  it('ok when no recent activity but last call was success', () => {
    expect(decideRuntimeState(recent(15 * 60_000), recent(20 * 60_000), NOW)).toBe('ok');
  });
});
