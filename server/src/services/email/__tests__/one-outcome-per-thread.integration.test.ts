/**
 * One email, one outcome, whichever pass reads it first (ADR 0244).
 *
 * Built from the 2026-10-12 production recording: a fresh account, six
 * emails, and two passes over each of them seconds apart. The read-time
 * warm-up (ADR 0219) staged "Flight UA 1234 from Newark to Denver" and
 * "Hotel stay at Hyatt Regency Denver" as bare calendar events at 22:52:52
 * and :53; the sweep staged the trip bundle for the same two emails at
 * 22:52:58 and :60. The potluck email got a list from one pass and a to-do
 * from the other.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  parseSuggestions,
  runEmailMagics,
  runReadTimeEmailMagics,
  splitListEntry,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import type { TravelClassifier } from '@/services/email/trip-extraction.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// Relative, so the "nothing past is staged" guards never start refusing the
// fixture (ADR 0100/0158). The recording's dates were 20 and 24 November.
const isoDay = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const FLY_OUT = isoDay(38);
const FLY_BACK = isoDay(42);

const FLIGHT_SUBJECT = 'Your United itinerary - Confirmation KX8QP2';
const FLIGHT_BODY = [
  'Passenger: John Doe',
  'Confirmation: KX8QP2',
  `Flight UA 1234 - ${FLY_OUT} - depart Newark (EWR) 8:15 AM, arrive Denver (DEN) 10:45 AM`,
  `Flight UA 2345 - ${FLY_BACK} - depart Denver (DEN) 4:30 PM, arrive Newark (EWR) 10:20 PM`,
  'Total paid: $486.20',
].join('\n');

const HOTEL_SUBJECT = 'Booking confirmed - Hyatt Regency Denver';
const HOTEL_BODY = [
  'Guest: John Doe',
  'Confirmation: 48219377',
  'Hyatt Regency Denver, 650 15th St, Denver, CO',
  `Check-in: ${FLY_OUT}`,
  `Check-out: ${FLY_BACK}`,
  '1 King Room, 4 nights',
].join('\n');

const POTLUCK_SUBJECT = 'Potluck on Sunday - what to bring';
const POTLUCK_BODY =
  'For the block potluck this Sunday at noon, could you bring paper plates, a fruit salad, and two bottles of sparkling water? Everyone else has mains covered. Thanks, Priya';

const FLIGHT_CLASSIFIER: TravelClassifier = async () => ({
  kind: 'flight',
  confirmation: 'KX8QP2',
  passengerName: 'John Doe',
  legs: [
    {
      origin: 'EWR',
      destination: 'DEN',
      departAt: `${FLY_OUT}T08:15:00`,
      arriveAt: `${FLY_OUT}T10:45:00`,
      carrier: 'United',
      flightNo: 'UA1234',
    },
    {
      origin: 'DEN',
      destination: 'EWR',
      departAt: `${FLY_BACK}T16:30:00`,
      arriveAt: `${FLY_BACK}T22:20:00`,
      carrier: 'United',
      flightNo: 'UA2345',
    },
  ],
});

const HOTEL_CLASSIFIER: TravelClassifier = async () => ({
  kind: 'hotel',
  propertyName: 'Hyatt Regency Denver',
  address: '650 15th St, Denver, CO',
  city: 'Denver',
  checkinDate: FLY_OUT,
  checkoutDate: FLY_BACK,
  confirmation: '48219377',
});

/** What the general extractor said about the same two emails in production. */
const flightEventExtractor: EmailExtractor = {
  async extract() {
    return {
      kind: 'event',
      title: 'Flight UA 1234 from Newark to Denver',
      startsAt: `${FLY_OUT}T08:15:00-05:00`,
    };
  },
};
const hotelEventExtractor: EmailExtractor = {
  async extract() {
    return {
      kind: 'event',
      title: 'Hotel stay at Hyatt Regency Denver',
      startsAt: `${FLY_OUT}T15:00:00-07:00`,
    };
  },
};

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  __resetGmailMock();
  // Without the mock the sweep's invite probe throws and defers every thread.
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
  userId = await createUser(db, 'one-outcome-user');
  // The passenger on the ticket IS the account owner, as in the recording.
  await db
    .updateTable('users')
    .set({ last_tz: 'America/New_York', display_name: 'John Doe' })
    .where('id', '=', userId)
    .execute();
  await ensurePersonalGroup(db, userId);
});
afterEach(async () => {
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

async function seedThread(opts: {
  subject: string;
  body: string;
  /** Snapshot-local category id, e.g. `mk:travel/flights`; omit = unclassified. */
  category?: { id: string; title: string };
}): Promise<{ threadId: string; gid: string }> {
  const at = new Date().toISOString();
  const gid = `t_${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: opts.subject,
      snippet: opts.body.slice(0, 80),
      from_email: 'ownertest@gmail.com',
      last_message_at: at,
      is_unread: 1,
      is_archived: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: `m_${gid}`,
      gmail_thread_id: gid,
      from_name: 'John Doe',
      from_email: 'ownertest@gmail.com',
      to_emails: JSON.stringify(['owner.alumni@alumni.example.edu']),
      cc_emails: JSON.stringify([]),
      subject: opts.subject,
      snippet: opts.body.slice(0, 80),
      body_text: opts.body,
      body_html: null,
      internal_date: at,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
      created_at: at,
    })
    .execute();
  __addGmailMockMessage(userId, {
    id: `m_${gid}`,
    threadId: gid,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: opts.body.slice(0, 80),
    internalDate: String(Date.parse(at)),
    historyId: '1',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: opts.subject }],
      body: { size: opts.body.length, data: Buffer.from(opts.body).toString('base64url') },
    },
  });
  if (opts.category) await classify(gid, opts.category);
  return { threadId, gid };
}

async function classify(gid: string, category: { id: string; title: string }): Promise<void> {
  await ingestClassification(db, userId, {
    version: 1,
    userId,
    categories: [{ id: category.id, parentId: null, title: category.title, depth: 0 }],
    assignments: [{ gmailThreadId: gid, categoryId: category.id }],
  });
}

const pendingTools = async (gid: string): Promise<string[]> =>
  (
    await db
      .selectFrom('proposals')
      .select('tool_name')
      .where('proposed_by_user_id', '=', userId)
      .where('provenance', '=', `gmail:${gid}`)
      .where('status', '=', 'pending')
      .execute()
  )
    .map((r) => r.tool_name)
    .sort();

const TRAVEL_FLIGHTS = { id: 'mk:travel/flights', title: 'Flights' };
const TRAVEL_HOTELS = { id: 'mk:travel/hotels', title: 'Hotels' };
const PLAYDATES = { id: 'mk:friends-family/playdates-invites', title: 'Playdates & invites' };

describe('a travel email is a trip, whichever pass reads it first', () => {
  it('flight: the read-time pass then the sweep leave the trip bundle and no calendar-event twin', async () => {
    // The production order: both passes saw the thread already classified.
    const { threadId, gid } = await seedThread({
      subject: FLIGHT_SUBJECT,
      body: FLIGHT_BODY,
      category: TRAVEL_FLIGHTS,
    });

    await runReadTimeEmailMagics(db, userId, threadId, {
      extractor: flightEventExtractor,
      tripClassifier: FLIGHT_CLASSIFIER,
    });
    await runEmailMagics(db, userId, {
      extractor: flightEventExtractor,
      tripClassifier: FLIGHT_CLASSIFIER,
    });

    expect(await pendingTools(gid)).toEqual(['add_travel_leg', 'add_travel_leg', 'create_trip']);
  });

  it('hotel: the read-time pass then the sweep leave the stay and no "Hotel stay" event', async () => {
    const { threadId, gid } = await seedThread({
      subject: HOTEL_SUBJECT,
      body: HOTEL_BODY,
      category: TRAVEL_HOTELS,
    });

    await runReadTimeEmailMagics(db, userId, threadId, {
      extractor: hotelEventExtractor,
      tripClassifier: HOTEL_CLASSIFIER,
    });
    await runEmailMagics(db, userId, {
      extractor: hotelEventExtractor,
      tripClassifier: HOTEL_CLASSIFIER,
    });

    expect(await pendingTools(gid)).toEqual(['add_accommodation', 'create_trip']);
  });

  it('trip wins: an event staged before the thread was classified is withdrawn when the trip is staged', async () => {
    // Opened (or warmed) before the classifier reached it: nothing says
    // "travel" yet, so the general extractor is all there is.
    const { threadId, gid } = await seedThread({ subject: FLIGHT_SUBJECT, body: FLIGHT_BODY });
    await runReadTimeEmailMagics(db, userId, threadId, {
      extractor: flightEventExtractor,
      tripClassifier: FLIGHT_CLASSIFIER,
    });
    expect(await pendingTools(gid)).toEqual(['create_event']);

    await classify(gid, TRAVEL_FLIGHTS);
    await runEmailMagics(db, userId, {
      extractor: flightEventExtractor,
      tripClassifier: FLIGHT_CLASSIFIER,
    });

    expect(await pendingTools(gid)).toEqual(['add_travel_leg', 'add_travel_leg', 'create_trip']);
  });

  it('trip wins leaves a to-do from a DIFFERENT email alone', async () => {
    const other = await seedThread({
      subject: 'Permission slip due Friday',
      body: 'Please sign and return the permission slip by Friday.',
    });
    await runReadTimeEmailMagics(db, userId, other.threadId, {
      extractor: { extract: async () => ({ kind: 'task', title: 'Return the permission slip' }) },
    });
    const flight = await seedThread({
      subject: FLIGHT_SUBJECT,
      body: FLIGHT_BODY,
      category: TRAVEL_FLIGHTS,
    });

    await runEmailMagics(db, userId, {
      extractor: { extract: async () => null },
      tripClassifier: FLIGHT_CLASSIFIER,
    });

    expect(await pendingTools(other.gid)).toEqual(['create_task']);
    expect(await pendingTools(flight.gid)).toEqual(['add_travel_leg', 'add_travel_leg', 'create_trip']);
  });
});

describe('one email is staged from once', () => {
  const potluckList: EmailExtractor = {
    async extract() {
      return {
        kind: 'list',
        listName: 'Potluck items to bring on Sunday',
        item: 'paper plates, a fruit salad, and two bottles of sparkling water',
      };
    },
  };
  const potluckTask: EmailExtractor = {
    async extract() {
      return {
        kind: 'task',
        title:
          'Bring paper plates, a fruit salad, and two bottles of sparkling water to the block potluck on Sunday at noon',
      };
    },
  };

  it('potluck: a list from the read-time pass is not joined by a to-do from the sweep', async () => {
    const { threadId, gid } = await seedThread({
      subject: POTLUCK_SUBJECT,
      body: POTLUCK_BODY,
      category: PLAYDATES,
    });

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: potluckList });
    await runEmailMagics(db, userId, { extractor: potluckTask });

    expect(await pendingTools(gid)).toEqual(['add_list_item']);
  });

  it('potluck: both passes in flight on the thread at once still stage one card', async () => {
    const { threadId, gid } = await seedThread({
      subject: POTLUCK_SUBJECT,
      body: POTLUCK_BODY,
      category: PLAYDATES,
    });
    // Neither extractor returns until BOTH passes are past their first
    // "has this thread been staged?" read: the two-process overlap.
    let arrived = 0;
    let release!: () => void;
    const bothIn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = (inner: EmailExtractor): EmailExtractor => ({
      async extract(input) {
        arrived += 1;
        if (arrived >= 2) release();
        await bothIn;
        return inner.extract(input);
      },
    });

    await Promise.all([
      runReadTimeEmailMagics(db, userId, threadId, { extractor: gated(potluckList) }),
      runEmailMagics(db, userId, { extractor: gated(potluckTask) }),
    ]);

    expect(await pendingTools(gid)).toHaveLength(1);
  });

  it('potluck: one pass that returns the ask as a to-do AND a list stages the list only', async () => {
    const { threadId, gid } = await seedThread({ subject: POTLUCK_SUBJECT, body: POTLUCK_BODY });
    const both: EmailExtractor = {
      async extract(input) {
        return [(await potluckTask.extract(input)) as never, (await potluckList.extract(input)) as never];
      },
    };

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: both });

    expect(await pendingTools(gid)).toEqual(['add_list_item']);
  });

  it('a person learned from the same email (ADR 0076) does not count as the email being staged', async () => {
    const { threadId, gid } = await seedThread({ subject: POTLUCK_SUBJECT, body: POTLUCK_BODY });
    const personal = await ensurePersonalGroup(db, userId);
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_person',
      args: { name: 'Priya' },
      provenance: `gmail:${gid}`,
    });

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: potluckList });

    expect(await pendingTools(gid)).toEqual(['add_list_item', 'add_person']);
  });

  it('a delivery that needs someone home is offered once across both passes', async () => {
    const eta = isoDay(5);
    const { threadId, gid } = await seedThread({
      subject: 'Your order is out for delivery',
      body: `Signature required. Arriving ${eta} between 10am and 2pm.`,
      category: { id: 'mk:shopping/deliveries', title: 'Deliveries' },
    });
    const delivery: EmailExtractor = {
      async extract(input) {
        input.onDelivery?.({ etaAt: eta, needsPresence: true });
        return null;
      },
    };

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: delivery });
    await runEmailMagics(db, userId, { extractor: delivery });

    expect(await pendingTools(gid)).toEqual(['create_event']);
  });
});

describe('the potluck reply, as a model writes it', () => {
  it('one list of three things, and no to-do saying the same', () => {
    const raw = JSON.stringify({
      items: [
        {
          kind: 'task',
          title:
            'Bring paper plates, a fruit salad, and two bottles of sparkling water to the block potluck on Sunday 2026-10-18 at noon',
        },
        {
          kind: 'list',
          listName: 'Potluck items to bring on Sunday',
          items: ['paper plates, a fruit salad, and two bottles of sparkling water'],
        },
      ],
    });
    expect(parseSuggestions(raw)).toEqual([
      { kind: 'list', listName: 'Potluck items to bring on Sunday', item: 'paper plates' },
      { kind: 'list', listName: 'Potluck items to bring on Sunday', item: 'a fruit salad' },
      { kind: 'list', listName: 'Potluck items to bring on Sunday', item: 'two bottles of sparkling water' },
    ]);
  });

  it('keeps a to-do that is a different obligation from the list', () => {
    const kept = parseSuggestions(
      JSON.stringify({
        items: [
          { kind: 'task', title: 'Reply to Priya to say you are coming' },
          { kind: 'list', listName: 'Potluck', items: ['paper plates', 'fruit salad'] },
        ],
      }),
    );
    expect(kept.map((s) => s.kind)).toEqual(['task', 'list', 'list']);
  });

  it('does not split an entry that is not a plain series', () => {
    expect(splitListEntry('flour (2 cups, sifted), sugar, eggs')).toEqual([
      'flour (2 cups, sifted), sugar, eggs',
    ]);
    expect(splitListEntry('mac and cheese')).toEqual(['mac and cheese']);
    expect(splitListEntry('salt, pepper')).toEqual(['salt, pepper']);
    // A sentence with a date in it has commas and is still one thing.
    const sentence = 'Decide whether to sell or use US Open tickets for Sun, Aug 30, 12:00 PM';
    expect(splitListEntry(sentence)).toEqual([sentence]);
  });
});

describe('a time after the clocks change', () => {
  // 12 October 2026, 6:52 PM in New York: daylight time, -04:00.
  const RECORDED = new Date('2026-10-12T22:52:00Z');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(RECORDED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const stagedStart = async (gid: string): Promise<string> => {
    const row = await db
      .selectFrom('proposals')
      .select('args_json')
      .where('provenance', '=', `gmail:${gid}`)
      .where('tool_name', '=', 'create_event')
      .executeTakeFirstOrThrow();
    return (JSON.parse(row.args_json) as { startsAt: string }).startsAt;
  };
  const novemberEvent: EmailExtractor = {
    async extract() {
      // What the model returned for a New York reader on 12 October.
      return { kind: 'event', title: 'Parent-teacher conference', startsAt: '2026-11-20T08:15:00-04:00' };
    },
  };

  it('an event on 20 November is staged on -05:00, not on the offset of the day it was read', async () => {
    const { threadId, gid } = await seedThread({
      subject: 'Conference slot confirmed',
      body: 'Your parent-teacher conference is confirmed for Friday November 20, 2026 at 8:15 AM.',
    });
    await runReadTimeEmailMagics(db, userId, threadId, { extractor: novemberEvent });
    expect(await stagedStart(gid)).toBe('2026-11-20T08:15:00-05:00');
  });

  it('but an offset is left as written when the email names the zone itself', async () => {
    const { threadId, gid } = await seedThread({
      subject: 'Conference slot confirmed',
      body: 'Your conference is confirmed for Friday November 20, 2026 at 8:15 AM AST (Halifax).',
    });
    await runReadTimeEmailMagics(db, userId, threadId, { extractor: novemberEvent });
    expect(await stagedStart(gid)).toBe('2026-11-20T08:15:00-04:00');
  });
});
