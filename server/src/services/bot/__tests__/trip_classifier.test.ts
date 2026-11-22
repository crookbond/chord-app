/**
 * The trip classifier's prompt must anchor year-less dates against a real
 * "today" (see `classifyTravelDocument`'s doc comment) — a ticket almost
 * never prints a year, and with no anchor the model's own guess can land
 * in the past, which `stageFlight`/`stageHotel`'s "nothing past ever
 * surfaces" rule (ADR 0158 §4) then silently discards. A prod itinerary
 * with a fully legible route/date/passenger produced no trip at all
 * because of exactly this: no "Today" line in the prompt the classifier
 * ever saw.
 */
import { describe, expect, it } from 'vitest';

import { __testing, toLocalDatetime, zonedDatetime } from '@/services/bot/trip_classifier.js';

const { buildTextPrompt, CLASSIFY_SYSTEM } = __testing;

describe('trip classifier prompt carries a "today" anchor', () => {
  it('includes the literal Today line in the user message', () => {
    const messages = buildTextPrompt('email', 'Some itinerary body text here.', '2026-09-10');
    const user = messages.find((m) => m.role === 'user');
    expect(String(user?.content)).toContain('Today: 2026-09-10');
  });

  it('instructs the model to resolve a year-less date against Today, not guess blind', () => {
    // Pinned on content, not exact wording, so a rephrase doesn't need this
    // test rewritten — but the RULE (resolve against Today; a passed
    // month-day rolls to next year) must stay present.
    expect(CLASSIFY_SYSTEM).toMatch(/no year/i);
    expect(CLASSIFY_SYSTEM).toMatch(/Today/);
    expect(CLASSIFY_SYSTEM).toMatch(/next year/i);
  });
});

describe('trip classifier recognizes a booking cancellation (ADR 0168)', () => {
  it('distinguishes cancellation from a fresh hotel/flight confirmation', () => {
    // A cancellation email restates the same property/dates a confirmation
    // does — the schema must exist as its own kind, or the model has no way
    // to say "this is off" instead of "here is a new booking."
    expect(CLASSIFY_SYSTEM).toMatch(/cancellation/i);
    expect(CLASSIFY_SYSTEM).toMatch(/cancelled|refund/i);
    expect(CLASSIFY_SYSTEM).toMatch(/NOT\s+the same as a fresh confirmation/i);
  });

  it('lists cancellation as one of the eight output shapes, with a cancelsKind discriminator', () => {
    expect(CLASSIFY_SYSTEM).toContain('"kind":"cancellation"');
    expect(CLASSIFY_SYSTEM).toContain('"cancelsKind"');
  });
});

describe('toLocalDatetime / zonedDatetime resolve the DOCUMENT date, not "today"', () => {
  // A stale fallback (as if computed in October, US daylight time) used on
  // purpose in every case below, to prove it's ignored once a zone name is
  // available — mirrors the bot/tools.ts normalizeDatetimes fix.
  const staleOctoberMinutes = -240; // -04:00

  it('toLocalDatetime: a December ticket time gets -05:00 even though the fallback minutes say -04:00', () => {
    expect(toLocalDatetime('2026-12-05T13:00:00', staleOctoberMinutes, 'America/New_York')).toBe(
      '2026-12-05T13:00:00-05:00',
    );
  });

  it('toLocalDatetime: a July date correctly gets -04:00 too, for the right reason', () => {
    expect(toLocalDatetime('2026-07-04T13:00:00', staleOctoberMinutes, 'America/New_York')).toBe(
      '2026-07-04T13:00:00-04:00',
    );
  });

  it('toLocalDatetime: falls back to the flat minutes when no zone is known (e.g. a raw browser offset)', () => {
    expect(toLocalDatetime('2026-12-05T13:00:00', staleOctoberMinutes)).toBe('2026-12-05T13:00:00-04:00');
    expect(toLocalDatetime('2026-12-05T13:00:00', staleOctoberMinutes, null)).toBe(
      '2026-12-05T13:00:00-04:00',
    );
  });

  it('toLocalDatetime: a date-only value resolves midnight against the target date, not the fallback', () => {
    expect(toLocalDatetime('2026-12-05', staleOctoberMinutes, 'America/New_York')).toBe(
      '2026-12-05T00:00:00-05:00',
    );
  });

  it("zonedDatetime: the airport's own zone wins outright (unaffected by any fallback)", () => {
    expect(zonedDatetime('2026-12-05T13:00:00', 'America/New_York', staleOctoberMinutes)).toBe(
      '2026-12-05T13:00:00-05:00',
    );
  });

  it('zonedDatetime: falls through to the fallback ZONE (not just minutes) when the ticket has no airport zone', () => {
    // No departZone at all — this is the restaurant/movie/no-zone-extracted
    // shape, and the fallback TZ (the traveller's own) must still resolve
    // the target date's own DST side rather than a stale "now" snapshot.
    expect(zonedDatetime('2026-12-05T13:00:00', undefined, staleOctoberMinutes, 'America/New_York')).toBe(
      '2026-12-05T13:00:00-05:00',
    );
  });

  it('zonedDatetime: falls through to the fallback zone when the named airport zone is invalid', () => {
    expect(
      zonedDatetime('2026-12-05T13:00:00', 'Not/AZone', staleOctoberMinutes, 'America/New_York'),
    ).toBe('2026-12-05T13:00:00-05:00');
  });

  it('zonedDatetime: an already-offset-bearing ticket time is trusted as-is, no re-derivation', () => {
    expect(
      zonedDatetime('2026-12-05T13:00:00-08:00', 'America/New_York', staleOctoberMinutes, 'America/New_York'),
    ).toBe('2026-12-05T13:00:00-08:00');
  });
});
