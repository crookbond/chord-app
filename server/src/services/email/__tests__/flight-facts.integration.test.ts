/**
 * ADR 0138 — a flight we cannot name gets no link.
 *
 * The identity is PARSED out of the email and the times are READ off the same
 * magics reply, so a model that returns a flight block for mail containing no
 * recognisable designator must write nothing at all.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  parseFlight,
  runEmailMagics,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import {
  buildStateFact,
  dropLandedRows,
  flightStateStatus,
} from '@/services/email/tile-facts.js';
import { threadTrackables } from '@/services/email/trackables.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('parseFlight', () => {
  it('takes the times and route the email stated', () => {
    expect(
      parseFlight(
        '{"kind":"none","flight":{"departAt":"2026-09-03T06:40:00-07:00","origin":"SFO","destination":"JFK","status":"delayed"}}',
      ),
    ).toEqual({
      departAt: '2026-09-03T06:40:00-07:00',
      arriveAt: null,
      origin: 'SFO',
      destination: 'JFK',
      status: 'delayed',
    });
  });

  it('drops a date it cannot parse rather than rendering a wrong day', () => {
    expect(parseFlight('{"flight":{"departAt":"sometime Friday"}}')).toBeNull();
  });

  it('drops a status it does not recognise instead of passing it through', () => {
    expect(parseFlight('{"flight":{"origin":"SFO","status":"vibes"}}')?.status).toBeNull();
  });

  it('ignores mail with no flight block at all', () => {
    expect(parseFlight('{"kind":"none"}')).toBeNull();
    expect(parseFlight('not json')).toBeNull();
  });
});

describe('state facts carry the flight', () => {
  const ua = {
    iata: 'UA512',
    number: '512',
    ident: 'UAL512',
    airline: 'United Airlines',
    arriveAt: '2026-09-03T15:00:00Z',
  };

  it('rebuilds the FlightAware link from the stored ident', () => {
    const fact = buildStateFact('Trip to SFO', 'scheduled', 't1', null, ua);
    expect(fact.flight?.url).toBe('https://www.flightaware.com/live/flight/UAL512');
    expect(fact.etaAt).toBe('2026-09-03T15:00:00Z');
  });

  it('keeps the number but offers no link for an airline it cannot name', () => {
    const fact = buildStateFact('Trip', 'scheduled', 't2', null, {
      iata: 'PM230',
      number: '230',
      ident: null,
      airline: null,
    });
    expect(fact.flight?.iata).toBe('PM230');
    expect(fact.flight?.url).toBeNull();
  });

  it('adds nothing at all when there is no flight', () => {
    const fact = buildStateFact('Parcel', 'shipped', 't3', null, null);
    expect(fact.flight).toBeUndefined();
  });

  it('drops a flight once it has landed — nobody emails to say it did', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    const kept = dropLandedRows(
      [
        buildStateFact('Landed', 'scheduled', 'a', null, { ...ua, arriveAt: '2026-09-03T15:00:00Z' }),
        buildStateFact('Upcoming', 'scheduled', 'b', null, { ...ua, arriveAt: '2026-09-09T15:00:00Z' }),
      ],
      now,
    );
    expect(kept.map((k) => k.title)).toEqual(['Upcoming']);
  });

  it('maps what the mail said onto a board status, defaulting to scheduled', () => {
    expect(flightStateStatus({ iata: 'UA512', status: 'delayed' })).toBe('delayed');
    expect(flightStateStatus({ iata: 'UA512', status: 'cancelled' })).toBe('cancelled');
    expect(flightStateStatus({ iata: 'UA512', status: null })).toBe('scheduled');
    expect(flightStateStatus(null)).toBeNull();
  });
});

describe('runEmailMagics — flights', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'flight');
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const seed = async (
    gid: string,
    subject: string,
    body: string,
    fromEmail = 'no-reply@united.com',
  ): Promise<string> => {
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: fromEmail,
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
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        body_excerpt: body,
        // '' = parsed, no invite: without it the ADR 0074 probe defers the thread.
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:tra', parentId: null, title: 'Travel', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'c:tra' }],
    });
    return threadRow;
  };

  /** Answers like the real extractor: a flight block, suggestion "none". */
  const stub = (status: string | null = null): EmailExtractor => ({
    async extract(input) {
      input.onFlight?.({
        departAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        arriveAt: new Date(Date.now() + 3 * 86_400_000 + 6 * 3_600_000).toISOString(),
        origin: 'SFO',
        destination: 'JFK',
        status,
      });
      return null;
    },
  });

  it('stores the parsed designator alongside what the model read', async () => {
    const threadRow = await seed(
      't_fly',
      'Your trip to JFK — check in now',
      'Confirmation KX8QP2. Flight UA 512 departs Fri 6:40am, seat 14C.',
    );
    await runEmailMagics(db, userId, { extractor: stub('check_in') });

    const row = await db
      .selectFrom('email_threads')
      .select('flight_json')
      .where('gmail_thread_id', '=', 't_fly')
      .executeTakeFirstOrThrow();
    expect(row.flight_json).toMatchObject({
      iata: 'UA512',
      number: '512',
      ident: 'UAL512',
      airline: 'United Airlines',
      origin: 'SFO',
      destination: 'JFK',
      status: 'check_in',
    });

    // The reader gets the same link the tile board would build.
    const { flight } = await threadTrackables(db, userId, threadRow);
    expect(flight?.url).toBe('https://www.flightaware.com/live/flight/UAL512');
  });

  it('writes nothing when the mail names no flight the parser recognises', async () => {
    // The model is not the authority on identity: naming a flight wrong puts a
    // link to somebody else's aeroplane in front of the user.
    await seed('t_vague', 'Your travel plans', 'Details to follow shortly.', 'trips@example.com');
    await runEmailMagics(db, userId, { extractor: stub() });

    const row = await db
      .selectFrom('email_threads')
      .select('flight_json')
      .where('gmail_thread_id', '=', 't_vague')
      .executeTakeFirstOrThrow();
    expect(row.flight_json).toBeNull();
  });

  it('does not mistake a confirmation code for a flight number', async () => {
    await seed(
      't_code',
      'Booking confirmed',
      'Your confirmation code is KX8QP2. Order AA1234 has been placed.',
      'bookings@example.com',
    );
    await runEmailMagics(db, userId, { extractor: stub() });

    const row = await db
      .selectFrom('email_threads')
      .select('flight_json')
      .where('gmail_thread_id', '=', 't_code')
      .executeTakeFirstOrThrow();
    expect(row.flight_json).toBeNull();
  });
});
