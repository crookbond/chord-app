/**
 * PR-B.1 — pure layout helpers shared between mobile UI and tests.
 * Lives in the server vitest suite (mobile has no test runner) but
 * exercises the kernel-level pure code that the UI imports.
 */
import { describe, expect, it } from 'vitest';

import {
  assignLanes,
  clipBlockToDay,
  layoutDayBlocks,
  legsForDay,
  type TripStatus,
} from '@chord/kernel';

const HH = 48;

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

describe('clipBlockToDay', () => {
  it('places a 9-10am block at the right top + height', () => {
    const r = clipBlockToDay(at(2026, 6, 12, 9, 0), at(2026, 6, 12, 10, 0), day(2026, 6, 12), HH);
    expect(r.top).toBe(9 * HH);
    expect(r.height).toBe(HH - 2);
  });

  it('clips a block that starts before the day to top=0', () => {
    const r = clipBlockToDay(at(2026, 6, 11, 22, 0), at(2026, 6, 12, 6, 30), day(2026, 6, 12), HH);
    expect(r.top).toBe(0);
    // Visible portion = 0:00–6:30 = 6.5h.
    expect(r.height).toBeCloseTo(6.5 * HH - 2);
  });

  it('clips a block that ends after midnight to the day end', () => {
    const r = clipBlockToDay(at(2026, 6, 12, 22, 0), at(2026, 6, 13, 3, 0), day(2026, 6, 12), HH);
    expect(r.top).toBe(22 * HH);
    // Visible portion = 22:00–24:00 = 2h.
    expect(r.height).toBeCloseTo(2 * HH - 2);
  });

  it('enforces a minimum height for zero-duration intervals', () => {
    const t = at(2026, 6, 12, 14, 0);
    const r = clipBlockToDay(t, t, day(2026, 6, 12), HH);
    expect(r.height).toBe(14);
  });

  it('returns minHeight when interval is fully outside the day', () => {
    // Block on the previous day; current day shows a tiny clipped sliver
    // at most. We expect both top and height to remain non-negative.
    const r = clipBlockToDay(at(2026, 6, 11, 9, 0), at(2026, 6, 11, 10, 0), day(2026, 6, 12), HH);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.height).toBeGreaterThanOrEqual(14);
  });
});

const tripWith = (...legs: TripStatus['legs']): TripStatus => ({
  trip: {
    id: 't1',
    groupId: 'g1',
    name: 'X',
    destination: 'Y',
    startDate: '2026-06-10',
    endDate: '2026-06-15',
    participants: [],
    createdBy: null,
    createdAt: '2026-06-01T00:00:00Z',
  },
  legs,
  accommodations: [],
  reservations: [],
  participantNames: [],
  narrative: '',
  gaps: [],
  legGaps: [],
});

describe('legsForDay', () => {
  it('returns legs whose departure falls within the day', () => {
    const trip = tripWith({
      id: 'l1',
      tripId: 't1',
      personaId: null,
      mode: 'flight',
      origin: 'SEA',
      destination: 'JFK',
      departAt: '2026-06-12T09:00:00-04:00',
      arriveAt: '2026-06-12T17:00:00-04:00',
      createdAt: '2026-06-01T00:00:00Z',
    });
    expect(legsForDay([trip], day(2026, 6, 12))).toHaveLength(1);
    expect(legsForDay([trip], day(2026, 6, 13))).toHaveLength(0);
  });

  it('matches a red-eye on both calendar days it spans', () => {
    const trip = tripWith({
      id: 'l1',
      tripId: 't1',
      personaId: null,
      mode: 'flight',
      origin: 'SEA',
      destination: 'JFK',
      // Local-time red-eye (uses local Date constructors so test is TZ-stable).
      departAt: at(2026, 6, 12, 23, 0).toISOString(),
      arriveAt: at(2026, 6, 13, 5, 0).toISOString(),
      createdAt: '2026-06-01T00:00:00Z',
    });
    expect(legsForDay([trip], day(2026, 6, 12))).toHaveLength(1);
    expect(legsForDay([trip], day(2026, 6, 13))).toHaveLength(1);
    expect(legsForDay([trip], day(2026, 6, 14))).toHaveLength(0);
  });

  it('skips legs whose timestamps are unparseable', () => {
    const trip = tripWith({
      id: 'l1',
      tripId: 't1',
      personaId: null,
      mode: 'flight',
      origin: 'A',
      destination: 'B',
      departAt: 'not-a-date',
      arriveAt: 'not-a-date-either',
      createdAt: '2026-06-01T00:00:00Z',
    });
    expect(legsForDay([trip], day(2026, 6, 12))).toHaveLength(0);
  });

  it('aggregates legs across multiple trips', () => {
    const t1 = tripWith({
      id: 'l1',
      tripId: 't1',
      personaId: null,
      mode: 'flight',
      origin: 'SEA',
      destination: 'JFK',
      departAt: at(2026, 6, 12, 9, 0).toISOString(),
      arriveAt: at(2026, 6, 12, 17, 0).toISOString(),
      createdAt: '2026-06-01T00:00:00Z',
    });
    const t2 = tripWith({
      id: 'l2',
      tripId: 't1',
      personaId: null,
      mode: 'train',
      origin: 'NYC',
      destination: 'BOS',
      departAt: at(2026, 6, 12, 19, 0).toISOString(),
      arriveAt: at(2026, 6, 12, 23, 0).toISOString(),
      createdAt: '2026-06-01T00:00:00Z',
    });
    expect(legsForDay([t1, t2], day(2026, 6, 12))).toHaveLength(2);
  });
});

