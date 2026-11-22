/**
 * ADR 0346 phase 7 - the reply drafter in a thread where several people
 * offered different times.
 *
 * Rob offered Tuesday 10-1, then Sam (the newest message) offered 11-4; Kim
 * has not answered. The drafter must be handed the times that suit both Rob
 * and Sam, not Sam's whole window, and be told Kim is still due. With two
 * common times the group note must still be what the drafter reads last
 * (the "several times" note used to take that place and hide it).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchedulingBlock } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
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
const SAM = 'sam@acme.com';
const KIM = 'kim@other.org';

/** A Tuesday at least two days out, so "now" never trims the windows. */
function tuesday(): string {
  const d = new Date(Date.parse(`${svWall(new Date(), NY).slice(0, 10)}T12:00:00Z`) + 2 * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('the reply drafter, several people offering times', () => {
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

  async function setup(robWindows: string[], samWindow: string) {
    const userId = await createUser(db, 'john-group');
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
    const sam = `Hi all,\nI can do ${samWindow}.\n\nSam`;
    __addOutlookMockMessage(account.id, {
      id: 'm-sam',
      conversationId: 'conv-group',
      subject: 'Planning sync',
      bodyPreview: sam,
      receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
      from: { emailAddress: { address: SAM, name: 'Sam' } },
      toRecipients: [{ emailAddress: { address: ME } }, { emailAddress: { address: ROB } }, { emailAddress: { address: KIM } }],
      isRead: false,
      body: { contentType: 'text', content: sam },
    });
    await syncAccount(db, account);
    const thread = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .where('subject', '=', 'Planning sync')
      .executeTakeFirstOrThrow();
    const key = `gmail:${thread.gmail_thread_id}`;
    const today = svWall(new Date(), NY).slice(0, 10);
    const say = (from: string, offered: string[]) =>
      recordMeetingFromEmail(
        db,
        userId,
        key,
        finishScheduling(
          readSchedulingBlock({ act: 'offer_slots', offered, title: 'Planning sync' })!,
          { bodyText: '', fromEmail: from, fromName: null, toEmails: [ME, ROB, SAM, KIM].filter((a) => a !== from), ccEmails: [], sentDay: today },
          [ME],
          { askedOfUser: true },
        ),
        'them',
        { tz: NY, own: [ME], people: { fromEmail: from, toEmails: [ME, ROB, SAM, KIM].filter((a) => a !== from), ccEmails: [] } },
      );
    await say(ROB, robWindows);
    await say(SAM, [samWindow]);
    return { userId, threadId: thread.id };
  }

  async function prompt(userId: string, threadId: string): Promise<string> {
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
    return seen[0]![1]!.content as string;
  }

  it('checks the time that suits Rob and Sam, not Sam\'s whole window, and says Kim is due', async () => {
    const tue = tuesday();
    const { userId, threadId } = await setup([`${tue} 10am-1pm`], `${tue} 11am-4pm`);
    const p = await prompt(userId, threadId);
    const asked = p.split('Times asked about')[1]!.split('\n\n')[0]!;
    // 11-1 is the overlap; Sam's 1-4 alone must not be offered as a time.
    expect(asked).toMatch(/11:00 AM–1:00 PM/);
    expect(asked).not.toMatch(/4:00 PM/);
    expect(p).toContain('suit EVERYONE who has answered (Rob, Sam)');
    expect(p).toContain('Still waiting to hear from: Kim');
    // Read last, after the instruction.
    expect(p.lastIndexOf('several people are offering times')).toBeGreaterThan(p.indexOf("The user's instruction"));
  });

  it('with two common times the group note is still the one read last', async () => {
    const tue = tuesday();
    const { userId, threadId } = await setup([`${tue} 10am-1pm`, `${tue} 3-5pm`], `${tue} 11am-4pm`);
    const p = await prompt(userId, threadId);
    const asked = p.split('Times asked about')[1]!.split('\n\n')[0]!;
    expect(asked).toMatch(/11:00 AM–1:00 PM/);
    expect(asked).toMatch(/3:00 PM–4:00 PM/);
    expect(p).toContain('suit EVERYONE who has answered');
    expect(p).not.toContain('the thread offers several times and each verdict is listed above');
  });
});
