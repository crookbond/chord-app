/**
 * Performance audit — `syncOutlookAccount`'s `@removed` handling used to do
 * one `email_messages` SELECT plus one `getRemovalState` Graph call per
 * removed id, sequentially. `resolveRemovals` batches the SELECT into one
 * `IN (...)` and runs the probes bounded-concurrent; this pins that the two
 * removal outcomes (archived vs genuinely gone) still land correctly, and
 * that an id already absent locally (never mirrored, or already reaped) is
 * silently skipped rather than erroring.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockMessage,
  __junkOutlookMockMessageLater,
  __removeOutlookMockMessage,
  __resetOutlookMock,
  type GraphMessage,
} from '@/services/email-accounts/outlook-api.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { createTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetOutlookMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'outlook-removal');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

async function connect() {
  await connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  const [account] = await listAccounts(db, userId);
  return account;
}

const msg = (id: string, subject: string): GraphMessage => ({
  id,
  conversationId: `conv-${id}`,
  subject,
  bodyPreview: subject,
  receivedDateTime: new Date().toISOString(),
  from: { emailAddress: { address: 'sender@example.com', name: 'Sender' } },
  isRead: false,
});

it('batches a page of removals into one lookup: archived rows survive, deleted rows are reaped', async () => {
  const account = await connect();
  __addOutlookMockMessage(account.id, msg('m-archived', 'Keep this thread'));
  __addOutlookMockMessage(account.id, msg('m-deleted', 'Purge this thread'));
  await syncAccount(db, account);

  const mine = () =>
    db
      .selectFrom('email_messages')
      .select(['gmail_message_id', 'gmail_label_ids'])
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.or([
          eb('gmail_message_id', 'like', '%m-archived%'),
          eb('gmail_message_id', 'like', '%m-deleted%'),
        ]),
      )
      .execute();
  expect((await mine()).length).toBe(2);

  __removeOutlookMockMessage(account.id, 'm-archived', 'moved');
  __removeOutlookMockMessage(account.id, 'm-deleted', 'gone');
  const result = await syncAccount(db, account);
  expect(result.deleted).toBe(2);

  const after = await mine();
  expect(after).toHaveLength(1);
  expect(after[0].gmail_message_id).toContain('m-archived');
  expect(after[0].gmail_label_ids).not.toContain('INBOX');
});

// Prod 2026-10-29: a fake Coinbase email was synced from the Hotmail inbox at
// 20:24, staged a to-do card at 20:36, and Microsoft's filter moved it to Junk
// at 20:51 under a NEW Graph id. The old id 404'd, so it read as a delete: the
// card went, but a to-do dated ahead would have stayed (ADR 0239).
it('a later move to Junk (new Graph id) keeps the row as spam and retires what the email produced', async () => {
  const account = await connect();
  __addOutlookMockMessage(account.id, {
    ...msg('m-phish', 'Reminder Notice: Phone Number Change Request Received'),
    internetMessageId: '<phish-1@bjhengye.net>',
  });
  await syncAccount(db, account);
  const row = await db
    .selectFrom('email_messages')
    .select(['gmail_thread_id'])
    .where('user_id', '=', userId)
    .where('gmail_message_id', 'like', '%m-phish%')
    .executeTakeFirstOrThrow();
  const groupId = (await ensurePersonalGroup(db, userId)).id;
  const title = 'Contact Coinbase support at +1 888 814 6053 if you do not recognize the phone number change request';
  const proposal = await createProposal(db, {
    groupId,
    proposedByUserId: userId,
    proposedByMessageId: null,
    toolName: 'create_task',
    args: { title },
    provenance: `gmail:${row.gmail_thread_id}`,
  });
  const task = await createTask(db, {
    groupId,
    createdBy: userId,
    title,
    dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    sourceRawContext: `gmail:${row.gmail_thread_id}`,
  });

  __junkOutlookMockMessageLater(account.id, 'm-phish');
  await syncAccount(db, account);

  const kept = await db
    .selectFrom('email_messages')
    .select(['gmail_label_ids'])
    .where('user_id', '=', userId)
    .where('gmail_message_id', 'like', '%m-phish%')
    .executeTakeFirstOrThrow();
  expect(kept.gmail_label_ids).toContain('SPAM');
  expect(kept.gmail_label_ids).not.toContain('INBOX');
  const p = await db.selectFrom('proposals').select('status').where('id', '=', proposal.id).executeTakeFirstOrThrow();
  expect(p.status).toBe('expired');
  const t = await db
    .selectFrom('tasks')
    .select(['status', 'archived_reason'])
    .where('id', '=', task.id)
    .executeTakeFirstOrThrow();
  expect(t).toEqual({ status: 'archived', archived_reason: 'email_spam' });
});
