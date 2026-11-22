import { describe, expect, it } from 'vitest';

import {
  CONTEXT_BLOCK_CHARS,
  CONTEXT_EVENT_CAP,
  CONTEXT_NAME_CHARS,
  CONTEXT_TASK_CAP,
  CONTEXT_TRIP_CAP,
  formatLabelledWorld,
  openSlotsFrom,
  sortTasks,
  windowEvents,
  type MagicsWorldContext,
} from '@/services/email/magics-context.js';

const formatWorldContext = (ctx: MagicsWorldContext, tz: string | null): string | null =>
  formatLabelledWorld(ctx, tz).block;

describe('formatWorldContext', () => {
  it('returns null when the world is empty', () => {
    expect(formatWorldContext({ events: [], tasks: [], trips: [], openSlots: [] }, 'UTC')).toBeNull();
  });

  it('renders names and dates only, never ids', () => {
    const ctx: MagicsWorldContext = {
      events: [{ title: 'October half marathon', at: '2026-10-12T14:00:00.000Z' }],
      tasks: [{ title: 'Pack permission slip', dueAt: '2026-09-01T12:00:00.000Z' }],
      trips: [{ name: 'Boston', destination: 'Logan', startDate: '2026-10-10', endDate: '2026-10-13' }],
      openSlots: [],
    };
    const block = formatWorldContext(ctx, 'UTC');
    expect(block).toContain('October half marathon');
    expect(block).toContain('Pack permission slip');
    expect(block).toContain('Boston');
    expect(block).toContain('Logan');
    expect(block).not.toMatch(/\bg[_-]/);
    expect(block).not.toContain('group');
  });

  it('clips a long name but keeps its date', () => {
    const block = formatWorldContext(
      {
        events: [{ title: 'R'.repeat(500), at: '2026-10-12T14:00:00.000Z' }],
        tasks: [],
        trips: [],
        openSlots: [],
      },
      'UTC',
    );
    const line = block!.split('\n')[1]!;
    expect(line.length).toBeLessThan(CONTEXT_NAME_CHARS + 40);
    expect(line).toContain('2026-10-12');
  });

  it('ceilings the block when every row is pathological', () => {
    const long = (p: string) => p.repeat(400);
    const block = formatWorldContext(
      {
        events: Array.from({ length: CONTEXT_EVENT_CAP }, (_, i) => ({
          title: long(`e${i}`),
          at: '2026-10-12T14:00:00.000Z',
        })),
        tasks: Array.from({ length: CONTEXT_TASK_CAP }, (_, i) => ({
          title: long(`t${i}`),
          dueAt: '2026-09-01T12:00:00.000Z',
        })),
        trips: Array.from({ length: CONTEXT_TRIP_CAP }, (_, i) => ({
          name: long(`n${i}`),
          destination: long(`d${i}`),
          startDate: '2026-10-10',
          endDate: '2026-10-13',
        })),
      openSlots: [],
      },
      'UTC',
    );
    expect(block!.length).toBeLessThanOrEqual(CONTEXT_BLOCK_CHARS);
    // The soonest calendar rows are what suppress twins, so they must survive.
    expect(block).toContain('calendar:');
  });

  it('keeps a full ordinary world intact', () => {
    const block = formatWorldContext(
      {
        events: Array.from({ length: CONTEXT_EVENT_CAP }, (_, i) => ({
          title: `Soccer practice ${i}`,
          at: '2026-10-12T14:00:00.000Z',
        })),
        tasks: Array.from({ length: CONTEXT_TASK_CAP }, (_, i) => ({
          title: `Pack permission slip ${i}`,
          dueAt: '2026-09-01T12:00:00.000Z',
        })),
        trips: Array.from({ length: CONTEXT_TRIP_CAP }, (_, i) => ({
          name: `Boston ${i}`,
          destination: 'Logan',
          startDate: '2026-10-10',
          endDate: '2026-10-13',
        })),
      openSlots: [],
      },
      'UTC',
    );
    const rows = block!.split('\n').length - 1;
    expect(rows).toBe(CONTEXT_EVENT_CAP + CONTEXT_TASK_CAP + CONTEXT_TRIP_CAP);
  });
});

