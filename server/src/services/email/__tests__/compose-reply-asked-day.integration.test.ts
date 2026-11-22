/**
 * "Suggest times" answers the time that was asked about (ADR 0244).
 *
 * The recording, 12 October 2026: an email with the subject "meeting" and the
 * body "Hi John, Are you free at 9a on 10/26 thanks". The "Suggest times"
 * quick ask drafted "I'm available on Tuesday, October 13 at 10 AM,
 * Wednesday, October 14 at 2 PM, or Thursday, October 15 at 11 AM." The 26th
 * was fourteen days out and the model had been shown ten.
 *
 * The model is faked; what is pinned is what it is TOLD.
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
import { composeReply } from '@/services/email/compose-reply.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import { mentionedDays, mentionedSlots } from '@/utils/date-mentions.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/**
 * A day's line, whatever ADR 0330's work-hours lead says for that date (the
 * dates here move with today, so the weekday and any holiday do too).
 */
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dayLineRe = (day: string, rest: string) =>
  new RegExp(`${esc(day)}: (work hours [^;]*; |NOT A WORK DAY \\([^)]*\\); )${esc(rest)}`);

const TZ = 'America/New_York';
/** The app's quick ask, verbatim (mobile/app/email/[threadId].tsx). */
const SUGGEST_TIMES = 'Reply suggesting 2–3 times I am free';

describe('mentionedDays, on the recorded emails', () => {
  it('"9a on 10/26", written on 12 October, is 26 October', () => {
    expect(mentionedDays('Hi John, Are you free at 9a on 10/26 thanks', '2026-10-12')).toEqual(['2026-10-26']);
  });
  it('"Dinner Saturday the 24th?" is the next 24th', () => {
    expect(mentionedDays('Dinner Saturday the 24th?', '2026-10-12')).toEqual(['2026-10-24']);
    expect(mentionedDays('Dinner Saturday the 24th?', '2026-10-25')).toEqual(['2026-11-24']);
  });
  it('reads the itinerary dates, and nothing out of the fare', () => {
    expect(
      mentionedDays(
        'Flight UA 1234 Fri November 20, 2026 depart Newark (EWR) 8:15 AM. Flight UA 2345 Tue November 24, 2026. Total paid $486.20.',
        '2026-10-12',
      ),
    ).toEqual(['2026-11-20', '2026-11-24']);
  });
  it('a date with no year that has gone by is next year\'s', () => {
    expect(mentionedDays('are you free on 10/26', '2026-11-03')).toEqual(['2027-10-26']);
    expect(mentionedDays('see you Oct 5th or 7 November', '2026-10-12')).toEqual(['2026-11-07', '2027-10-05']);
  });
  it('ignores what is not a date', () => {
    expect(mentionedDays('Open 24/7, call 555-1234, room 13/40', '2026-10-12')).toEqual([]);
  });
});

describe('mentionedSlots', () => {
  it('"9a on 10/26" is 26 October at 9:00', () => {
    expect(mentionedSlots('Hi John, Are you free at 9a on 10/26 thanks', '2026-10-12')).toEqual([
      { day: '2026-10-26', minutes: 9 * 60 },
    ]);
  });
  it('reads the time on either side of the date, in the usual spellings', () => {
    expect(mentionedSlots('Could we do Oct 26 at 2:30 pm?', '2026-10-12')).toEqual([
      { day: '2026-10-26', minutes: 14 * 60 + 30 },
    ]);
    expect(mentionedSlots('noon on the 24th?', '2026-10-12')).toEqual([{ day: '2026-10-24', minutes: 720 }]);
    expect(mentionedSlots('10/26 14:00 works for us', '2026-10-12')).toEqual([{ day: '2026-10-26', minutes: 840 }]);
  });
  it('does not guess at a time with no AM or PM, or pair a date with a far-off time', () => {
    // 7 could be the morning or the evening (ADR 0245 reads 8-11 and 1-6 only).
    expect(mentionedSlots('are you free at 7 on 10/26', '2026-10-12')).toEqual([]);
    expect(
      mentionedSlots('We land at 9am. Separately, and much later in this note, is 10/26 open?', '2026-10-12'),
    ).toEqual([]);
    expect(mentionedSlots('2 apples and 5 people on 10/26', '2026-10-12')).toEqual([]);
  });
});

