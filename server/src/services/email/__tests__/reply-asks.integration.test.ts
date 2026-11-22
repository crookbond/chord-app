/**
 * ADR 0197 addendum — the reply ask bar's chips come from the email being
 * answered, not a fixed four. The model is faked; what is pinned is that it
 * is shown the email, that only usable chips come back, that a repeat does
 * not pay twice, and that unusable output is a failure (the app falls back).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockMessage,
  __outlookMockGetMessageCount,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import { ComposeFailedError } from '@/services/email/compose-reply.service.js';
import {
  __clearReplyAsksCacheForTests,
  parseReplyAsks,
  suggestReplyAsks,
} from '@/services/email/reply-asks.service.js';
import type { LlmMessage, LlmService } from '@/services/llm/types.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetOutlookMock();
  __clearReplyAsksCacheForTests();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'reader');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

function fakeLlm(reply: string) {
  const seen: LlmMessage[][] = [];
  const llm = {
    providerName: 'mock',
    defaultModel: 'fake-model',
    async complete(
      messages: LlmMessage[],
      opts?: { onUsage?: (u: { promptTokens: number; completionTokens: number }) => void },
    ) {
      seen.push(messages);
      opts?.onUsage?.({ promptTokens: 500, completionTokens: 60 });
      return reply;
    },
  } as unknown as LlmService;
  return { llm, seen };
}

const SUBJECT = 'Carpool to the Saturday soccer game?';

async function carpoolThread(): Promise<string> {
  await connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  const [account] = await listAccounts(db, userId);
  __addOutlookMockMessage(account.id, {
    id: 'm-carpool-1',
    conversationId: 'conv-carpool',
    subject: SUBJECT,
    bodyPreview: 'Could you drive the kids Saturday at 9?',
    receivedDateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
    from: { emailAddress: { address: 'priya@example.com', name: 'Priya' } },
    toRecipients: [{ emailAddress: { address: 'ownertest@hotmail.com' } }],
    isRead: false,
    body: { contentType: 'text', content: 'Could you drive the kids to the soccer game Saturday at 9? I can do pickup.' },
  });
  await syncAccount(db, account);
  const t = await db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('subject', '=', SUBJECT)
    .executeTakeFirstOrThrow();
  return t.id;
}

const CHIPS = JSON.stringify([
  { label: 'Yes, I can drive', ask: 'Reply agreeing to drive the kids Saturday at 9' },
  { label: "Can't Saturday", ask: 'Reply saying I cannot drive Saturday and asking about pickup instead' },
  { label: 'Ask where to meet', ask: 'Reply asking where to meet the kids' },
]);

it('shows the model the email and returns chips about it, metered as email_reply', async () => {
  const threadId = await carpoolThread();
  const { llm, seen } = fakeLlm('```json\n' + CHIPS + '\n```');

  const out = await suggestReplyAsks(db, userId, threadId, { llm });

  expect(out?.asks.map((a) => a.label)).toEqual(['Yes, I can drive', "Can't Saturday", 'Ask where to meet']);
  const prompt = seen[0][1].content as string;
  expect(prompt).toContain('soccer game Saturday at 9');
  expect(prompt).toContain('<email_thread');
  const usage = await db.selectFrom('token_usage').select(['source', 'ref']).where('user_id', '=', userId).execute();
  expect(usage).toEqual([{ source: 'email_reply', ref: threadId }]);
});

it('does not pay twice for the same email', async () => {
  const threadId = await carpoolThread();
  const { llm, seen } = fakeLlm(CHIPS);
  await suggestReplyAsks(db, userId, threadId, { llm });
  await suggestReplyAsks(db, userId, threadId, { llm });
  expect(seen).toHaveLength(1);
});

it('answers a repeat from the cache without reading the mailbox again', async () => {
  const threadId = await carpoolThread();
  const { llm } = fakeLlm(CHIPS);
  await suggestReplyAsks(db, userId, threadId, { llm });
  // A message whose parts are not mirrored yet is fetched from Graph on
  // every thread read; the cached chips must not cost that fetch.
  await db.updateTable('email_messages').set({ attachments_json: null }).where('thread_id', '=', threadId).execute();
  const reads = __outlookMockGetMessageCount();

  const again = await suggestReplyAsks(db, userId, threadId, { llm });

  expect(again?.asks).toHaveLength(3);
  expect(__outlookMockGetMessageCount()).toBe(reads);
});

it('treats output with no usable chip as a failure, so the app keeps its fixed ones', async () => {
  const threadId = await carpoolThread();
  const { llm } = fakeLlm('Sure! Here are some ideas: say yes, say no.');
  await expect(suggestReplyAsks(db, userId, threadId, { llm })).rejects.toBeInstanceOf(ComposeFailedError);
});

it('keeps only usable, distinct chips, at most four', () => {
  const raw = JSON.stringify([
    { label: 'Yes.', ask: 'Reply yes' },
    { label: 'yes', ask: 'Reply yes again' },
    { label: '', ask: 'Reply blank' },
    { label: 'No ask' },
    { label: 'A label far too long to fit on a chip at all', ask: 'Reply' },
    { label: 'B', ask: 'Reply B' },
    { label: 'C', ask: 'Reply C' },
    { label: 'D', ask: 'Reply D' },
    { label: 'E', ask: 'Reply E' },
  ]);
  expect(parseReplyAsks(raw).map((a) => a.label)).toEqual(['Yes', 'B', 'C', 'D']);
  expect(parseReplyAsks('not json')).toEqual([]);
});
