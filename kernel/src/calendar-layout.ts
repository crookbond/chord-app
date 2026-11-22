/**
 * Pure helpers for laying TimeRange blocks onto an hourly day grid.
 *
 * Lives in `kernel/` because the math is shared by mobile (the calendar
 * UI) and the server vitest suite (which exercises the helpers without
 * pulling React Native into the test runner).
 */

import type { TravelLeg, TripStatus } from './types/trip';

/**
 * The device-local day containing `date`, from its midnight to the next.
 * Not midnight + 24 hours: the day the clocks change is 23 or 25 hours long,
 * and a fixed 24 cut off its last hour or ran into the next day.
 */
export function localDayBounds(date: Date): { dayStart: number; dayEnd: number } {
  return {
    dayStart: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
    dayEnd: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
  };
}

/** Minutes past local midnight on the clock, not elapsed: the grid's rows are
 *  clock hours, so 9:00 sits in the 9:00 row even on a 25-hour day. */
function wallMinutes(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * Map a [start, end) interval onto pixel coordinates on a 24-hour grid for
 * a single day. Intervals that begin before the day clip to top=0; those
 * that end after midnight clip to the day's end. Minimum height ensures a
 * zero-duration entry is still visible.
 */
export function clipBlockToDay(
  start: Date,
  end: Date,
  date: Date,
  hourHeight: number,
  minHeight = 14,
): { top: number; height: number } {
  const { dayStart, dayEnd } = localDayBounds(date);
  const visibleStart = Math.max(start.getTime(), dayStart);
  const visibleEnd = Math.min(end.getTime(), dayEnd);
  const startMinutes = visibleStart === dayStart ? 0 : wallMinutes(visibleStart);
  const endMinutes = visibleEnd === dayEnd ? 24 * 60 : wallMinutes(visibleEnd);
  const top = (startMinutes / 60) * hourHeight;
  const rawHeight = ((endMinutes - startMinutes) / 60) * hourHeight - 2;
  const height = Math.max(rawHeight, minHeight);
  return { top, height };
}

/** A block's column within its overlap group; `cluster` identifies the group,
 *  so a view too narrow for `lanes` columns can collapse the group instead. */
export interface BlockLane {
  lane: number;
  lanes: number;
  cluster: number;
}

/**
 * Assign each block a lane so overlapping blocks render side by side instead
 * of on top of each other. Sweep by start; each chain of overlapping blocks
 * shares a lane count, and each block takes the lowest free lane.
 *
 * Overlap is judged on the extent a block is DRAWN at, not its true end: a
 * short or zero-length event is stretched to a minimum height so its title
 * stays readable, and two such events at 4:00 PM would otherwise count as
 * non-overlapping and both be drawn full-width in the same spot.
 * `minVisibleMs` is that minimum height expressed as time.
 */
export function assignLanes(
  blocks: { id: string; startsAt: string; endsAt?: string | null }[],
  minVisibleMs = 0,
): Map<string, BlockLane> {
  const out = new Map<string, BlockLane>();
  const items = blocks
    .map((b) => {
      const start = Date.parse(b.startsAt);
      const trueEnd = b.endsAt ? Date.parse(b.endsAt) : start + 30 * 60 * 1000;
      return { id: b.id, start, end: Math.max(trueEnd, start + minVisibleMs) };
    })
    .filter((it) => !Number.isNaN(it.start) && !Number.isNaN(it.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let cluster: typeof items = [];
  let clusterEnd = -Infinity;
  let clusterId = 0;
  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assignments: number[] = [];
    for (const it of cluster) {
      let placed = laneEnds.findIndex((end) => end <= it.start);
      if (placed === -1) {
        placed = laneEnds.length;
        laneEnds.push(it.end);
      } else {
        laneEnds[placed] = it.end;
      }
      assignments.push(placed);
    }
    const id = clusterId++;
    cluster.forEach((it, i) =>
      out.set(it.id, { lane: assignments[i]!, lanes: laneEnds.length, cluster: id }),
    );
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    if (it.start >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

/** Where a block sits in a day column, in pixels from the column's left edge.
 *  `z` is the stacking order: a block drawn over an earlier one is higher. */
export interface DayBlockPlacement {
  left: number;
  width: number;
  z: number;
}

/**
 * Apple-Calendar-style placement for one day column.
 *
 * Blocks that start close together (within `cascadeMs` of the latest start in
 * the group) sit side by side, each widening right until it meets a neighbour
 * that overlaps it. A block that starts well after the blocks it overlaps is
 * drawn ON TOP of them, indented by `indent` px and running to the column's
 * right edge, instead of squeezing everything into narrower columns. The
 * earlier block's title stays visible above it, because it started at least
 * `cascadeMs` higher up.
 *
 * Overlap is judged on the drawn extent (`minVisibleMs`), as in assignLanes.
 */
export function layoutDayBlocks(
  blocks: { id: string; startsAt: string; endsAt?: string | null }[],
  opts: { width: number; minVisibleMs?: number; cascadeMs?: number; indent?: number },
): Map<string, DayBlockPlacement> {
  const width = Math.max(0, opts.width);
  const minVisibleMs = opts.minVisibleMs ?? 0;
  const cascadeMs = opts.cascadeMs ?? 45 * 60 * 1000;
  const indent = opts.indent ?? 10;
  const items = blocks
    .map((b) => {
      const start = Date.parse(b.startsAt);
      const trueEnd = b.endsAt ? Date.parse(b.endsAt) : start + 30 * 60 * 1000;
      return { id: b.id, start, end: Math.max(trueEnd, start + minVisibleMs) };
    })
    .filter((it) => !Number.isNaN(it.start) && !Number.isNaN(it.end))
    // Longer first on a tie, so the long block takes the left column.
    .sort((a, b) => a.start - b.start || b.end - a.end);

  type Item = (typeof items)[number];
  interface Row { members: Item[]; latestStart: number; start: number; end: number }
  const rows: Row[] = [];
  for (const it of items) {
    let row: Row | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (it.start < r.end && it.start < r.latestStart + cascadeMs) {
        row = r;
        break;
      }
    }
    if (row) {
      row.members.push(it);
      row.latestStart = Math.max(row.latestStart, it.start);
      row.end = Math.max(row.end, it.end);
    } else {
      rows.push({ members: [it], latestStart: it.start, start: it.start, end: it.end });
    }
  }

  const out = new Map<string, DayBlockPlacement>();
  const placed: Array<DayBlockPlacement & { start: number; end: number }> = [];
  // Deep nesting never pushes a group past this, so it keeps some width.
  const maxRegionLeft = width * 0.6;
  for (const row of rows) {
    const under = placed.filter((p) => p.start < row.end && row.start < p.end);
    let regionLeft = 0;
    let z = 0;
    if (under.length > 0) {
      const anchor = under.reduce((a, b) =>
        b.z > a.z || (b.z === a.z && b.left < a.left) ? b : a,
      );
      regionLeft = Math.min(anchor.left + indent, maxRegionLeft);
      z = Math.max(...under.map((p) => p.z)) + 1;
    }
    const laneEnds: number[] = [];
    const lanes: number[] = [];
    for (const m of row.members) {
      let lane = laneEnds.findIndex((end) => end <= m.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(m.end);
      } else {
        laneEnds[lane] = m.end;
      }
      lanes.push(lane);
    }
    const laneCount = laneEnds.length;
    const laneWidth = (width - regionLeft) / laneCount;
    row.members.forEach((m, i) => {
      const lane = lanes[i]!;
      // Widen right across lanes nothing else in this group uses at this time.
      let span = 1;
      for (let next = lane + 1; next < laneCount; next++) {
        const blocked = row.members.some(
          (o, j) => lanes[j] === next && o.start < m.end && m.start < o.end,
        );
        if (blocked) break;
        span++;
      }
      const p = { left: regionLeft + lane * laneWidth, width: span * laneWidth, z };
      out.set(m.id, p);
      placed.push({ ...p, start: m.start, end: m.end });
    });
  }
  return out;
}

/** What `legsNotOnCalendar` reads of an event. */
export interface CalendarEventForLeg {
  startsAt: string;
  title: string;
  location?: string;
  externalUid?: string;
  tripId?: string;
}

const LEG_UID = 'chord:travel_leg:';
const SAME_START_MS = 60_000;

/**
 * A flight on a trip usually has its own calendar event (ADR 0158), and the
 * calendar drew both: the event and the trip's leg block, so every flight
 * showed twice (more with a family on one flight). A leg is left out when an
 * event the viewer sees departs at the same moment and is that flight: made
 * from a leg, filed under the leg's trip, or naming its flight number or
 * route. The event stays, since it carries its calendar's colour and opens for
 * editing; a leg with no event of its own is still drawn.
 */
export function legsNotOnCalendar<
  L extends Pick<TravelLeg, 'tripId' | 'origin' | 'destination' | 'departAt' | 'flightNo'>,
>(legs: L[], events: CalendarEventForLeg[]): L[] {
  return legs.filter((leg) => {
    const depart = Date.parse(leg.departAt);
    if (Number.isNaN(depart)) return true;
    const digits = (leg.flightNo ?? '').replace(/\D/g, '').replace(/^0+/, '');
    return !events.some((e) => {
      const start = Date.parse(e.startsAt);
      if (Number.isNaN(start) || Math.abs(start - depart) > SAME_START_MS) return false;
      if (e.externalUid?.startsWith(LEG_UID)) return true;
      if (e.tripId && e.tripId === leg.tripId) return true;
      const text = `${e.title} ${e.location ?? ''}`.toLowerCase();
      if (digits && new RegExp(`(^|\\D)0*${digits}(\\D|$)`).test(text)) return true;
      return mentions(text, leg.origin) && mentions(text, leg.destination);
    });
  });
}

function mentions(text: string, place: string): boolean {
  const p = place.trim().toLowerCase();
  return p.length > 0 && text.includes(p);
}

/**
 * Filter every leg across the visible trips to those whose [departAt, arriveAt)
 * intersects `date`. Multi-day legs (red-eyes, transcontinental trains) match
 * each day they touch; the renderer clips per-day on the rendering side.
 */
export function legsForDay(trips: TripStatus[], date: Date): TravelLeg[] {
  const { dayStart, dayEnd } = localDayBounds(date);
  const out: TravelLeg[] = [];
  for (const t of trips) {
    for (const leg of t.legs) {
      const depart = Date.parse(leg.departAt);
      const arrive = Date.parse(leg.arriveAt);
      if (Number.isNaN(depart) || Number.isNaN(arrive)) continue;
      if (arrive >= dayStart && depart < dayEnd) out.push(leg);
    }
  }
  return out;
}
