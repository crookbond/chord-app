/**
 * "In case person is traveling, no reason to offer an in-person time unless
 * city overlaps" (ADR 0245).
 *
 * The shape is the demo account's: a Denver trip, Friday to Tuesday (EWR→DEN
 * UA 1234 out at 8:15, DEN→EWR UA 2345 back at 4:30 PM, Hyatt Regency
 * Denver, 650 15th St), and someone in New York asking to meet that week.
 * In the recording the trip was 20-24 November 2026; here it is placed
 * relative to today so the fixture does not go stale.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { userAvailability } from '@/services/availability.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { __addOutlookMockMessage, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { composeReply, meetingHints } from '@/services/email/compose-reply.service.js';
import { loadWorldContext } from '@/services/email/magics-context.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import {
  addAccommodation,
  addTravelLeg,
  cancelAccommodation,
  cancelTravelLeg,
  createTrip,
  deleteTrip,
} from '@/services/trips.service.js';
import { writeMemory } from '@/services/memory.service.js';
import { userAwayDays, userHomePlace } from '@/services/whereabouts.service.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const dayPlus = (n: number): string => svWall(new Date(Date.now() + n * 86_400_000), TZ).slice(0, 10);
// Out on day 12, back on day 16: past the ten days the drafter lists.
const OUT = dayPlus(12);
const MID = dayPlus(13);
/**
 * A day's line, whatever ADR 0330's work-hours lead says for that date (the
 * dates here move with today, so the weekday and any holiday do too).
 */
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dayLineRe = (day: string, rest: string) =>
  new RegExp(`${esc(day)}: (work hours [^;]*; |NOT A WORK DAY \\([^)]*\\); )${esc(rest)}`);
const BACK = dayPlus(16);
const HOME_AGAIN = dayPlus(17);
const at = (day: string, hhmm: string, zone: string): string =>
  `${day}T${hhmm}:00${offsetForLocalDatetime(zone, `${day}T${hhmm}:00`)}`;
const label = (day: string): string =>
  new Date(`${day}T12:00:00${offsetForLocalDatetime(TZ, `${day}T12:00:00`)}`).toLocaleDateString('en-US', {
    timeZone: TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
const monthDay = (day: string): string => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  __resetOutlookMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'traveller');
  await db
    .updateTable('users')
    .set({ last_tz: TZ, display_name: 'John Doe', first_name: 'John' })
    .where('id', '=', userId)
    .execute();
  groupId = (await ensurePersonalGroup(db, userId)).id;
  await upsertCalendarSource(db, userId, {
    googleCalendarId: 'primary@cal',
    summary: 'Me',
    accessRole: 'owner',
    isPrimary: true,
    selectedInGoogle: true,
    isChordTarget: true,
  });
});
afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

interface DenverTrip {
  tripId: string;
  legIds: string[];
  stayId: string;
}

async function denverTrip(passengerName = 'John Doe'): Promise<DenverTrip> {
  const trip = await createTrip(db, {
    groupId,
    name: 'Trip to DEN',
    destination: 'DEN',
    startDate: OUT,
    endDate: BACK,
    createdBy: userId,
    participantIds: [],
  });
  const out = await addTravelLeg(db, {
    tripId: trip.id,
    passengerName,
    mode: 'flight',
    origin: 'EWR',
    destination: 'DEN',
    departAt: at(OUT, '08:15', 'America/New_York'),
    arriveAt: at(OUT, '10:45', 'America/Denver'),
    carrier: 'United',
    flightNo: 'UA1234',
    confirmation: 'KX8QP2',
  });
  const back = await addTravelLeg(db, {
    tripId: trip.id,
    passengerName,
    mode: 'flight',
    origin: 'DEN',
    destination: 'EWR',
    departAt: at(BACK, '16:30', 'America/Denver'),
    arriveAt: at(BACK, '22:20', 'America/New_York'),
    carrier: 'United',
    flightNo: 'UA2345',
    confirmation: 'KX8QP2',
  });
  const stay = await addAccommodation(db, {
    tripId: trip.id,
    propertyName: 'Hyatt Regency Denver',
    address: '650 15th St, Denver, CO',
    checkinDate: OUT,
    checkoutDate: BACK,
    confirmation: '48219377',
  });
  return { tripId: trip.id, legIds: [out.id, back.id], stayId: stay.id };
}

const away = () => userAwayDays(db, userId, { fromDay: dayPlus(0), toDay: dayPlus(40) });

