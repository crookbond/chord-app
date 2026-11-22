/**
 * An all-day event is stored as floating local midnight (ADR 0040) and a
 * delivery date can be date-only. Read with Date.parse those are midnight in
 * the SERVER's zone (UTC in prod, so 8 PM the evening before in New York),
 * and the email features treated today's all-day items as already over:
 *  - the email extractor's calendar context dropped them and showed them to
 *    the model as "8 PM yesterday",
 *  - a category tile dropped today's all-day timeline item and a parcel due
 *    today,
 *  - the change notice said "Thu, Oct 22 at 8:00 PM" for an event on Fri 23.
 *
 * Clock: 7 PM Friday 23 Oct in New York (23:00 UTC).
 */
import { describe, expect, it } from 'vitest';

import { friendlyWhen } from '@/services/email/email-changes.service.js';
import { formatLabelledWorld, windowEvents } from '@/services/email/magics-context.js';
import { dropLandedRows, dropPastTimeline } from '@/services/email/tile-facts.js';

const NY = 'America/New_York';
const NOW = Date.parse('2026-10-23T23:00:00Z');
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

describe('email features - all-day items today', () => {
  it("the extractor's calendar window keeps today's all-day event", () => {
    const rows = [
      { id: 'ev1', title: 'Water shut-off', at: '2026-10-23T00:00:00' },
      { id: 'ev2', title: 'Old all-day', at: '2026-10-22T00:00:00' },
    ];
    const kept = windowEvents(rows, NOW - TWELVE_HOURS, NOW + 60 * 86400000, 12, NY);
    expect(kept.map((r) => r.title)).toEqual(['Water shut-off']);
  });

  it('the extractor is shown an all-day event on its own day', () => {
    const world = formatLabelledWorld(
      {
        events: [{ id: 'ev1', title: 'Water shut-off', at: '2026-10-23T00:00:00' }],
        tasks: [],
        trips: [],
        openSlots: [],
      },
      NY,
    );
    expect(world.block).toContain('Water shut-off - 2026-10-23 (all day)');
  });

  it("a tile keeps today's all-day timeline item until the day is over", () => {
    const items = [{ title: 'Picture day', at: '2026-10-23T00:00:00', threadId: 't1', proposalId: null }];
    expect(dropPastTimeline(items, NOW, NY).map((i) => i.title)).toEqual(['Picture day']);
    // 1 AM Saturday in New York: the day is over.
    expect(dropPastTimeline(items, Date.parse('2026-10-24T05:00:00Z'), NY)).toEqual([]);
  });

  it('a parcel due today stays on the tile; one due yesterday goes', () => {
    const rows = [
      { title: 'Shoes', status: 'out_for_delivery' as const, threadId: 't1', etaAt: '2026-10-23' },
      { title: 'Books', status: 'shipped' as const, threadId: 't2', etaAt: '2026-10-22' },
    ];
    expect(dropLandedRows(rows, NOW, NY).map((r) => r.title)).toEqual(['Shoes']);
  });

  it('the change notice names the right day for an all-day event', () => {
    expect(friendlyWhen('2026-10-23T00:00:00', NY)).toBe('Fri, Oct 23 (all day)');
    expect(friendlyWhen('2026-10-23T17:30:00-04:00', NY)).toBe('Fri, Oct 23 at 5:30 PM');
  });
});
