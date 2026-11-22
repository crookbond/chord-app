/**
 * Reported: a flight leaving Delhi at 1:50am local and landing in New York at
 * 9:00am, for a user in New York, went on the calendar as 1:50am - 9:00am New
 * York time. Each of the three ways a flight is filed gave the departure the
 * reader's clock: the trip classifier when the model left the airport zone
 * out, the chat tool (which had no way to say whose clock a time was on), and
 * the general email extractor (whose rule reads every time as the user's).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  anchorFlightTimes,
  runEmailMagics,
  type EmailExtractor,
  type EmailSuggestion,
  type FlightFacts,
} from '@/services/email/magics.service.js';
import { stageEmailTripProposal, type TravelClassifier } from '@/services/email/trip-extraction.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime } from '@/utils/tz.js';

const NY = 'America/New_York';
// Relative, so the "nothing past is proposed" guards never swallow the fixture.
const DAY = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
const DEPART_WALL = `${DAY}T01:50:00`;
const ARRIVE_WALL = `${DAY}T09:00:00`;
const NY_OFFSET = offsetForLocalDatetime(NY, ARRIVE_WALL);
/** 1:50am on Delhi's clock, as an instant. */
const DELHI_DEPARTURE = Date.parse(`${DEPART_WALL}+05:30`);
const NY_ARRIVAL = Date.parse(`${ARRIVE_WALL}${NY_OFFSET}`);

describe('a flight is filed on the clocks it was printed on', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'traveller', 'John');
    await db.updateTable('users').set({ last_tz: NY }).where('id', '=', userId).execute();
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  it('itinerary email: a leg with no airport zone from the model still departs on Delhi time', async () => {
    const noZones: TravelClassifier = async () => ({
      kind: 'flight',
      confirmation: 'AI7XQ2',
      passengerName: 'John Doe',
      legs: [
        {
          origin: 'DEL',
          destination: 'JFK',
          departAt: DEPART_WALL,
          arriveAt: ARRIVE_WALL,
          carrier: 'Air India',
          flightNo: 'AI101',
        },
      ],
    });
    const kind = await stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId,
        gmailThreadId: 't_del_jfk',
        subject: 'Your Air India e-ticket',
        bodyText:
          'Your booking is confirmed. Air India AI101, Delhi (DEL) 01:50 to New York (JFK) 09:00. ' +
          'Passenger, flight numbers and times are all included in this message. Thank you for booking with us.',
        userLastTz: NY,
      },
      noZones,
    );
    expect(kind).toBe('flight');

    const row = await db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'add_travel_leg')
      .executeTakeFirstOrThrow();
    const leg = JSON.parse(row.args_json) as { departAt: string; arriveAt: string };
    expect(leg.departAt).toBe(`${DEPART_WALL}+05:30`);
    expect(leg.arriveAt).toBe(`${ARRIVE_WALL}${NY_OFFSET}`);
  });

  it("chat: a departure stamped with the asker's offset is stored, and put on the calendar, on Delhi time", async () => {
    const result = await applyToolCall(db, {
      groupId: personalGroupId,
      actorUserId: userId,
      provenance: null,
      tz: NY,
      tzOffset: NY_OFFSET,
      call: {
        name: 'add_travel_leg',
        args: {
          personaName: 'John',
          mode: 'flight',
          origin: 'DEL',
          destination: 'JFK',
          // What the model sends: the ticket's clock times, the user's offset.
          departAt: `${DEPART_WALL}${NY_OFFSET}`,
          arriveAt: `${ARRIVE_WALL}${NY_OFFSET}`,
          carrier: 'Air India',
          flightNo: 'AI101',
        },
      },
    });
    expect(result.summary).not.toMatch(/need to know|not accessible/);

    const leg = await db.selectFrom('travel_legs').selectAll().executeTakeFirstOrThrow();
    expect(leg.depart_at).toBe(`${DEPART_WALL}+05:30`);
    expect(Date.parse(leg.arrive_at)).toBe(NY_ARRIVAL);

    const event = await db
      .selectFrom('events')
      .select(['starts_at', 'ends_at'])
      .where('owner_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Date.parse(event.starts_at)).toBe(DELHI_DEPARTURE);
    expect(Date.parse(event.ends_at!)).toBe(NY_ARRIVAL);
    // 17h40 in the air, not the 7h10 the calendar used to show.
    expect((Date.parse(event.ends_at!) - Date.parse(event.starts_at)) / 60000).toBe(17 * 60 + 40);
  });

  it("general email extractor: the suggested event starts at the Delhi instant, not 1:50am the reader's time", async () => {
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    const subject = 'Booking confirmed: Delhi to New York';
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: 'g_del_jfk',
        subject,
        snippet: subject,
        from_email: 'bookings@agent.example',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: 'g_del_jfk',
        subject,
        snippet: subject,
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        body_excerpt: 'Air India flight AI101 departs Delhi (DEL) 01:50 and arrives New York (JFK) 09:00.',
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    // Not filed under travel, so the trip classifier does not take the thread.
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:fam', parentId: null, title: 'Family', depth: 0 }],
      assignments: [{ gmailThreadId: 'g_del_jfk', categoryId: 'c:fam' }],
    });

    /** Answers as the model did: the printed clock times, the user's offset. */
    const extractor: EmailExtractor = {
      async extract(input) {
        input.onFlight?.({
          departAt: `${DEPART_WALL}${NY_OFFSET}`,
          arriveAt: `${ARRIVE_WALL}${NY_OFFSET}`,
          origin: 'DEL',
          destination: 'JFK',
          status: null,
        });
        return {
          kind: 'event',
          title: 'Flight AI101 Delhi to New York',
          startsAt: `${DEPART_WALL}${NY_OFFSET}`,
          endsAt: `${ARRIVE_WALL}${NY_OFFSET}`,
        };
      },
    };
    await runEmailMagics(db, userId, { extractor });

    const row = await db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();
    const args = JSON.parse(row.args_json) as { startsAt: string; endsAt: string };
    expect(Date.parse(args.startsAt)).toBe(DELHI_DEPARTURE);
    expect(Date.parse(args.endsAt)).toBe(NY_ARRIVAL);
  });
});

