/**
 * ADR 0180 — opening a thread runs its own extraction pass, regardless of
 * whether the background sweep's gates (bulk deny-list, discretionary
 * broadcasts, stale-read, unclassified) or its `magic` mark would have
 * skipped it. `runReadTimeEmailMagics` shares `extractAndStage` with
 * `runEmailMagics`, so a suggestion it stages goes through the identical
 * dedup — and it never re-asks the LLM for a thread it already passed
 * (its own `read` extraction mark, independent of `magic`).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  runReadTimeEmailMagics,
  markThreadExtracted,
  type EmailExtractor,
} from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'read-time-user');
  await ensurePersonalGroup(db, userId);
});
afterEach(async () => {
  await closeTestDb(db);
});

/** A thread + its newest message, with no gmail/outlook mocking — the
 *  interactive pass never touches the invite probe or a real provider. */
async function seedThread(opts: {
  subject?: string;
  bodyText: string;
  categoryId?: string | null;
  isUnread?: boolean;
  ageDays?: number;
  bulk?: boolean;
  bulkInferred?: boolean;
  labels?: string[];
  rfc822?: string;
}): Promise<{ threadId: string; gid: string }> {
  const at = daysAgo(opts.ageDays ?? 0);
  const now = new Date().toISOString();
  const gid = `t_${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: opts.subject ?? 'Test subject',
      snippet: opts.bodyText.slice(0, 80),
      from_email: 'sender@example.com',
      category_id: opts.categoryId ?? null,
      last_message_at: at,
      is_unread: opts.isUnread === false ? 0 : 1,
      is_archived: 0,
      bulk: opts.bulk ? 1 : 0,
      bulk_inferred: opts.bulkInferred ? 1 : 0,
      created_at: now,
      updated_at: now,
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
      from_name: null,
      from_email: 'sender@example.com',
      to_emails: JSON.stringify(['me@example.com']),
      cc_emails: JSON.stringify([]),
      subject: opts.subject ?? 'Test subject',
      snippet: opts.bodyText.slice(0, 80),
      body_text: opts.bodyText,
      body_html: null,
      internal_date: at,
      is_unread: opts.isUnread === false ? 0 : 1,
      gmail_label_ids: JSON.stringify(opts.labels ?? ['INBOX']),
      rfc822_message_id: opts.rfc822 ?? null,
      headers_json: JSON.stringify({}),
      // What a Gmail sync stores for a message with no invite (ADR 0080).
      ics_text: '',
      created_at: now,
    })
    .execute();
  return { threadId, gid };
}

const taskStub: EmailExtractor = {
  async extract() {
    return { kind: 'task', title: 'Return the permission slip' };
  },
};

describe('runReadTimeEmailMagics (ADR 0180)', () => {
  it('stages a suggestion for a thread only the stale-mail gate would have excluded', async () => {
    // Read + 30 days old (ADR 0143's stale-mail gate) would keep
    // runEmailMagics away from this thread; opening it runs the pass anyway.
    const { threadId } = await seedThread({
      bodyText: 'Sign and return the permission slip by Friday.',
      isUnread: false,
      ageDays: 30,
    });

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: taskStub });
    expect(res.ranNow).toBe(true);
    expect(res.advisory).toBeNull();

    const prop = await db
      .selectFrom('proposals')
      .select(['tool_name', 'provenance'])
      .executeTakeFirstOrThrow();
    expect(prop.tool_name).toBe('create_task');
  });

  it('ADR 0184 — still mines a thread under a discretionary-broadcast category when opened', async () => {
    // The sweep's category deny-list (ADR 0179 part 3) is a judgment about
    // UNATTENDED mail. Real Junk/Spam needs no carve-out here — it is never
    // mirrored into `email_threads` at all (`junk.service.ts`) — but a
    // promo that escaped the provider's spam filter and reached the inbox,
    // if the user opens it, gets the same interactive pass as anything else.
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'coupons', parentId: null, title: 'Coupons', depth: 0 }],
      assignments: [],
    });
    const cat = await db
      .selectFrom('email_categories')
      .select('id')
      .where('user_id', '=', userId)
      .where('title', '=', 'Coupons')
      .executeTakeFirstOrThrow();
    const { threadId } = await seedThread({
      bodyText: '$4 off, redeem by Sep 16.',
      categoryId: cat.id,
    });

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: taskStub });
    expect(res.ranNow).toBe(true);
    expect(await db.selectFrom('proposals').select('id').execute()).toHaveLength(1);
  });

  it('ADR 0184 — still mines a bulk-flagged thread when opened', async () => {
    const { threadId } = await seedThread({
      bodyText: 'Sign and return the permission slip by Friday.',
      bulk: true,
      bulkInferred: true,
    });

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: taskStub });
    expect(res.ranNow).toBe(true);
    expect(await db.selectFrom('proposals').select('id').execute()).toHaveLength(1);
  });

  it('records an advisory and stages nothing when the message itself is the concern', async () => {
    const advisoryStub: EmailExtractor = {
      async extract() {
        return { kind: 'advisory', note: 'This looks like a phishing attempt — be careful.' };
      },
    };
    const { threadId } = await seedThread({ bodyText: 'Verify your account NOW or it will be closed.' });

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: advisoryStub });
    expect(res.ranNow).toBe(true);
    expect(res.advisory).toEqual({
      note: 'This looks like a phishing attempt — be careful.',
      severity: 'caution',
    });
    expect(await db.selectFrom('proposals').select('id').execute()).toHaveLength(0);

    const row = await db
      .selectFrom('email_threads')
      .select('read_advisory_json')
      .where('id', '=', threadId)
      .executeTakeFirstOrThrow();
    expect(row.read_advisory_json).toEqual({
      note: 'This looks like a phishing attempt — be careful.',
      severity: 'caution',
    });
  });

  it('runs the LLM at most once per thread — a re-open re-serves the stored result', async () => {
    let calls = 0;
    const countingStub: EmailExtractor = {
      async extract() {
        calls += 1;
        return { kind: 'advisory', note: 'Careful with this one.' };
      },
    };
    const { threadId } = await seedThread({ bodyText: 'Some message.' });

    const first = await runReadTimeEmailMagics(db, userId, threadId, { extractor: countingStub });
    expect(first.ranNow).toBe(true);
    expect(calls).toBe(1);

    const second = await runReadTimeEmailMagics(db, userId, threadId, { extractor: countingStub });
    expect(second.ranNow).toBe(false);
    expect(second.advisory).toEqual({ note: 'Careful with this one.', severity: 'caution' });
    expect(calls).toBe(1);
  });

  it('re-serves the background sweep\'s read instead of reading again (ADR 0329)', async () => {
    const { threadId, gid } = await seedThread({ bodyText: 'Sign and return the slip.' });
    // The background sweep already staged this task and marked the thread
    // `magic`. Its read was the email's one read: the open asks no model and
    // stages no twin. (Flipped from ADR 0180's "ignores the magic mark".)
    const personal = await ensurePersonalGroup(db, userId);
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Return the permission slip' },
      provenance: `gmail:${gid}`,
    });
    await markThreadExtracted(db, userId, gid, 'magic', new Date().toISOString());

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: taskStub });
    expect(res.ranNow).toBe(false);
    const props = await db.selectFrom('proposals').select('id').execute();
    expect(props).toHaveLength(1);
  });

  it('opening a Spam or Trash email is the user\'s choice: it is checked like any other (owner, 2026-11-10)', async () => {
    // A first version skipped these. The owner reversed it: someone who opens
    // a Spam or Trash email chose to, and gets the same check as any open.
    for (const labels of [['SPAM'], ['TRASH']]) {
      const { threadId } = await seedThread({ bodyText: 'Sign and return the permission slip by Friday.', labels });
      const extractor: EmailExtractor = { async extract() { return { kind: 'task', title: `Return the ${labels[0]} slip` }; } };
      const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor });
      expect(res.ranNow).toBe(true);
    }
    expect(await db.selectFrom('proposals').selectAll().execute()).toHaveLength(2);
  });

  it('a copy of the same mail in another mailbox is not checked again (bug 12)', async () => {
    // cc'd at two of the user's own addresses: two thread rows, one Message-ID.
    // The first copy was opened and checked; opening the second staged a twin card.
    const rfc822 = '<slip-123@school.example>';
    const a = await seedThread({ bodyText: 'Sign and return the permission slip by Friday.', rfc822 });
    const b = await seedThread({ bodyText: 'Sign and return the permission slip by Friday.', rfc822 });

    expect((await runReadTimeEmailMagics(db, userId, a.threadId, { extractor: taskStub })).ranNow).toBe(true);
    const second = await runReadTimeEmailMagics(db, userId, b.threadId, { extractor: taskStub });
    expect(second.ranNow).toBe(false);
    expect(await db.selectFrom('proposals').selectAll().execute()).toHaveLength(1);
  });

  it('is a no-op when EMAIL_READ_TIME_MAGICS_ENABLED is off', async () => {
    (env as { EMAIL_READ_TIME_MAGICS_ENABLED: boolean }).EMAIL_READ_TIME_MAGICS_ENABLED = false;
    try {
      let calls = 0;
      const countingStub: EmailExtractor = {
        async extract() {
          calls += 1;
          return null;
        },
      };
      const { threadId } = await seedThread({ bodyText: 'Some message.' });
      const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: countingStub });
      expect(res).toEqual({ ranNow: false, advisory: null });
      expect(calls).toBe(0);
    } finally {
      (env as { EMAIL_READ_TIME_MAGICS_ENABLED: boolean }).EMAIL_READ_TIME_MAGICS_ENABLED = true;
    }
  });
});
