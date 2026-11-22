/**
 * A scheduler's list of windows is read on its own clock, and the earliest
 * free one is offered (ADR 0244 addendum).
 *
 * The recording, 5 November 2026: Omar's assistant offered windows on 11/10,
 * 11/12, 11/13, 11/16, 11/17 and 11/18, all "PT", to John in New York. The
 * Suggested reply went for 11/12 and skipped 11/10. The drafter had checked
 * 11/10 at 10:30 AM on John's clock (the window is 1:30–3:00 PM there) for
 * one hour, dropped every window after the third, and gave the model no rule
 * for choosing among several.
 *
 * Dates are relative to today so the test does not rot; the shape is the
 * recorded one. The model is faked; what is pinned is what it is TOLD.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { __addOutlookMockMessage, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { composeReply } from '@/services/email/compose-reply.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const NY = 'America/New_York';
const PT = 'America/Los_Angeles';
const SUGGESTED = 'Reply suggesting 2–3 times I am free';

/** The local day `n` days from now in Pacific time. */
const dayAhead = (n: number): string => svWall(new Date(Date.now() + n * 86_400_000), PT).slice(0, 10);
const md = (day: string): string => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/** A Pacific wall time as an instant. */
const pt = (day: string, hhmm: string): number =>
  Date.parse(`${day}T${hhmm}:00${offsetForLocalDatetime(PT, `${day}T${hhmm}:00`)}`);
const nyTime = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' });
const nyDay = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { timeZone: NY, weekday: 'short', month: 'short', day: 'numeric' });

// Same spacing as the recording: 4, 6, 7, 10, 11, 12 days after it was sent.
const D = [4, 6, 7, 10, 11, 12].map(dayAhead);
const OMAR = `Hi John & Capri,

Omar is available at the following times in the next few weeks:

  - ${md(D[0]!)}: 10:30 AM – 12:00 PM PT
  - ${md(D[1]!)}: 3:00 PM – 5:00 PM PT
  - ${md(D[2]!)}: 8:00 AM – 12:00 PM PT
  - ${md(D[3]!)}: 8:00 AM – 9:30 AM PT, 1:00 PM – 2:00 PM PT
  - ${md(D[4]!)}: 8:00 AM – 10:00 AM PT, 2:00 PM – 4:00 PM PT
  - ${md(D[5]!)}: 10:30 AM – 12:00 PM PT, 1:00 PM – 2:00 PM PT

Please let me know what works best for you both, and I will send over a calendar invitation.`;

async function setup(db: Kysely<DB>, name: string) {
  const userId = await createUser(db, name);
  await db
    .updateTable('users')
    .set({ last_tz: NY, display_name: 'John Doe', first_name: 'John' })
    .where('id', '=', userId)
    .execute();
  const personalId = (await ensurePersonalGroup(db, userId)).id;
  await upsertCalendarSource(db, userId, {
    googleCalendarId: 'primary@cal',
    summary: 'Me',
    accessRole: 'owner',
    isPrimary: true,
    selectedInGoogle: true,
    isChordTarget: true,
  });
  // John's morning on the first day: 10:30–11:30 AM New York, which is NOT
  // inside Omar's window (1:30–3:00 PM New York) but IS the 10:30 the old
  // check read on John's clock.
  const morning = `${D[0]}T10:30:00${offsetForLocalDatetime(NY, `${D[0]}T10:30:00`)}`;
  await createEvent(db, {
    groupId: personalId,
    title: 'Standup',
    startsAt: morning,
    endsAt: new Date(Date.parse(morning) + 3600_000).toISOString(),
    createdBy: userId,
  });
  await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
  const [account] = await listAccounts(db, userId);
  __addOutlookMockMessage(account.id, {
    id: 'm-omar',
    conversationId: 'conv-omar',
    subject: 'Meeting with Omar',
    bodyPreview: OMAR.slice(0, 200),
    receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
    from: { emailAddress: { address: 'assistant@example-vc.com', name: 'Omar Assistant' } },
    toRecipients: [{ emailAddress: { address: 'owner.alumni@alumni.example.edu' } }],
    isRead: false,
    body: { contentType: 'text', content: OMAR },
  });
  await syncAccount(db, account);
  const threadId = (
    await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .where('subject', '=', 'Meeting with Omar')
      .executeTakeFirstOrThrow()
  ).id;
  return { userId, threadId };
}

