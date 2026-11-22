/**
 * ADR 0074 on the read-time pass (ADR 0180/0219). Prod, Nov 2026: Tom
 * Kelly's Outlook invite "Tom/John on Billing & SMB" was 12:30 PM Eastern,
 * but its body has no time at all - Outlook keeps the time on the meeting
 * object. The read-time pass (opening the email, or the warm-up after sync)
 * ran the model with no invite check, the model filled in midnight, and when
 * the sweep later read the invite properly it found the thread already had a
 * card and staged nothing. The user saw a midnight suggestion for a 12:30
 * meeting.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  runEmailMagics,
  runReadTimeEmailMagics,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import { __resetOutlookMock, __setOutlookMockMeeting } from '@/services/email-accounts/outlook-api.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/** Relative, so the meeting never drifts into the past (ADR 0100). */
const MEETING_DAY = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
const SUBJECT = 'Tom/John on Billing & SMB';
const BODY =
  "Hi John, Ash mentioned connecting on a billing project you're working on, and we " +
  'discussed also connecting on SMB, so I set up some time for us to kick it off.\n\n' +
  'Microsoft Teams meeting\nJoin: https://teams.microsoft.com/l/meetup-join/abc';

/** What the model did in prod: a date, no time, so midnight local. */
const midnightGuess: EmailExtractor = {
  async extract() {
    return { kind: 'event', title: SUBJECT, startsAt: `${MEETING_DAY}T00:00:00-05:00` };
  },
};

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'read-time-invite');
  await ensurePersonalGroup(db, userId);
  await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', userId).execute();
  __resetOutlookMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
});
afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

async function seedOutlookInvite(opts: { classified?: boolean } = {}) {
  const now = new Date().toISOString();
  const accountId = newId('ema');
  await db
    .insertInto('email_accounts')
    .values({
      id: accountId,
      user_id: userId,
      provider: 'outlook',
      email_address: 'john@neuralads.example',
      display_name: null,
      preset_key: null,
      auth_ciphertext: null,
      auth_iv: null,
      auth_tag: null,
      sync_cursor: null,
      synced_at: null,
      backfill_done: 1,
      status: 'ok',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const gid = `${accountId}:conv-billing`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      account_id: accountId,
      gmail_thread_id: gid,
      subject: SUBJECT,
      snippet: BODY.slice(0, 80),
      from_email: 'tom@neuralads.example',
      from_name: 'Tom Kent',
      last_message_at: now,
      is_unread: 1,
      is_archived: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      account_id: accountId,
      thread_id: threadId,
      gmail_message_id: `${accountId}:m-billing`,
      gmail_thread_id: gid,
      from_name: 'Tom Kent',
      from_email: 'tom@neuralads.example',
      to_emails: JSON.stringify(['john@neuralads.example']),
      cc_emails: JSON.stringify([]),
      subject: SUBJECT,
      snippet: BODY.slice(0, 80),
      body_text: BODY,
      body_html: null,
      internal_date: now,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
      created_at: now,
    })
    .execute();
  if (opts.classified) {
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'work', parentId: null, title: 'Work', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'work' }],
    });
  }
  return { accountId, gid, threadId };
}

function meetMock(accountId: string) {
  // 12:30 PM Eastern (EST) is 17:30 UTC.
  __setOutlookMockMeeting(accountId, 'm-billing', {
    meetingMessageType: 'meetingRequest',
    event: {
      iCalUId: 'uid-billing-smb',
      subject: SUBJECT,
      start: { dateTime: `${MEETING_DAY}T17:30:00.0000000`, timeZone: 'UTC' },
      end: { dateTime: `${MEETING_DAY}T18:00:00.0000000`, timeZone: 'UTC' },
      location: { displayName: 'Microsoft Teams Meeting' },
      isAllDay: false,
    },
  });
}

async function pendingCards() {
  const rows = await db
    .selectFrom('proposals')
    .select(['tool_name', 'args_json', 'status'])
    .where('status', '=', 'pending')
    .execute();
  return rows.map((r) => ({ ...r, args: JSON.parse(r.args_json) as Record<string, unknown> }));
}