describe('userAwayDays', () => {
  it('the Denver trip: travel days at each end, in Denver between, home the day after', async () => {
    await denverTrip();
    const days = await away();
    expect([...days.keys()].sort()).toEqual([OUT, MID, dayPlus(14), dayPlus(15), BACK]);
    expect(days.get(OUT)!.travel).toEqual({ from: 'New York', to: 'Denver' });
    expect(days.get(MID)).toMatchObject({ places: ['Denver'], travel: null, tripName: 'Trip to DEN' });
    expect(days.get(BACK)!.travel).toEqual({ from: 'Denver', to: 'New York' });
    expect(days.has(HOME_AGAIN)).toBe(false);
  });

  it('a cancelled booking does not count (ADR 0168), nor a deleted trip (ADR 0171)', async () => {
    const first = await denverTrip();
    for (const id of first.legIds) await cancelTravelLeg(db, id);
    await cancelAccommodation(db, first.stayId);
    expect((await away()).size).toBe(0);

    const second = await denverTrip();
    expect((await away()).size).toBe(5);
    await deleteTrip(db, second.tripId);
    expect((await away()).size).toBe(0);
  });

  it('a trip the user is listed on is the user being away, even with unnamed tickets', async () => {
    // trip_participants.persona_id is a USER id. Joining it to `personas`
    // found nobody, so a listed traveller was never counted as away.
    const trip = await createTrip(db, {
      groupId,
      name: 'Trip to DEN',
      destination: 'DEN',
      startDate: OUT,
      endDate: BACK,
      createdBy: null,
      participantIds: [userId],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'EWR',
      destination: 'DEN',
      departAt: at(OUT, '08:15', 'America/New_York'),
      arriveAt: at(OUT, '10:45', 'America/Denver'),
    });
    expect((await away()).get(OUT)?.travel).toEqual({ from: 'New York', to: 'Denver' });
  });

  it('a trip whose tickets name someone else is not the user being away', async () => {
    await denverTrip('Alice Stone');
    expect((await away()).size).toBe(0);
  });

  it('a stay in the city the user said is home is not away', async () => {
    await db
      .updateTable('users')
      .set({ weather_place: 'Denver', weather_place_source: 'user' })
      .where('id', '=', userId)
      .execute();
    const trip = await createTrip(db, {
      groupId,
      name: 'Staycation',
      destination: 'Denver',
      startDate: OUT,
      endDate: BACK,
      createdBy: userId,
      participantIds: [],
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Hyatt Regency Denver',
      address: '650 15th St, Denver, CO',
      checkinDate: OUT,
      checkoutDate: BACK,
    });
    expect((await away()).size).toBe(0);
  });

  it('a confirmed home_airport fact is the user\'s home', async () => {
    // The lookup joined memories.persona_id to `personas`, but it holds a
    // user id, so the fact was never found.
    await writeMemory(db, {
      groupId,
      scope: 'persona',
      personaId: userId,
      key: 'home_airport',
      value: 'DEN',
      source: 'explicit',
      status: 'confirmed',
    });
    expect(await userHomePlace(db, userId)).toBe('DEN');
  });
});

describe('meetingHints', () => {
  it('reports only what the text says', () => {
    expect(meetingHints('Can we grab coffee on 11/21 at 10am?', ['Denver'])).toEqual({
      placeNamed: null,
      remote: null,
      inPerson: 'coffee',
    });
    expect(meetingHints('I am in Denver that week too, lunch?', ['Denver'])).toMatchObject({
      placeNamed: 'Denver',
      inPerson: 'lunch',
    });
    expect(meetingHints('Quick Zoom on Friday?', ['Denver'])).toMatchObject({ remote: 'Zoom', placeNamed: null });
    expect(meetingHints('Are you free at 9a on 10/26 thanks', ['Denver'])).toEqual({
      placeNamed: null,
      remote: null,
      inPerson: null,
    });
  });
});

function fakeLlm(reply: string) {
  const seen: LlmMessage[][] = [];
  const llm = {
    providerName: 'mock',
    defaultModel: 'fake-model',
    async complete(messages: LlmMessage[]) {
      seen.push(messages);
      return reply;
    },
  } as unknown as LlmService;
  return { llm, seen };
}

async function threadSaying(body: string): Promise<string> {
  await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
  const [account] = await listAccounts(db, userId);
  __addOutlookMockMessage(account.id, {
    id: 'm-meet',
    conversationId: 'conv-meet',
    subject: 'catching up',
    bodyPreview: body,
    receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
    from: { emailAddress: { address: 'priya@example.com', name: 'Priya Shah' } },
    toRecipients: [{ emailAddress: { address: 'owner.alumni@alumni.example.edu' } }],
    isRead: false,
    body: { contentType: 'text', content: body },
  });
  await syncAccount(db, account);
  return (
    await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .where('subject', '=', 'catching up')
      .executeTakeFirstOrThrow()
  ).id;
}

const SUGGEST_TIMES = 'Reply suggesting 2–3 times I am free';