describe('the reply drafter', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'asked-day');
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
    personalId = (await ensurePersonalGroup(db, userId)).id;
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

  // Fourteen days out, as in the recording: past the ten the drafter lists.
  const askedDay = (): string => svWall(new Date(Date.now() + 14 * 86_400_000), TZ).slice(0, 10);
  const asMonthDay = (day: string): string => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  const dayLabel = (day: string): string =>
    new Date(`${day}T12:00:00${offsetForLocalDatetime(TZ, `${day}T12:00:00`)}`).toLocaleDateString('en-US', {
      timeZone: TZ,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
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

  async function meetingThread(day: string): Promise<string> {
    await connectOutlookAccount(db, userId, {
      code: 'mock',
      codeVerifier: 'mock',
      redirectUri: 'chord://oauthredirect',
    });
    const [account] = await listAccounts(db, userId);
    const body = `Hi John, Are you free at 9a on ${asMonthDay(day)} thanks`;
    __addOutlookMockMessage(account.id, {
      id: 'm-meeting',
      conversationId: 'conv-meeting',
      subject: 'meeting',
      bodyPreview: body,
      receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
      from: { emailAddress: { address: 'ownertest@gmail.com', name: 'John Doe' } },
      toRecipients: [{ emailAddress: { address: 'owner.alumni@alumni.example.edu' } }],
      isRead: false,
      body: { contentType: 'text', content: body },
    });
    await syncAccount(db, account);
    const t = await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .where('subject', '=', 'meeting')
      .executeTakeFirstOrThrow();
    return t.id;
  }

  it('shows the model the calendar for the day that was asked about, and tells it to answer that first', async () => {
    const day = askedDay();
    const threadId = await meetingThread(day);
    const { llm, seen } = fakeLlm('Hi John,\n\nYes, 9 AM works.\n\nThanks,\nJohn');

    await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES, llm });

    const [system, user] = seen[0];
    const prompt = user.content as string;
    expect(prompt).toContain('later dates mentioned in the thread');
    expect(prompt).toMatch(dayLineRe(dayLabel(day), 'nothing scheduled'));
    // The verdict is worked out from the calendar, not left to the model.
    expect(prompt).toContain(
      `${dayLabel(day)} at 9:00 AM: FREE (nothing on the calendar from 9:00 AM to 10:00 AM)`,
    );
    expect(prompt).toContain('if it is FREE, confirm that time and offer no other times');
    expect(system.content).toContain('ANSWER THAT FIRST');
    expect(system.content).toContain('Offer 2–3 alternatives only when the user is busy then');
  });

  it('shows that day as busy when 9 AM is taken', async () => {
    const day = askedDay();
    const threadId = await meetingThread(day);
    const nine = `${day}T09:00:00${offsetForLocalDatetime(TZ, `${day}T09:00:00`)}`;
    await createEvent(db, {
      groupId: personalId,
      title: 'Dentist',
      startsAt: nine,
      endsAt: new Date(Date.parse(nine) + 3600_000).toISOString(),
      createdBy: userId,
    });
    const { llm, seen } = fakeLlm('Hi John,\n\nI have something at 9.\n\nThanks,\nJohn');

    await composeReply(db, userId, threadId, { instruction: SUGGEST_TIMES, llm });

    const prompt = seen[0][1].content as string;
    expect(prompt).toMatch(dayLineRe(dayLabel(day), 'busy 9:00 AM–10:00 AM'));
    expect(prompt).toContain(`${dayLabel(day)} at 9:00 AM: BUSY (9:00 AM–10:00 AM is taken)`);
    // The day after is listed too, so an alternative there is read off the
    // calendar and not invented for a day the model was never shown.
    const dayAfter = svWall(new Date(Date.now() + 15 * 86_400_000), TZ).slice(0, 10);
    expect(prompt).toMatch(dayLineRe(dayLabel(dayAfter), 'nothing scheduled'));
  });

  it('chat: get_my_availability covers a day passed in `dates`, past its window', async () => {
    const day = askedDay();
    const result = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-asked-day',
      call: { name: 'get_my_availability', args: { dates: [day] } },
    });
    const data = result.data as { known: boolean; text: string; askedDaysText?: string };
    expect(data.known).toBe(true);
    expect(data.text).not.toContain(dayLabel(day));
    expect(data.askedDaysText).toMatch(new RegExp(`^${dayLineRe(dayLabel(day), 'nothing scheduled').source}$`));
  });

  it('a day already inside the window is not listed twice, and a past or far-off one is dropped', async () => {
    const inWindow = svWall(new Date(Date.now() + 2 * 86_400_000), TZ).slice(0, 10);
    const longGone = '2020-01-01';
    const farOff = svWall(new Date(Date.now() + 400 * 86_400_000), TZ).slice(0, 10);
    const avail = await userAvailability(db, userId, { alsoDays: [inWindow, longGone, farOff] });
    expect(avail.askedDaysText).toBeUndefined();
  });
});