describe('windowEvents', () => {
  const from = Date.parse('2026-08-17T05:00:00.000Z');
  const until = Date.parse('2026-10-16T12:00:00.000Z');

  it('windows by real instant, not by ISO string', () => {
    const kept = windowEvents(
      [
        // 11:00Z — inside the window, but lexically "04" < the "05" bound.
        { title: 'Today, offset', at: '2026-08-17T04:00:00-07:00' },
        // 16:00Z — outside, but lexically "09" < the "12" bound.
        { title: 'Past the end', at: '2026-10-16T09:00:00-07:00' },
        { title: 'Long gone', at: '2026-01-01T10:00:00Z' },
      ],
      from,
      until,
    );
    expect(kept.map((e) => e.title)).toEqual(['Today, offset']);
  });

  it('caps the soonest by instant, so the lexical order cannot pick the set', () => {
    const kept = windowEvents(
      [
        { title: 'Later', at: '2026-08-18T15:00:00-07:00' },
        { title: 'Sooner', at: '2026-08-18T16:00:00Z' },
      ],
      from,
      until,
      1,
    );
    expect(kept.map((e) => e.title)).toEqual(['Sooner']);
  });
});

describe('sortTasks', () => {
  it('orders by due instant and puts undated last', () => {
    const out = sortTasks([
      { title: 'Undated', dueAt: null },
      { title: 'Later', dueAt: '2026-09-02T15:00:00-07:00' },
      { title: 'Sooner', dueAt: '2026-09-02T16:00:00Z' },
    ]);
    expect(out.map((t) => t.title)).toEqual(['Sooner', 'Later', 'Undated']);
  });
});

describe('openSlotsFrom', () => {
  // Fri 2026-09-04, 08:00 UTC. tz=UTC keeps the arithmetic readable; the zone
  // handling itself is zonedDayStartUtc's own test.
  const now = Date.parse('2026-09-04T08:00:00.000Z');
  const at = (iso: string) => Date.parse(iso);
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(0, 16);

  it('offers the first long-enough gap per day, one per day', () => {
    const slots = openSlotsFrom([], { nowMs: now, tz: 'UTC', days: 3, cap: 5 });
    // Day 0 is inside the lead time, so the first offer is tomorrow at 09:00.
    expect(slots.map((s) => hhmm(s.startMs))).toEqual([
      '2026-09-05T09:00',
      '2026-09-06T09:00',
    ]);
  });

  it('skips past a booked morning to the first real opening', () => {
    const busy = [
      { startMs: at('2026-09-05T09:00:00Z'), endMs: at('2026-09-05T11:30:00Z') },
      // Too small to fit an hour after the first block ends.
      { startMs: at('2026-09-05T12:00:00Z'), endMs: at('2026-09-05T13:00:00Z') },
    ];
    const slots = openSlotsFrom(busy, { nowMs: now, tz: 'UTC', days: 2, cap: 1 });
    expect(hhmm(slots[0].startMs)).toBe('2026-09-05T13:00');
  });

  it('offers nothing on a fully booked day', () => {
    const busy = [{ startMs: at('2026-09-05T08:00:00Z'), endMs: at('2026-09-05T19:00:00Z') }];
    const slots = openSlotsFrom(busy, { nowMs: now, tz: 'UTC', days: 1, cap: 5 });
    expect(slots).toEqual([]);
  });

  it('never offers a time inside the lead window', () => {
    const slots = openSlotsFrom([], { nowMs: now, tz: 'UTC', days: 12, cap: 5 });
    for (const s of slots) expect(s.startMs).toBeGreaterThanOrEqual(now + 24 * 3600000);
  });

  it('never runs a slot past the end of the bookable day', () => {
    const busy = [{ startMs: at('2026-09-05T09:00:00Z'), endMs: at('2026-09-05T17:30:00Z') }];
    const slots = openSlotsFrom(busy, { nowMs: now, tz: 'UTC', days: 1, cap: 5 });
    expect(slots).toEqual([]); // only 30 min left before 18:00
  });
});

describe('formatWorldContext — availability', () => {
  const slot = { startMs: Date.parse('2026-09-05T14:00:00.000Z'), endMs: Date.parse('2026-09-05T15:00:00.000Z') };

  it('appends free times when there are any', () => {
    const block = formatWorldContext(
      { events: [], tasks: [], trips: [], openSlots: [slot] },
      'UTC',
    );
    expect(block).toContain('FREE');
    expect(block).toContain('2026-09-05 14:00');
  });

  it('says nothing at all when availability is empty or unknown', () => {
    expect(formatWorldContext({ events: [], tasks: [], trips: [], openSlots: [] }, 'UTC')).toBeNull();
  });
});
