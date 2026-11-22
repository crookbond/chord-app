/**
 * Deterministic conflict math (ADR 0040). Pure — no DB. These are the cases the
 * old LLM path got wrong (e.g. calling events an hour apart "back-to-back").
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVENT_DURATION_MS,
  effectiveEndMs,
  overlaps,
} from '@/services/conflicts.service.js';

const at = (iso: string) => Date.parse(iso);

describe('overlaps (half-open intervals)', () => {
  it('detects a real overlap', () => {
    expect(overlaps(at('2026-06-03T09:00:00Z'), at('2026-06-03T10:00:00Z'), at('2026-06-03T09:30:00Z'), at('2026-06-03T10:30:00Z'))).toBe(true);
  });

  it('treats back-to-back as NOT overlapping', () => {
    expect(overlaps(at('2026-06-03T09:00:00Z'), at('2026-06-03T10:00:00Z'), at('2026-06-03T10:00:00Z'), at('2026-06-03T11:00:00Z'))).toBe(false);
  });

  it('the regression case: 9:00–9:30 and 10:00–10:30 do not conflict', () => {
    expect(overlaps(at('2026-06-03T09:00:00-04:00'), at('2026-06-03T09:30:00-04:00'), at('2026-06-03T10:00:00-04:00'), at('2026-06-03T10:30:00-04:00'))).toBe(false);
  });

  it('compares correctly across mixed UTC offsets', () => {
    // 13:00Z == 09:00-04:00, so these two are the SAME instant range → overlap.
    expect(overlaps(at('2026-06-03T13:00:00Z'), at('2026-06-03T14:00:00Z'), at('2026-06-03T09:00:00-04:00'), at('2026-06-03T10:00:00-04:00'))).toBe(true);
  });
});

describe('effectiveEndMs (no-end events span 1 hour)', () => {
  it('defaults a missing end to start + 1h', () => {
    expect(DEFAULT_EVENT_DURATION_MS).toBe(60 * 60 * 1000);
    const s = '2026-06-03T09:00:00Z';
    expect(effectiveEndMs(s, null)).toBe(at(s) + DEFAULT_EVENT_DURATION_MS);
  });

  it('uses the explicit end when present and valid', () => {
    expect(effectiveEndMs('2026-06-03T09:00:00Z', '2026-06-03T09:45:00Z')).toBe(at('2026-06-03T09:45:00Z'));
  });

  it('falls back to +1h when the end is not after the start', () => {
    const s = '2026-06-03T09:00:00Z';
    expect(effectiveEndMs(s, s)).toBe(at(s) + DEFAULT_EVENT_DURATION_MS);
  });

  it('two no-end events an hour apart do not overlap (1h blocks, back-to-back)', () => {
    const a = '2026-06-03T09:00:00-04:00'; // → 9:00–10:00
    const b = '2026-06-03T10:00:00-04:00'; // → 10:00–11:00
    expect(overlaps(at(a), effectiveEndMs(a, null), at(b), effectiveEndMs(b, null))).toBe(false);
  });
});
