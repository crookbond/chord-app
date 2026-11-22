/**
 * ADR 0337 - "Point by point" hands the writer the points of the message
 * being answered, in order, read in code; any other instruction adds nothing.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { __addOutlookMockMessage, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { composeReply } from '@/services/email/compose-reply.service.js';
import { POINT_BY_POINT_ASK } from '@chord/kernel';
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetOutlookMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'pointer');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

function fakeLlm() {
  const seen: LlmMessage[][] = [];
  const llm = {
    providerName: 'mock',
    defaultModel: 'fake-model',
    async complete(messages: LlmMessage[]) {
      seen.push(messages);
      return 'Hi Priya,\n\nDriving: yes.\n\nThanks';
    },
  } as unknown as LlmService;
  return { llm, seen };
}

async function carpoolThread(): Promise<string> {
  await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
  const [account] = await listAccounts(db, userId);
  __addOutlookMockMessage(account.id, {
    id: 'm-carpool',
    conversationId: 'conv-carpool',
    subject: 'Spring carpool',
    bodyPreview: 'A few questions',
    receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
    from: { emailAddress: { address: 'priya@example.com', name: 'Priya' } },
    toRecipients: [{ emailAddress: { address: 'ownertest@hotmail.com' } }],
    isRead: false,
    body: {
      contentType: 'text',
      content:
        'Hi! How are you?\nCan you drive on Tuesdays this spring? Does Ben still need a booster seat?\nAre you OK splitting gas?\nThanks, Priya',
    },
  });
  await syncAccount(db, account);
  const t = await db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('subject', '=', 'Spring carpool')
    .executeTakeFirstOrThrow();
  return t.id;
}

it('gives the writer each point of the email, in order, for the Point by point chip', async () => {
  const threadId = await carpoolThread();
  const { llm, seen } = fakeLlm();
  await composeReply(db, userId, threadId, { instruction: POINT_BY_POINT_ASK.ask, draft: 'Hi Priya, sure!', llm });
  const prompt = seen[0][1].content as string;
  expect(prompt).toContain('answer point by point');
  const a = prompt.indexOf('1. Can you drive on Tuesdays this spring?');
  const b = prompt.indexOf('2. Does Ben still need a booster seat?');
  const c = prompt.indexOf('3. Are you OK splitting gas?');
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  expect(c).toBeGreaterThan(b);
  expect(prompt).not.toContain('. How are you?');
});

it('adds nothing for a style change', async () => {
  const threadId = await carpoolThread();
  const { llm, seen } = fakeLlm();
  await composeReply(db, userId, threadId, { instruction: 'Make it longer and more complete', llm });
  expect(seen[0][1].content as string).not.toContain('point by point');
});