describe('the reply drafter, offered several windows in another zone', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    db = await openTestDb();
  });
  afterEach(async () => {
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    await closeTestDb(db);
  });

  it('checks the first window on Omar\'s clock, so the user\'s morning does not make it busy', async () => {
    const { userId, threadId } = await setup(db, 'omar-windows');
    const seen: LlmMessage[][] = [];
    const llm = {
      providerName: 'mock',
      defaultModel: 'fake-model',
      async complete(messages: LlmMessage[]) {
        seen.push(messages);
        return 'Hi Omar,\n\nThe first one works.\n\nThanks,\nJohn';
      },
    } as unknown as LlmService;

    await composeReply(db, userId, threadId, { instruction: SUGGESTED, llm });
    const [system, user] = seen[0]!;
    const prompt = user!.content as string;

    const start = pt(D[0]!, '10:30');
    const end = pt(D[0]!, '12:00');
    expect(prompt).toContain(
      `${nyDay(start)} ${nyTime(start)}–${nyTime(end)} (written as 10:30 AM–12:00 PM P`,
    );
    expect(prompt).toContain(`${nyTime(start)}–${nyTime(end)}`);
    const first = prompt.split('\n').find((l) => l.startsWith(`${nyDay(start)} ${nyTime(start)}`))!;
    expect(first).toContain(': FREE');
    expect(prompt).not.toContain(`${nyDay(start)} at 10:30 AM: BUSY`);

    // Every window was checked, not just the first three, earliest first.
    const last = pt(D[5]!, '13:00');
    expect(prompt).toContain(`${nyDay(last)} ${nyTime(last)}–`);
    const block = prompt.split('Times asked about')[1]!.split('\n\n')[0]!;
    expect(block.split('\n').filter((l) => / (?:FREE|BUSY|PARTLY FREE)/.test(l))).toHaveLength(9);

    // And the model is told how to choose among them.
    expect(prompt).toContain('offer the EARLIEST one that is FREE');
    expect(system!.content).toContain('When the sender OFFERS several times or windows');
  });

  it('a meeting inside a window leaves the rest of it free, not the whole window busy', async () => {
    const { userId, threadId } = await setup(db, 'omar-partly');
    const personalId = (await ensurePersonalGroup(db, userId)).id;
    // 1:30–2:00 PM New York on day one, inside Omar's 1:30–3:00.
    const s = pt(D[0]!, '10:30');
    await createEvent(db, {
      groupId: personalId,
      title: 'Call',
      startsAt: new Date(s).toISOString(),
      endsAt: new Date(s + 30 * 60_000).toISOString(),
      createdBy: userId,
    });
    const seen: LlmMessage[][] = [];
    const llm = {
      providerName: 'mock',
      defaultModel: 'fake-model',
      async complete(messages: LlmMessage[]) {
        seen.push(messages);
        return 'ok';
      },
    } as unknown as LlmService;
    await composeReply(db, userId, threadId, { instruction: SUGGESTED, llm });
    const prompt = seen[0]![1]!.content as string;
    const line = prompt.split('\n').find((l) => l.startsWith(`${nyDay(s)} ${nyTime(s)}`))!;
    expect(line).toContain(`PARTLY FREE (free ${nyTime(s + 30 * 60_000)}–${nyTime(pt(D[0]!, '12:00'))}`);
  });
});

/** Against a real model. Skipped unless MAGICS_LIVE=1 and a key is set. */
const live = process.env.MAGICS_LIVE === '1' && !!env.OPENAI_API_KEY;
describe.skipIf(!live)('the reply drafter, offered windows, live model', () => {
  let db: Kysely<DB>;
  const provider = env.LLM_PROVIDER;
  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'openai';
    __resetLlmCacheForTests();
    db = await openTestDb();
  });
  afterEach(async () => {
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = provider;
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  it('offers the first window, on both clocks', async () => {
    const { userId, threadId } = await setup(db, 'omar-live');
    const out = await composeReply(db, userId, threadId, { instruction: SUGGESTED });
    console.log(`[live] Omar windows:\n${out!.body}\n`);
    const start = pt(D[0]!, '10:30');
    const day = String(Number(D[0]!.slice(8, 10)));
    expect(out!.body).toMatch(new RegExp(`\\b${day}\\b`));
    // 1:30 (New York), not 3:00 on the second day.
    expect(out!.body).toContain(nyTime(start).split(/\s/)[0]!);
  }, 60_000);
});