// The calendar stretches a short block to SHORT_BLOCK_PX (22px at 48px/hour),
// so overlap has to be judged on that drawn extent.
const MIN_VISIBLE_MS = (22 / 48) * 60 * 60 * 1000;

describe('assignLanes', () => {
  it('splits two zero-length events at the same time instead of stacking them', () => {
    // Prod: a school sports calendar's "Soccer - Varsity Game: Trinity" pair at
    // 4:00 PM, both with DTEND = DTSTART, drawn full-width on top of each other.
    const lanes = assignLanes(
      [
        { id: 'away', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T20:00:00.000Z' },
        { id: 'home', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T20:00:00.000Z' },
      ],
      MIN_VISIBLE_MS,
    );
    expect(lanes.get('away')).toMatchObject({ lane: 0, lanes: 2 });
    expect(lanes.get('home')).toMatchObject({ lane: 1, lanes: 2 });
  });

  it("treats a block starting inside a short neighbour's drawn height as overlapping", () => {
    const lanes = assignLanes(
      [
        { id: 'a', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T20:05:00.000Z' },
        { id: 'b', startsAt: '2026-09-25T20:15:00.000Z', endsAt: '2026-09-25T21:00:00.000Z' },
      ],
      MIN_VISIBLE_MS,
    );
    expect(lanes.get('a')?.lanes).toBe(2);
    expect(lanes.get('b')?.lane).toBe(1);
  });

  it('keeps back-to-back events that do not overlap as drawn in one lane', () => {
    const lanes = assignLanes(
      [
        { id: 'a', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T21:00:00.000Z' },
        { id: 'b', startsAt: '2026-09-25T21:00:00.000Z', endsAt: '2026-09-25T22:00:00.000Z' },
      ],
      MIN_VISIBLE_MS,
    );
    expect(lanes.get('a')).toMatchObject({ lane: 0, lanes: 1 });
    expect(lanes.get('b')).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('reuses a lane only once its previous block is past its drawn height', () => {
    const lanes = assignLanes(
      [
        { id: 'long', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T22:00:00.000Z' },
        { id: 'blip', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T20:00:00.000Z' },
        { id: 'next', startsAt: '2026-09-25T20:10:00.000Z', endsAt: '2026-09-25T20:40:00.000Z' },
      ],
      MIN_VISIBLE_MS,
    );
    expect(lanes.get('next')?.lane).toBe(2);
    expect(lanes.get('next')?.lanes).toBe(3);
  });

  it('tags each overlap group so a narrow view can collapse it as one', () => {
    const lanes = assignLanes(
      [
        { id: 'away', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T20:00:00.000Z' },
        { id: 'home', startsAt: '2026-09-25T20:00:00.000Z', endsAt: '2026-09-25T20:00:00.000Z' },
        { id: 'later', startsAt: '2026-09-25T23:00:00.000Z', endsAt: '2026-09-26T00:00:00.000Z' },
      ],
      MIN_VISIBLE_MS,
    );
    expect(lanes.get('away')?.cluster).toBe(lanes.get('home')?.cluster);
    expect(lanes.get('later')?.cluster).not.toBe(lanes.get('away')?.cluster);
  });
});

describe('layoutDayBlocks', () => {
  // Prod, Fri Oct 23 2026 (New York): the afternoon that drew as "+N" blocks
  // and half-width slivers.
  const day = [
    { id: 'cvs', startsAt: '2026-10-23T13:30:00-04:00', endsAt: '2026-10-23T14:30:00-04:00' },
    { id: 'squash45', startsAt: '2026-10-23T13:45:00-04:00', endsAt: '2026-10-23T14:30:00-04:00' },
    { id: 'ortho', startsAt: '2026-10-23T15:30:00-04:00', endsAt: '2026-10-23T16:30:00-04:00' },
    { id: 'hillcrest', startsAt: '2026-10-23T16:00:00-04:00', endsAt: '2026-10-23T18:00:00-04:00' },
    { id: 'trivia', startsAt: '2026-10-23T16:00:00-04:00', endsAt: '2026-10-23T17:00:00-04:00' },
    { id: 'amtrak', startsAt: '2026-10-23T17:15:00-04:00', endsAt: '2026-10-23T20:35:00-04:00' },
    { id: 'nolan', startsAt: '2026-10-23T17:30:00-04:00', endsAt: '2026-10-23T18:15:00-04:00' },
  ];
  const layout = layoutDayBlocks(day, { width: 300, minVisibleMs: MIN_VISIBLE_MS, indent: 10 });

  it('puts events that start together side by side', () => {
    expect(layout.get('cvs')).toEqual({ left: 0, width: 150, z: 0 });
    expect(layout.get('squash45')).toEqual({ left: 150, width: 150, z: 0 });
    expect(layout.get('ortho')).toMatchObject({ left: 0, width: 100, z: 0 });
    expect(layout.get('hillcrest')).toMatchObject({ left: 100, width: 100, z: 0 });
    expect(layout.get('trivia')).toMatchObject({ left: 200, width: 100, z: 0 });
  });

  it('draws a much later event over the one it overlaps instead of narrowing everything', () => {
    // Amtrak starts 75 minutes into Hillcrest: indented over it, sharing the
    // rest of the column with the squash that starts 15 minutes later.
    expect(layout.get('amtrak')).toEqual({ left: 110, width: 95, z: 1 });
    expect(layout.get('nolan')).toEqual({ left: 205, width: 95, z: 1 });
  });

  it('never puts two blocks at the same level on top of each other', () => {
    const byId = new Map(day.map((d) => [d.id, d]));
    const ids = [...layout.keys()];
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const pa = layout.get(a)!;
        const pb = layout.get(b)!;
        if (pa.z !== pb.z) continue;
        const ea = byId.get(a)!;
        const eb = byId.get(b)!;
        const timeOverlap =
          Date.parse(ea.startsAt) < Date.parse(eb.endsAt) &&
          Date.parse(eb.startsAt) < Date.parse(ea.endsAt);
        const spaceOverlap = pa.left < pb.left + pb.width && pb.left < pa.left + pa.width;
        expect(timeOverlap && spaceOverlap, `${a} vs ${b}`).toBe(false);
      }
    }
  });

  it('widens a block into a lane nothing else uses at its time', () => {
    const l = layoutDayBlocks(
      [
        { id: 'long', startsAt: '2026-10-23T09:00:00Z', endsAt: '2026-10-23T11:00:00Z' },
        { id: 'short', startsAt: '2026-10-23T09:00:00Z', endsAt: '2026-10-23T09:30:00Z' },
        { id: 'mid', startsAt: '2026-10-23T09:10:00Z', endsAt: '2026-10-23T09:40:00Z' },
        { id: 'after', startsAt: '2026-10-23T09:40:00Z', endsAt: '2026-10-23T10:00:00Z' },
      ],
      { width: 300 },
    );
    expect(l.get('long')).toMatchObject({ left: 0, width: 100 });
    expect(l.get('mid')).toMatchObject({ left: 200, width: 100 });
    // 'after' takes the lane 'short' freed, and nothing is in lane 2 by then.
    expect(l.get('after')).toMatchObject({ left: 100, width: 200 });
  });
});
