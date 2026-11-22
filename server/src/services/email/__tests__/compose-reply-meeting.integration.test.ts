/**
 * ADR 0346 phase 6 - the reply drafter is told about the meeting the thread
 * is arranging, and does not treat that meeting's own hold as busy.
 *
 * Shape from the planning thread: Rob agreed noon tomorrow and said he would
 * send the invite. A follow-up drafted in that thread must not offer to send
 * one, and must not decline noon because Chord is holding noon for Rob.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchedulingBlock } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { busyIntervalsInWindow } from '@/services/conflicts.service.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { __addOutlookMockMessage, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { composeReply } from '@/services/email/compose-reply.service.js';
import { recordMeetingFromEmail } from '@/services/email/meetings.service.js';
import { finishScheduling } from '@/services/email/scheduling-block.js';
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import { svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const NY = 'America/New_York';
const ME = 'john@example.com';
const ROB = 'rob@acme.com';
const BODY = 'Hi John,\nNoon tomorrow works. I will send an invite.\n\nRob';

describe('the reply drafter in a meeting thread', () => {
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

  it('is told Rob sends the invite, and sees noon as free despite the hold', async () => {
    const userId = await createUser(db, 'john-meeting');
    await db.updateTable('users').set({ last_tz: NY, first_name: 'John', email: ME }).where('id', '=', userId).execute();
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    const sentMs = Date.now() - 3600_000;
    __addOutlookMockMessage(account.id, {
      id: 'm-rob-agree',
      conversationId: 'conv-rob-agree',
      subject: 'Catch up',
      bodyPreview: BODY,
      receivedDateTime: new Date(sentMs).toISOString(),
      from: { emailAddress: { address: ROB, name: 'Rob' } },
      toRecipients: [{ emailAddress: { address: ME } }],
      isRead: false,
      body: { contentType: 'text', content: BODY },
    });
    await syncAccount(db, account);
    const thread = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .where('subject', '=', 'Catch up')
      .executeTakeFirstOrThrow();
    const sentDay = svWall(new Date(sentMs), NY).slice(0, 10);
    const facts = finishScheduling(
      readSchedulingBlock({ act: 'agree', agreed: 'tomorrow at noon', inviteBy: 'them', inviteEvidence: 'I will send an invite', title: 'Catch up with Rob' })!,
      { bodyText: BODY, fromEmail: ROB, fromName: 'Rob', toEmails: [ME], ccEmails: [], sentDay },
      [ME],
    );
    const key = `gmail:${thread.gmail_thread_id}`;
    const m = await recordMeetingFromEmail(db, userId, key, facts, 'them', {
      tz: NY,
      own: [ME],
      people: { fromEmail: ROB, toEmails: [ME], ccEmails: [] },
    });
    expect(m).toMatchObject({ state: 'agreed', invite_by: 'them' });
    // The hold is busy everywhere else.
    const noon = Date.parse(m!.agreed_start!);
    const elsewhere = await busyIntervalsInWindow(db, {
      userId,
      startIso: new Date(noon - 3600_000).toISOString(),
      endIso: new Date(noon + 2 * 3600_000).toISOString(),
    });
    expect(elsewhere.intervals).toHaveLength(1);

    const seen: LlmMessage[][] = [];
    const llm = {
      providerName: 'mock',
      defaultModel: 'fake-model',
      async complete(messages: LlmMessage[]) {
        seen.push(messages);
        return 'ok';
      },
    } as unknown as LlmService;
    await composeReply(db, userId, thread.id, { instruction: 'Reply confirming', llm });
    const prompt = seen[0]![1]!.content as string;
    expect(prompt).toContain('THEY will send the calendar invite');
    expect(prompt).toContain('A time is already agreed');
    // Noon is not listed as busy in Rob's own thread.
    expect(prompt).not.toMatch(/busy[^\n]*12:00 PM/);
  });
});