describe('anchorFlightTimes', () => {
  const facts = (over: Partial<FlightFacts> = {}): FlightFacts => ({
    departAt: `${DEPART_WALL}${NY_OFFSET}`,
    arriveAt: `${ARRIVE_WALL}${NY_OFFSET}`,
    origin: 'DEL',
    destination: 'JFK',
    status: null,
    ...over,
  });

  it('moves the flight and the event that is the flight', () => {
    const flight = facts();
    const event: EmailSuggestion = {
      kind: 'event',
      title: 'Flight to New York',
      startsAt: flight.departAt!,
      endsAt: flight.arriveAt!,
    };
    anchorFlightTimes(flight, event, NY);
    expect(flight.departAt).toBe(`${DEPART_WALL}+05:30`);
    expect(event.startsAt).toBe(`${DEPART_WALL}+05:30`);
    expect(Date.parse(event.endsAt!)).toBe(NY_ARRIVAL);
  });

  it('leaves an event alone when it is not the departure itself', () => {
    const flight = facts();
    const checkIn: EmailSuggestion = {
      kind: 'event',
      title: 'Online check-in opens',
      startsAt: `${DAY}T00:30:00${NY_OFFSET}`,
    };
    anchorFlightTimes(flight, checkIn, NY);
    expect(checkIn.startsAt).toBe(`${DAY}T00:30:00${NY_OFFSET}`);
  });

  it('does not invent a time for a date-only fact, or a zone for an unknown airport', () => {
    const dateOnly = facts({ departAt: DAY });
    anchorFlightTimes(dateOnly, null, NY);
    expect(dateOnly.departAt).toBe(DAY);

    const unknown = facts({ origin: 'Kochi' });
    anchorFlightTimes(unknown, null, NY);
    expect(unknown.departAt).toBe(`${DEPART_WALL}${NY_OFFSET}`);
  });
});