describe('the reply drafter, with the user away', () => {
  it('coffee in New York on a day the user is in Denver: the day is marked AWAY and the trip is stated', async () => {
    await denverTrip();
    const threadId = await threadSaying(
      `Hi John, I'm in the city next week. Can we grab coffee on ${monthDay(MID)} at 10am? Priya`,
    );
    const { llm, seen } = fakeLlm('Hi Priya,\n\nI am travelling then.\n\nThanks,\nJohn');

    await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES, llm });

    const [system, user] = seen[0];
    const prompt = user.content as string;
    expect(prompt).toMatch(dayLineRe(label(MID), 'nothing scheduled | AWAY: in Denver'));
    expect(prompt).toContain(
      `${label(MID)} at 10:00 AM: AWAY that day (in Denver), in person only if the meeting is there; calendar FREE (nothing on the calendar from 10:00 AM to 11:00 AM)`,
    );
    expect(prompt).toContain('Do NOT confirm that time as an in-person meeting');
    expect(prompt).toContain(
      `Travel, from the user's own trips: The user is away ${label(OUT)} to ${label(BACK)} (Denver), back from ${label(HOME_AGAIN)}.`,
    );
    expect(prompt).toContain('it does not name a city the user will be in');
    expect(prompt).toContain('it reads as an in-person meeting (it says "coffee")');
    // Days to offer "after I am back" are in front of the model too.
    expect(prompt).toMatch(dayLineRe(label(HOME_AGAIN), 'nothing scheduled'));
    expect(system.content).toContain('Never offer or confirm an IN-PERSON time on an AWAY day');
  });

  it('the same ask from someone who will be in Denver: the thread is reported as naming that city', async () => {
    await denverTrip();
    const threadId = await threadSaying(
      `Hi John, I'll be in Denver too that week. Lunch on ${monthDay(MID)} at noon? Priya`,
    );
    const { llm, seen } = fakeLlm('ok');
    await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES, llm });
    const prompt = seen[0][1].content as string;
    expect(prompt).toContain('it names Denver, where the user will be');
    // The meeting is where the user will be, so the ordinary answer applies.
    expect(prompt).not.toContain('Do NOT confirm that time as an in-person meeting');
    expect(prompt).toContain('if it is FREE, confirm that time');
  });

  it('with no trip there is no Travel block and no AWAY mark', async () => {
    const threadId = await threadSaying(`Can we grab coffee on ${monthDay(MID)} at 10am?`);
    const { llm, seen } = fakeLlm('ok');
    await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES, llm });
    const prompt = seen[0][1].content as string;
    expect(prompt).not.toContain('AWAY');
    expect(prompt).not.toContain('Travel, from');
  });

  it('chat: get_my_availability marks the same days and carries the rule', async () => {
    await denverTrip();
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-away',
      call: { name: 'get_my_availability', args: { dates: [MID] } },
    });
    const data = result.data as { askedDaysText: string; awayText: string; instruction: string };
    expect(data.askedDaysText).toMatch(dayLineRe(label(MID), 'nothing scheduled | AWAY: in Denver'));
    expect(data.awayText).toContain('(Denver)');
    expect(data.instruction).toContain('Do not offer or confirm an in-person time on an AWAY day');
    // One implementation for both surfaces.
    expect(data.awayText).toBe((await userAvailability(db, userId, { alsoDays: [MID] })).awayText);
  });
});

describe('times suggested in a "reply with times" to-do', () => {
  it('skip the days a trip puts the user elsewhere', async () => {
    const trip = await createTrip(db, {
      groupId,
      name: 'Denver',
      destination: 'Denver',
      startDate: dayPlus(3),
      endDate: dayPlus(5),
      createdBy: userId,
      participantIds: [],
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Hyatt Regency Denver',
      address: '650 15th St, Denver, CO',
      checkinDate: dayPlus(3),
      checkoutDate: dayPlus(5),
    });
    const ctx = await loadWorldContext(db, userId, { tz: TZ });
    const offered = ctx.openSlots.map((s) => svWall(new Date(s.startMs), TZ).slice(0, 10));
    expect(offered.length).toBeGreaterThan(0);
    for (const d of [dayPlus(3), dayPlus(4), dayPlus(5)]) expect(offered).not.toContain(d);
    expect(offered).toContain(dayPlus(2));
  });
});

const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;
describe.skipIf(!live)('the reply drafter with the user away, live model', () => {
  const provider = env.LLM_PROVIDER;
  beforeEach(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
  });
  afterEach(() => {
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
  });

  it('does not agree to coffee in New York on a day in Denver; says so and offers a call or a later day', async () => {
    await denverTrip();
    const threadId = await threadSaying(
      `Hi John, I'm in the city next week. Can we grab coffee on ${monthDay(MID)} at 10am? Priya`,
    );
    const out = await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES });
    console.log(`[live] away on ${MID}:\n${out!.body}\n`);
    expect(out!.body).toMatch(/Denver|travel|away|out of town/i);
    expect(out!.body).toMatch(/call|back|return|after/i);
  }, 60_000);

  it('confirms lunch when the sender will be in Denver too', async () => {
    await denverTrip();
    const threadId = await threadSaying(
      `Hi John, I'll be in Denver too that week. Lunch on ${monthDay(MID)} at noon? Priya`,
    );
    const out = await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES });
    console.log(`[live] both in Denver on ${MID}:\n${out!.body}\n`);
    expect(out!.body).toMatch(/noon|12/i);
    expect(out!.body).not.toMatch(/can't|cannot|unavailable|not available/i);
  }, 60_000);
});
