/**
 * ADR 0294 addendum — no suggestions from a sender the code check calls
 * dangerous.
 *
 * Prod 2026-10-28: "RE : Your Primary Contact Number Update Is Pending
 * Review" from "Robinhood Email Alerts" <gv@usdigitize.com>, the name written
 * with a Cyrillic о. The reader warned about the name, and the same screen
 * offered a "Call support at 1 866 465-0148" to-do: the phisher's own number,
 * turned into a task from Chord. Two causes: the brand check matched the name
 * letter for letter (so the Cyrillic о hid the Robinhood claim and only a
 * caution fired), and no pass that stages suggestions looked at the check.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, runReadTimeEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { runPersonExtraction, type PersonExtractor } from '@/services/email/person-extraction.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// "Robinhood Email Alerts" with a Cyrillic о (U+043E), as received.
const PHISH_NAME = 'Rоbinhood Email Alerts';
const PHISH_FROM = 'gv@usdigitize.com';
const SUBJECT = 'RE : Your Primary Contact Number Update Is Pending Review';
const BODY = [
  'Hello There,',
  'Your request to change phone number on your account is now pending review.',
  "Your existing phone number remains active while we review the request. If you submitted it, there's nothing you need to do right now. We'll let you know once the review is complete.",
  "If you don't recognize this request, please call our support team at 1 866 465-0148.",
].join('\n\n');

let db: Kysely<DB>;
let userId: string;
let calls: number;

const callSupport: EmailExtractor = {
  async extract() {
    calls += 1;
    return { kind: 'task', title: "Call support at 1 866 465-0148 if you don't recognize the phone number change request" };
  },
};

beforeEach(async () => {
  db = await openTestDb();
  __resetGmailMock();
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
  calls = 0;
  userId = await createUser(db, 'phish-user');
  await db.updateTable('users').set({ email: 'ownertest@gmail.com' }).where('id', '=', userId).execute();
  await ensurePersonalGroup(db, userId);
});
afterEach(async () => {
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

async function seed(from: { name: string; email: string }): Promise<{ threadId: string; gid: string }> {
  const at = new Date().toISOString();
  const gid = `t_${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: SUBJECT,
      snippet: BODY.slice(0, 80),
      from_email: from.email,
      from_name: from.name,
      last_message_at: at,
      is_unread: 1,
      is_archived: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: `m_${gid}`,
      gmail_thread_id: gid,
      from_name: from.name,
      from_email: from.email,
      to_emails: JSON.stringify(['ownertest@gmail.com']),
      cc_emails: JSON.stringify([]),
      subject: SUBJECT,
      snippet: BODY.slice(0, 80),
      body_text: BODY,
      body_html: null,
      internal_date: at,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
      created_at: at,
    })
    .execute();
  __addGmailMockMessage(userId, {
    id: `m_${gid}`,
    threadId: gid,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: BODY.slice(0, 80),
    internalDate: String(Date.parse(at)),
    historyId: '1',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: SUBJECT }],
      body: { size: BODY.length, data: Buffer.from(BODY).toString('base64url') },
    },
  });
  await ingestClassification(db, userId, {
    version: 1,
    userId,
    categories: [{ id: 'mk:finance/alerts', parentId: null, title: 'Account alerts', depth: 0 }],
    assignments: [{ gmailThreadId: gid, categoryId: 'mk:finance/alerts' }],
  });
  return { threadId, gid };
}

const pending = async (gid: string) =>
  db
    .selectFrom('proposals')
    .select('tool_name')
    .where('proposed_by_user_id', '=', userId)
    .where('provenance', '=', `gmail:${gid}`)
    .where('status', '=', 'pending')
    .execute();

describe('no suggestions from a dangerous sender', () => {
  it('opening the phishing email stages no to-do and withdraws one already staged', async () => {
    const { threadId, gid } = await seed({ name: PHISH_NAME, email: PHISH_FROM });
    const personal = await ensurePersonalGroup(db, userId);
    // The card the background sweep had already staged before the open.
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Call support at 1 866 465-0148' },
      provenance: `gmail:${gid}`,
      targetGroupId: null,
    });

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: callSupport });

    expect(calls).toBe(0);
    expect(await pending(gid)).toEqual([]);
  });

  it('the background sweep stages nothing from it either', async () => {
    const { gid } = await seed({ name: PHISH_NAME, email: PHISH_FROM });
    await runEmailMagics(db, userId, { extractor: callSupport });
    expect(calls).toBe(0);
    expect(await pending(gid)).toEqual([]);
  });

  it('person extraction learns nothing from it, but still reads ordinary mail', async () => {
    await seed({ name: PHISH_NAME, email: PHISH_FROM });
    await seed({ name: 'Ruth Chen', email: 'ruth.chen@example.com' });
    const asked: string[] = [];
    const extractor: PersonExtractor = {
      async extract(input) {
        asked.push(input.fromEmail ?? '');
        return [];
      },
    };
    await runPersonExtraction(db, userId, { extractor });
    expect(asked).toEqual(['ruth.chen@example.com']);
  });

  it('an ordinary sender still gets its suggestion', async () => {
    const { threadId, gid } = await seed({ name: 'Ruth Chen', email: 'ruth.chen@example.com' });
    await runReadTimeEmailMagics(db, userId, threadId, { extractor: callSupport });
    expect(calls).toBe(1);
    expect((await pending(gid)).map((p) => p.tool_name)).toEqual(['create_task']);
  });
});
