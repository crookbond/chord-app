import { describe, expect, it } from 'vitest';

import { buildToolDefs, isToolName, normalizeDatetimes, toolSchemas } from '../tools.js';

describe('normalizeDatetimes', () => {
  const norm = (s: string) => normalizeDatetimes(s, '-04:00') as string;

  it('appends the local offset to a bare datetime', () => {
    expect(norm('2026-06-15T14:30:00')).toBe('2026-06-15T14:30:00-04:00');
  });

  it('inserts missing seconds (the flight-screenshot case)', () => {
    expect(norm('2026-06-15T14:30')).toBe('2026-06-15T14:30:00-04:00');
    expect(norm('2026-06-15T14:30-04:00')).toBe('2026-06-15T14:30:00-04:00');
  });

  it('fixes a colonless offset', () => {
    expect(norm('2026-06-15T14:30:00-0400')).toBe('2026-06-15T14:30:00-04:00');
  });

  it('converts a space separator', () => {
    expect(norm('2026-06-15 14:30')).toBe('2026-06-15T14:30:00-04:00');
  });

  it('leaves a date-only value untouched (isoDate fields)', () => {
    expect(norm('2026-06-15')).toBe('2026-06-15');
  });

  it('leaves an already-valid datetime untouched (idempotent)', () => {
    expect(norm('2026-06-15T14:30:00-04:00')).toBe('2026-06-15T14:30:00-04:00');
    expect(norm('2026-06-15T14:30:00Z')).toBe('2026-06-15T14:30:00Z');
  });

  it('produces values that pass the strict add_travel_leg schema', () => {
    const args = normalizeDatetimes(
      { tripId: 't1', mode: 'flight', origin: 'JFK', destination: 'LHR', departAt: '2026-06-15T14:30', arriveAt: '2026-06-16 02:05' },
      '-04:00',
    );
    expect(toolSchemas.add_travel_leg.safeParse(args).success).toBe(true);
  });

  it('walks nested objects and arrays', () => {
    const out = normalizeDatetimes({ legs: [{ departAt: '2026-06-15T14:30' }] }, '-04:00') as {
      legs: { departAt: string }[];
    };
    expect(out.legs[0].departAt).toBe('2026-06-15T14:30:00-04:00');
  });

  describe('with a tz name — the target date decides DST, not the caller-supplied fallback offset', () => {
    // The fallback offset is deliberately wrong (a stale "now" snapshot,
    // e.g. computed in October) for both cases below, to prove it's never
    // consulted once `tz` is supplied.
    const staleOctoberOffset = '-04:00';

    it('a December date (standard time) gets -05:00 even though the fallback offset says -04:00', () => {
      const out = normalizeDatetimes(
        { startsAt: '2026-12-05T13:00:00' },
        staleOctoberOffset,
        'America/New_York',
      ) as { startsAt: string };
      expect(out.startsAt).toBe('2026-12-05T13:00:00-05:00');
    });

    it('a July date (daylight time) gets -04:00 — matches the fallback here, but for the right reason', () => {
      const out = normalizeDatetimes(
        { startsAt: '2026-07-04T13:00:00' },
        staleOctoberOffset,
        'America/New_York',
      ) as { startsAt: string };
      expect(out.startsAt).toBe('2026-07-04T13:00:00-04:00');
    });

    it('two fields on opposite sides of a DST boundary each get their own correct offset', () => {
      const out = normalizeDatetimes(
        { dueAt: '2026-12-05T13:00:00', remindAt: '2026-07-04T09:00:00' },
        staleOctoberOffset,
        'America/New_York',
      ) as { dueAt: string; remindAt: string };
      expect(out.dueAt).toBe('2026-12-05T13:00:00-05:00');
      expect(out.remindAt).toBe('2026-07-04T09:00:00-04:00');
    });

    it('falls back to the flat offset when tz is omitted or null (unchanged legacy behavior)', () => {
      expect(
        (normalizeDatetimes({ startsAt: '2026-12-05T13:00:00' }, staleOctoberOffset) as { startsAt: string })
          .startsAt,
      ).toBe('2026-12-05T13:00:00-04:00');
      expect(
        (
          normalizeDatetimes({ startsAt: '2026-12-05T13:00:00' }, staleOctoberOffset, null) as {
            startsAt: string;
          }
        ).startsAt,
      ).toBe('2026-12-05T13:00:00-04:00');
    });
  });
});

describe('tool registry', () => {
  it('isToolName narrows to the registry keys', () => {
    expect(isToolName('create_task')).toBe(true);
    expect(isToolName('list_tasks')).toBe(true);
    expect(isToolName('search_saves')).toBe(true);
    expect(isToolName('get_event_status')).toBe(true);
    expect(isToolName('nonsense_tool')).toBe(false);
  });

  it('buildToolDefs covers every entry in toolSchemas with a JSON Schema', () => {
    const defs = buildToolDefs();
    const names = new Set(defs.map((d) => d.name));
    for (const key of Object.keys(toolSchemas)) {
      expect(names.has(key)).toBe(true);
    }
    for (const d of defs) {
      expect(typeof d.parameters).toBe('object');
      expect(d.description).toBeTruthy();
    }
  });
});

describe('read-side tool schemas', () => {
  it('list_tasks accepts a valid status filter', () => {
    const p = toolSchemas.list_tasks.safeParse({ status: 'done', limit: 5 });
    expect(p.success).toBe(true);
  });

  it('list_tasks rejects an unknown status', () => {
    const p = toolSchemas.list_tasks.safeParse({ status: 'completed' });
    expect(p.success).toBe(false);
  });

  it('search_saves accepts empty args (no filter)', () => {
    expect(toolSchemas.search_saves.safeParse({}).success).toBe(true);
  });

  it('lookup_contact requires a name', () => {
    expect(toolSchemas.lookup_contact.safeParse({}).success).toBe(false);
    expect(toolSchemas.lookup_contact.safeParse({ name: 'John' }).success).toBe(true);
  });

  it('get_event_status accepts an optional eventId', () => {
    expect(toolSchemas.get_event_status.safeParse({}).success).toBe(true);
    expect(toolSchemas.get_event_status.safeParse({ eventId: 'e_123' }).success).toBe(true);
  });
});
