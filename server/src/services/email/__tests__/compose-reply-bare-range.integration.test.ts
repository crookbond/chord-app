/**
 * "Free tomorrow from 10-1" is checked against the calendar.
 *
 * The recording, 17 November 2026: Rob wrote "I am mostly free tomorrow from
 * 10-1. Anything work for you?". John had a meeting 12:00-12:50 that day,
 * and the Suggested reply said "I am also free 10-1". Neither end of "10-1"
 * said AM or PM, so no window was read, no verdict was computed, and the
 * model was left to compare the range against the day line itself.
 *
 * The model is faked; what is pinned is what it is TOLD.
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
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const NY = 'America/New_York';
const ROB = 'Hi John,\nI am mostly free tomorrow from 10-1. Anything work for you?\n\nBest\nRob';

describe('the reply drafter, offered "tomorrow from 10-1"', () => {
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

  it('says the window is only partly free when a meeting sits inside it', async () => {
    const userId = await createUser(db, 'rob-bare-range');
    await db.updateTable('users').set({ last_tz: NY, first_name: 'John' }).where('id', '=', userId).execute();
    const personalId = (await ensurePersonalGroup(db, userId)).id;
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });

    const sentMs = Date.now() - 3600_000;
    const sentDay = svWall(new Date(sentMs), NY).slice(0, 10);
    const tomorrow = new Date(Date.parse(`${sentDay}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const noon = `${tomorrow}T12:00:00${offsetForLocalDatetime(NY, `${tomorrow}T12:00:00`)}`;
    await createEvent(db, {
      groupId: personalId,
      title: 'Lunch meeting',
      startsAt: noon,
      endsAt: new Date(Date.parse(noon) + 50 * 60_000).toISOString(),
      createdBy: userId,
    });

    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    __addOutlookMockMessage(account.id, {
      id: 'm-rob',
      conversationId: 'conv-rob',
      subject: 'Catch up',
      bodyPreview: ROB,
      receivedDateTime: new Date(sentMs).toISOString(),
      from: { emailAddress: { address: 'rob@example.com', name: 'Rob' } },
      toRecipients: [{ emailAddress: { address: 'john@example.com' } }],
      isRead: false,
      body: { contentType: 'text', content: ROB },
    });
    await syncAccount(db, account);
    const threadId = (
      await db
        .selectFrom('email_threads')
        .select('id')
        .where('user_id', '=', userId)
        .where('subject', '=', 'Catch up')
        .executeTakeFirstOrThrow()
    ).id;

    const seen: LlmMessage[][] = [];
    const llm = {
      providerName: 'mock',
      defaultModel: 'fake-model',
      async complete(messages: LlmMessage[]) {
        seen.push(messages);
        return 'ok';
      },
    } as unknown as LlmService;
    await composeReply(db, userId, threadId, { instruction: 'Reply suggesting 2–3 times I am free', llm });

    const prompt = seen[0]![1]!.content as string;
    const line = prompt.split('\n').find((l) => / 10:00 AM–1:00 PM/.test(l) && /FREE|BUSY/.test(l));
    expect(line).toBeDefined();
    expect(line).toContain('PARTLY FREE (free 10:00 AM–12:00 PM');
    expect(line).toContain('12:00 PM–12:50 PM is taken');
  });
});