describe('read-time pass reads an invite the way the sweep does (ADR 0074)', () => {
  it('opening an unsorted Outlook invite stages the meeting at its real time, not the model guess', async () => {
    const { accountId, threadId } = await seedOutlookInvite();
    meetMock(accountId);

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: midnightGuess });

    const cards = await pendingCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.tool_name).toBe('create_event');
    expect(cards[0]!.args.externalUid).toBe('uid-billing-smb');
    expect(new Date(String(cards[0]!.args.startsAt)).toISOString()).toBe(`${MEETING_DAY}T17:30:00.000Z`);
  });

  it('the sweep replaces a model card left on the same invite thread', async () => {
    // The state already in prod: the read-time pass staged the midnight card
    // before this fix. The sweep's invite read must now win, not skip.
    const { accountId, threadId } = await seedOutlookInvite({ classified: true });
    // No meeting on the mock yet: the probe says "not an invite", so the old
    // read-time behaviour stages the model's card.
    await runReadTimeEmailMagics(db, userId, threadId, { extractor: midnightGuess });
    expect((await pendingCards())[0]?.args.externalUid).toBeUndefined();
    // Before ADR 0329 the read-time pass wrote only its `read` mark.
    await db.deleteFrom('email_extraction_marks').where('user_id', '=', userId).where('kind', '=', 'magic').execute();

    meetMock(accountId);
    await runEmailMagics(db, userId, { extractor: midnightGuess });

    const cards = await pendingCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.args.externalUid).toBe('uid-billing-smb');
    expect(new Date(String(cards[0]!.args.startsAt)).toISOString()).toBe(`${MEETING_DAY}T17:30:00.000Z`);
  });

  it('runs no model and keeps the email unread-checked until the user agrees to AI (ADR 0283)', async () => {
    const { gid, threadId } = await seedOutlookInvite();
    let calls = 0;
    const counting: EmailExtractor = { async extract() { calls += 1; return null; } };
    const was = env.AI_CONSENT_REQUIRED;
    (env as { AI_CONSENT_REQUIRED: boolean }).AI_CONSENT_REQUIRED = true;
    try {
      await runReadTimeEmailMagics(db, userId, threadId, { extractor: counting });
    } finally {
      (env as { AI_CONSENT_REQUIRED: boolean }).AI_CONSENT_REQUIRED = was;
    }
    expect(calls).toBe(0);
    const mark = await db
      .selectFrom('email_extraction_marks')
      .select('kind')
      .where('gmail_thread_id', '=', gid)
      .where('kind', '=', 'read')
      .executeTakeFirst();
    expect(mark).toBeUndefined();
  });

  it('runs no model for a user with no allowance left (ADR 0079/0325)', async () => {
    const { threadId } = await seedOutlookInvite();
    let calls = 0;
    const counting: EmailExtractor = { async extract() { calls += 1; return null; } };
    const e = env as { BILLING_ENABLED: boolean; FREE_TOKEN_ALLOWANCE: number };
    const was = { billing: e.BILLING_ENABLED, free: e.FREE_TOKEN_ALLOWANCE };
    e.BILLING_ENABLED = true;
    e.FREE_TOKEN_ALLOWANCE = 0;
    try {
      await runReadTimeEmailMagics(db, userId, threadId, { extractor: counting });
    } finally {
      e.BILLING_ENABLED = was.billing;
      e.FREE_TOKEN_ALLOWANCE = was.free;
    }
    expect(calls).toBe(0);
  });

  it('a failed invite check stages nothing and leaves the email to be read again', async () => {
    const { accountId, gid, threadId } = await seedOutlookInvite();
    __setOutlookMockMeeting(accountId, 'm-billing', new Error('graph meeting info 503'));

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: midnightGuess });

    expect(await pendingCards()).toHaveLength(0);
    const mark = await db
      .selectFrom('email_extraction_marks')
      .select('kind')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .where('kind', '=', 'read')
      .executeTakeFirst();
    expect(mark).toBeUndefined();
  });
});
