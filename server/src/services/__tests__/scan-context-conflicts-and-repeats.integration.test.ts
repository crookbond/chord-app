/**
 * What the morning briefing is told about conflicts, trips and to-dos.
 *
 * Failures being fixed:
 *  - An event on a calendar set not to block time was a conflict. The check
 *    read only `external_uid`, and a two-way-synced copy (ADR 0040) names its
 *    calendar in `google_calendar_id` with no `external_uid`, so it was taken
 *    for a Chord event, which always blocks.
 *  - Any event during a trip was a conflict, a free one or the trip's own
 *    flight included, and the line did not say whose trip.
 *  - Repeats: a clash was a tag on both events (read twice), two copies of one
 *    event clashed with each other, and a to-do copied into two groups was
 *    read back twice.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent, listEventsForUser } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { loadScanContext } from '@/services/proactive.service.js';
import { newId } from '@/utils/ids.js';

const DAY = 24 * 60 * 60_000;

/** Tomorrow at `hour`:00 UTC, as an instant. */
function tomorrowAt(hour: number): string {
  const d = new Date(Date.now() + DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

function section(prompt: string, name: string): string[] {
  const lines = prompt.split('\n');
  const at = lines.indexOf(`${name}:`);
  if (at === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  - ')) break;
    out.push(l);
  }
  return out;
}

describe('loadScanContext — conflicts, trips and repeats', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'ada');
    gid = (await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid })).id;
    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'ada@primary',
      summary: 'Primary',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    // A calendar the user can see but which does not block their time.
    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'soccer@info',
      summary: 'Kids soccer',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a synced event on a non-blocking calendar is FYI, never a conflict', async () => {
    await createEvent(db, {
      groupId: gid,
      title: 'Dentist',
      startsAt: tomorrowAt(15),
      endsAt: tomorrowAt(16),
      createdBy: uid,
    });
    // The two-way-sync shape: calendar in google_calendar_id, no external_uid.
    await createEvent(db, {
      groupId: gid,
      title: 'Sam soccer game',
      startsAt: tomorrowAt(15),
      endsAt: tomorrowAt(16),
      createdBy: uid,
      googleCalendarId: 'soccer@info',
    });

    const prompt = await loadScanContext(db, uid);
    expect(prompt).toMatch(/Sam soccer game.*INFO_ONLY/);
    expect(section(prompt, 'CONFLICTS')).toEqual([]);
  });

  it('an event marked free is FYI, never a conflict', async () => {
    await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(15), endsAt: tomorrowAt(16), createdBy: uid });
    await createEvent(db, {
      groupId: gid,
      title: 'Focus time',
      startsAt: tomorrowAt(15),
      endsAt: tomorrowAt(16),
      createdBy: uid,
      transparency: 'transparent',
    });

    const prompt = await loadScanContext(db, uid);
    expect(prompt).toMatch(/Focus time.*INFO_ONLY/);
    expect(section(prompt, 'CONFLICTS')).toEqual([]);
  });

  it('two copies of one event are one event, not a conflict', async () => {
    // The same meeting arriving from two blocking sources (Chord and the
    // primary Google calendar) as two rows.
    for (const externalUid of [undefined, 'gcal:ada@primary:copy']) {
      await createEvent(db, {
        groupId: gid,
        title: 'Parent teacher conference',
        startsAt: tomorrowAt(15),
        endsAt: tomorrowAt(16),
        createdBy: uid,
        externalUid,
      });
    }
    const rows = await db.selectFrom('events').select('id').where('title', '=', 'Parent teacher conference').execute();
    expect(rows).toHaveLength(2);

    const prompt = await loadScanContext(db, uid);
    expect(prompt.match(/Parent teacher conference/g)).toHaveLength(1);
    expect(section(prompt, 'CONFLICTS')).toEqual([]);
  });

  // Prod briefing 2026-10-24: "Switch on India overlaps ASP Suspended -
  // Election Day Tuesday morning" - two 5-minute entries. A 5-minute event is
  // a reminder, not time taken (ADR 0040's free rule now includes 5 minutes).
  it('two 5-minute events are not a conflict', async () => {
    const at = (h: number, m: number) => {
      const d = new Date(tomorrowAt(h));
      d.setUTCMinutes(m);
      return d.toISOString();
    };
    await createEvent(db, { groupId: gid, title: 'Switch on India', startsAt: at(14, 0), endsAt: at(14, 5), createdBy: uid });
    await createEvent(db, { groupId: gid, title: 'ASP Suspended - Election Day', startsAt: at(14, 0), endsAt: at(14, 5), createdBy: uid });
    expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
  });

  it('an all-day event is not a conflict', async () => {
    const day = dayAhead(1);
    await createEvent(db, { groupId: gid, title: 'Election Day', startsAt: day, endsAt: dayAhead(2), createdBy: uid });
    await createEvent(db, { groupId: gid, title: 'Dr Liz', startsAt: tomorrowAt(15), endsAt: tomorrowAt(16), createdBy: uid });
    expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
  });

  describe('during a trip', () => {
    beforeEach(async () => {
      await db
        .insertInto('trips')
        .values({
          id: 'tr_vail',
          group_id: gid,
          name: 'Vail',
          destination: 'Vail, CO',
          start_date: dayAhead(0),
          end_date: dayAhead(3),
          created_by: uid,
          created_at: new Date().toISOString(),
          source_raw_context: null,
          cancelled_at: null,
          deleted_at: null,
        })
        .execute();
      await db
        .insertInto('travel_legs')
        .values({
          id: 'lg_1',
          trip_id: 'tr_vail',
          persona_id: null,
          passenger_name: 'DOE/BEN MSTR',
          mode: 'flight',
          origin: 'JFK',
          destination: 'EGE',
          depart_at: tomorrowAt(12),
          arrive_at: tomorrowAt(17),
          carrier: 'UA',
          flight_no: '1234',
          confirmation: null,
          notes: null,
          source_doc_id: null,
          created_at: new Date().toISOString(),
          source_raw_context: null,
          cancelled_at: null,
        })
        .execute();
    });

    // ADR 0289 — the reported case: Ada's own dentist appointment is not a
    // clash with Ben's trip, because Ada is not travelling.
    it('an event for someone not on the trip is not a clash with it', async () => {
      await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
    });

    // Prod briefing 2026-10-24: "Send Ben Money ... falls during Ben's
    // Chicago trip". The event is the parent's, on the parent's calendar;
    // naming the traveller in its title does not make it his.
    it("a traveller's name in the owner's event title is not a clash", async () => {
      await createEvent(db, { groupId: gid, title: 'Send Ben Money', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      const prompt = await loadScanContext(db, uid);
      expect(section(prompt, 'CONFLICTS')).toEqual([]);
      expect(prompt).not.toMatch(/Send Ben Money.*during the trip/);
    });

    it('names whose trip a clash is with when the event is for a traveller', async () => {
      await db.updateTable('travel_legs').set({ passenger_name: 'ADA/MS' }).where('id', '=', 'lg_1').execute();
      await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      const conflicts = section(await loadScanContext(db, uid), 'CONFLICTS');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatch(/"Dentist".*during the trip "Vail".*Ada/i);
    });

    it('a shared surname in the title is not a traveller', async () => {
      await createEvent(db, { groupId: gid, title: 'Doe family dinner', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
    });

    it('the owner of the event on the trip is a clash', async () => {
      await db
        .updateTable('travel_legs')
        .set({ passenger_name: null, persona_id: uid })
        .where('id', '=', 'lg_1')
        .execute();
      await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      const conflicts = section(await loadScanContext(db, uid), 'CONFLICTS');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatch(/"Dentist".*during the trip "Vail"/);
    });

    it('a ticket in the owner’s name is a clash', async () => {
      await db.updateTable('travel_legs').set({ passenger_name: 'ADA/MS' }).where('id', '=', 'lg_1').execute();
      await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toHaveLength(1);
    });

    it('a trip that names nobody clashes on time alone', async () => {
      await db.deleteFrom('travel_legs').where('id', '=', 'lg_1').execute();
      await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(20), endsAt: tomorrowAt(21), createdBy: uid });
      const conflicts = section(await loadScanContext(db, uid), 'CONFLICTS');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatch(/"Dentist".*during the trip "Vail"/);
    });

    // Prod briefing 2026-10-23: "Tomorrow's Oct 24 Amtrak and flights overlap"
    // - two different travellers' tickets, both on Ada's calendar.
    describe('tickets on the calendar', () => {
      const ticket = (legId: string, title: string, startHour: number, endHour: number) =>
        createEvent(db, {
          groupId: gid,
          title,
          startsAt: tomorrowAt(startHour),
          endsAt: tomorrowAt(endHour),
          createdBy: uid,
          externalUid: `chord:travel_leg:${legId}`,
        });

      beforeEach(async () => {
        await db
          .insertInto('trips')
          .values({
            id: 'tr_yyz',
            group_id: gid,
            name: 'Toronto',
            destination: 'Toronto',
            start_date: dayAhead(1),
            end_date: dayAhead(4),
            created_by: uid,
            created_at: new Date().toISOString(),
            source_raw_context: null,
            cancelled_at: null,
            deleted_at: null,
          })
          .execute();
        await db
          .insertInto('travel_legs')
          .values({
            id: 'lg_2',
            trip_id: 'tr_yyz',
            persona_id: null,
            passenger_name: 'STONE/SIMON MR',
            mode: 'train',
            origin: 'NYP',
            destination: 'TWO',
            depart_at: tomorrowAt(13),
            arrive_at: tomorrowAt(18),
            carrier: 'Amtrak',
            flight_no: '63',
            confirmation: null,
            notes: null,
            source_doc_id: null,
            created_at: new Date().toISOString(),
            source_raw_context: null,
            cancelled_at: null,
          })
          .execute();
      });

      it("two travellers' overlapping tickets are not a clash", async () => {
        await ticket('lg_1', 'Flight UA 1234 JFK → EGE', 12, 17);
        await ticket('lg_2', 'Amtrak 63 NYP → TWO', 13, 18);
        expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
      });

      it("Ben's flight does not clash with the owner's own appointment", async () => {
        await ticket('lg_1', 'Flight UA 1234 JFK → EGE', 12, 17);
        await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(13), endsAt: tomorrowAt(14), createdBy: uid });
        expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
      });

      it("the owner's own flight does clash with the owner's appointment", async () => {
        await db.updateTable('travel_legs').set({ passenger_name: null, persona_id: uid }).where('id', '=', 'lg_1').execute();
        await ticket('lg_1', 'Flight UA 1234 JFK → EGE', 12, 17);
        await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(13), endsAt: tomorrowAt(14), createdBy: uid });
        const conflicts = section(await loadScanContext(db, uid), 'CONFLICTS');
        expect(conflicts.some((l) => /"Flight UA 1234.*overlaps "Dentist"/.test(l))).toBe(true);
      });

      // Prod briefing 2026-10-24: "Amtrak 101 NYP→PHL overlaps Amtrak
      // Northeast Regional Train and Flight to Toronto YYZ". Ben's train
      // arrived twice (Chord's ticket entry and Amtrak's own invite), and the
      // Stones' Toronto flight only as an ordinary Google entry - neither
      // second entry was read as a ticket, so they clashed on time alone.
      const amtrakAndToronto = async () => {
        await db
          .updateTable('travel_legs')
          .set({ mode: 'train', carrier: 'Amtrak', flight_no: '101', origin: 'NYP', destination: 'PHL', depart_at: tomorrowAt(12), arrive_at: tomorrowAt(14) })
          .where('id', '=', 'lg_1')
          .execute();
        await db
          .updateTable('travel_legs')
          .set({ mode: 'flight', carrier: 'AC', flight_no: '725', origin: 'EWR', destination: 'YYZ', depart_at: tomorrowAt(12), arrive_at: tomorrowAt(14) })
          .where('id', '=', 'lg_2')
          .execute();
        await db
          .insertInto('travel_legs')
          .values({
            id: 'lg_3',
            trip_id: 'tr_yyz',
            persona_id: null,
            passenger_name: 'STONE/KATE MRS',
            mode: 'flight',
            origin: 'EWR',
            destination: 'YYZ',
            depart_at: tomorrowAt(12),
            arrive_at: tomorrowAt(14),
            carrier: 'AC',
            flight_no: '725',
            confirmation: null,
            notes: null,
            source_doc_id: null,
            created_at: new Date().toISOString(),
            source_raw_context: null,
            cancelled_at: null,
          })
          .execute();
        await ticket('lg_1', 'Amtrak 101 NYP→PHL', 12, 14);
        await createEvent(db, {
          groupId: gid,
          title: 'Amtrak Northeast Regional Train from New York to Philadelphia',
          startsAt: tomorrowAt(12),
          endsAt: tomorrowAt(14),
          createdBy: uid,
          externalUid: 'gcal:ada@primary:amtrak-invite',
        });
        await createEvent(db, {
          groupId: gid,
          title: 'Flight to Toronto YYZ',
          startsAt: tomorrowAt(12),
          endsAt: tomorrowAt(14),
          createdBy: uid,
          externalUid: 'gcal:ada@primary:toronto',
        });
      };
      const eventId = async (title: string) =>
        (await db.selectFrom('events').select('id').where('title', '=', title).executeTakeFirstOrThrow()).id;

      it('the same journey under another name is that ticket, not a clash', async () => {
        await amtrakAndToronto();
        const prompt = await loadScanContext(db, uid);
        expect(section(prompt, 'CONFLICTS')).toEqual([]);
        // The train is listed once, by its ticket.
        expect(prompt).toMatch(/Amtrak 101 NYP→PHL/);
        expect(prompt).not.toMatch(/Amtrak Northeast Regional/);
        expect(prompt).toMatch(/Flight to Toronto YYZ/);
      });

      it('remembers which trip a matched entry is part of, and shows it on the event', async () => {
        await amtrakAndToronto();
        await loadScanContext(db, uid);
        const rows = await db
          .selectFrom('events')
          .select(['title', 'trip_id', 'trip_link'])
          .where('title', 'in', ['Flight to Toronto YYZ', 'Amtrak Northeast Regional Train from New York to Philadelphia'])
          .orderBy('title')
          .execute();
        expect(rows).toEqual([
          { title: 'Amtrak Northeast Regional Train from New York to Philadelphia', trip_id: 'tr_vail', trip_link: 'auto' },
          { title: 'Flight to Toronto YYZ', trip_id: 'tr_yyz', trip_link: 'auto' },
        ]);
        const shown = (await listEventsForUser(db, uid)).find((e) => e.title === 'Flight to Toronto YYZ');
        expect(shown?.tripName).toBe('Toronto');
        expect(shown?.tripTravelers?.length).toBe(2);
      });

      it('the user saying an entry is not travel wins over the matcher', async () => {
        await amtrakAndToronto();
        await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(12), endsAt: tomorrowAt(13), createdBy: uid });
        expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);

        const result = await applyToolCall(db, {
          groupId: gid,
          actorUserId: uid,
          provenance: 'test',
          call: { name: 'set_event_trip', args: { titleContains: 'Flight to Toronto', notTravel: true } },
        });
        expect(result.data).toMatchObject({ updated: true, tripId: null });

        // Now the user's own time: it clashes with the dentist, and the
        // matcher does not take it back.
        const conflicts = section(await loadScanContext(db, uid), 'CONFLICTS');
        expect(conflicts.some((l) => l.includes('Flight to Toronto YYZ') && l.includes('Dentist'))).toBe(true);
        const row = await db
          .selectFrom('events')
          .select(['trip_id', 'trip_link'])
          .where('id', '=', await eventId('Flight to Toronto YYZ'))
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ trip_id: null, trip_link: 'user' });
      });

      it('the user can put an entry on a trip the matcher could not find', async () => {
        await createEvent(db, { groupId: gid, title: 'Drive to the airport', startsAt: tomorrowAt(13), endsAt: tomorrowAt(14), createdBy: uid });
        await createEvent(db, { groupId: gid, title: 'Dentist', startsAt: tomorrowAt(13), endsAt: tomorrowAt(14), createdBy: uid });
        expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toHaveLength(1);

        const result = await applyToolCall(db, {
          groupId: gid,
          actorUserId: uid,
          provenance: 'test',
          call: { name: 'set_event_trip', args: { titleContains: 'Drive to the airport', tripQuery: 'Toronto' } },
        });
        expect(result.data).toMatchObject({ updated: true, tripId: 'tr_yyz', tripName: 'Toronto' });
        // Simon's trip, not Ada's time.
        expect(section(await loadScanContext(db, uid), 'CONFLICTS')).toEqual([]);
      });

      it('an ordinary event at a departure that names a different route stays the owner’s', async () => {
        await ticket('lg_1', 'Flight UA 1234 JFK → EGE', 12, 17);
        await createEvent(db, { groupId: gid, title: 'Dentist downtown', startsAt: tomorrowAt(12), endsAt: tomorrowAt(13), createdBy: uid });
        await createEvent(db, { groupId: gid, title: 'Call with bank', startsAt: tomorrowAt(12), endsAt: tomorrowAt(13), createdBy: uid });
        const conflicts = section(await loadScanContext(db, uid), 'CONFLICTS');
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatch(/Dentist downtown.*Call with bank|Call with bank.*Dentist downtown/);
      });
    });

    // Prod briefing 2026-10-23 said "accommodation pending" for the same trips
    // on every morning.
    it('says a trip has no accommodation on two mornings, then stops', async () => {
      const tagged: boolean[] = [];
      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        for (let n = 0; n < 3; n++) {
          vi.setSystemTime(new Date(Date.now() + (n === 0 ? 0 : DAY)));
          const line = section(await loadScanContext(db, uid), 'TRIPS').find((l) => l.includes('"Vail"'));
          tagged.push(!!line && /no accommodation/.test(line));
        }
      } finally {
        vi.useRealTimers();
      }
      expect(tagged).toEqual([true, true, false]);
    });

    it('a free event or the trip’s own flight is not a clash with it', async () => {
      await createEvent(db, {
        groupId: gid,
        title: 'Sam soccer game',
        startsAt: tomorrowAt(20),
        endsAt: tomorrowAt(21),
        createdBy: uid,
        googleCalendarId: 'soccer@info',
      });
      await createEvent(db, {
        groupId: gid,
        title: 'Flight UA 1234 JFK → EGE',
        startsAt: tomorrowAt(12),
        endsAt: tomorrowAt(17),
        createdBy: uid,
        externalUid: 'chord:travel_leg:lg_1',
      });
      const prompt = await loadScanContext(db, uid);
      expect(section(prompt, 'CONFLICTS')).toEqual([]);
      // Nor a "during the trip" note in any other form.
      expect(prompt).not.toMatch(/(soccer game|Flight UA 1234).*(DURING_TRIP|during the trip)/);
    });
  });

  it('a to-do copied into two groups is read back once, with the earliest date', async () => {
    const family = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
    const task = (groupId: string, title: string, due: string) =>
      db
        .insertInto('tasks')
        .values({
          id: newId('t'),
          group_id: groupId,
          title,
          status: 'open',
          due_at: due,
          created_by: uid,
          created_at: new Date().toISOString(),
        })
        .execute();
    await task(gid, 'Return permission slip', tomorrowAt(20));
    await task(family, 'Return permission slip', tomorrowAt(14));
    await task(family, 'return  permission slip!', tomorrowAt(22));

    const tasks = section(await loadScanContext(db, uid), 'OPEN_TASKS');
    expect(tasks.filter((l) => /permission slip/i.test(l))).toHaveLength(1);
  });
});