/**
 * The same two cases against a real model. Skipped unless MAGICS_LIVE=1 and
 * a key is set, since each spends a real call (see magics-multi-item.live).
 */
const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;
describe.skipIf(!live)('the reply drafter, live model', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  const provider = env.LLM_PROVIDER;

  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
    db = await openTestDb();
    userId = await createUser(db, 'asked-day-live');
    await db
      .updateTable('users')
      .set({ last_tz: TZ, display_name: 'John Doe', first_name: 'John' })
      .where('id', '=', userId)
      .execute();
    personalId = (await ensurePersonalGroup(db, userId)).id;
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
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  const day = svWall(new Date(Date.now() + 14 * 86_400_000), TZ).slice(0, 10);
  const dayOfMonth = String(Number(day.slice(8, 10)));

  async function thread(): Promise<string> {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    const body = `Hi John, Are you free at 9a on ${Number(day.slice(5, 7))}/${dayOfMonth} thanks`;
    __addOutlookMockMessage(account.id, {
      id: 'm-meeting',
      conversationId: 'conv-meeting',
      subject: 'meeting',
      bodyPreview: body,
      receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
      from: { emailAddress: { address: 'ownertest@gmail.com', name: 'Alice Stone' } },
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
        .where('subject', '=', 'meeting')
        .executeTakeFirstOrThrow()
    ).id;
  }

  /** Other dates the draft names: "October 13 at 10 AM", "10/14 in the morning". */
  const otherDatesOffered = (body: string): string[] =>
    [
      ...body.matchAll(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi),
      ...body.matchAll(/\b\d{1,2}\/(\d{1,2})\b/g),
    ]
      .map((m) => m[1]!)
      .filter((d) => d !== dayOfMonth);

  it('free at the time asked about: confirms it and offers nothing else', async () => {
    const out = await composeReply(db, userId, await thread(), { instruction: SUGGEST_TIMES });
    console.log(`[live] free on ${day}:\n${out!.body}\n`);
    expect(out!.body).toMatch(/\b9(?::00)?\s?(?:a\.?m\.?)/i);
    expect(out!.body).toContain(dayOfMonth);
    expect(out!.body).not.toMatch(/not (?:free|available)|unavailable|can't|cannot|busy/i);
    expect(otherDatesOffered(out!.body)).toEqual([]);
  }, 60_000);

  it('busy at the time asked about: says so and offers other times', async () => {
    const nine = `${day}T09:00:00${offsetForLocalDatetime(TZ, `${day}T09:00:00`)}`;
    await createEvent(db, {
      groupId: personalId,
      title: 'Dentist',
      startsAt: nine,
      endsAt: new Date(Date.parse(nine) + 3600_000).toISOString(),
      createdBy: userId,
    });
    const out = await composeReply(db, userId, await thread(), { instruction: SUGGEST_TIMES });
    console.log(`[live] busy on ${day}:\n${out!.body}\n`);
    expect(out!.body).toMatch(/not (?:free|available)|unavailable|can't|cannot|won't work|doesn't work|booked|busy|conflict|another commitment|tied up/i);
  }, 60_000);
});
