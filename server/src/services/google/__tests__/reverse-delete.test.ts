/**
 * Reverse-delete reconciliation: a Google-linked event Google no longer returns
 * (on any calendar) was deleted on Google's side and should be dropped from
 * Chord — but only within the fetched window and past the grace period that
 * protects a just-pushed event mid-propagation.
 */
import { describe, expect, it } from 'vitest';

import { shouldReverseDelete } from '@/services/google/calendar.service.js';

const NOW = Date.UTC(2026, 4, 21, 12, 0, 0); // 2026-05-21T12:00:00Z
const win = {
  windowStartMs: NOW - 7 * 86_400_000,
  windowEndMs: NOW + 90 * 86_400_000,
  runStartMs: NOW,
};
const inWindow = new Date(NOW + 86_400_000).toISOString();
const longAgoSynced = new Date(NOW - 86_400_000).toISOString();

function row(over: Partial<Parameters<typeof shouldReverseDelete>[0]> = {}) {
  return {
    external_uid: 'gcal:evt-gone',
    gcal_event_id: null,
    starts_at: inWindow,
    gcal_synced_at: null,
    ...over,
  };
}

describe('shouldReverseDelete', () => {
  it('deletes a Google-origin row Google no longer lists', () => {
    expect(shouldReverseDelete(row(), new Set(['evt-live']), win)).toBe(true);
  });

  it('keeps a row still present on some calendar', () => {
    expect(shouldReverseDelete(row(), new Set(['evt-gone']), win)).toBe(false);
  });

  it('matches a Chord-pushed row by gcal_event_id when external_uid is null', () => {
    const r = { external_uid: null, gcal_event_id: 'evt-pushed', starts_at: inWindow, gcal_synced_at: longAgoSynced };
    expect(shouldReverseDelete(r, new Set<string>(), win)).toBe(true);
    expect(shouldReverseDelete(r, new Set(['evt-pushed']), win)).toBe(false);
  });

  it('resolves the event id from a secondary-calendar external_uid', () => {
    const r = row({ external_uid: 'gcal:fam@group.calendar.google.com:evt-x' });
    expect(shouldReverseDelete(r, new Set(['evt-x']), win)).toBe(false);
    expect(shouldReverseDelete(r, new Set<string>(), win)).toBe(true);
  });

  it('protects a freshly-pushed event inside the grace window', () => {
    const r = row({ gcal_synced_at: new Date(NOW - 30_000).toISOString() }); // 30s ago
    expect(shouldReverseDelete(r, new Set<string>(), win)).toBe(false);
  });

  it('ignores rows outside the fetched window', () => {
    const r = row({ starts_at: new Date(NOW - 365 * 86_400_000).toISOString() });
    expect(shouldReverseDelete(r, new Set<string>(), win)).toBe(false);
  });

  it('never touches rows with no Google linkage', () => {
    const r = { external_uid: null, gcal_event_id: null, starts_at: inWindow, gcal_synced_at: null };
    expect(shouldReverseDelete(r, new Set<string>(), win)).toBe(false);
  });
});
