/**
 * `preprocessReadTimeMagics` warms the ADR 0180 read-time pass AHEAD of the
 * open, for the newest not-yet-processed threads, so a thread near the top
 * of the inbox is instant to open instead of paying a live LLM call. Bounded
 * to `limit` at a time; no cursor is stored, so the window self-advances —
 * once the front is fully marked, the same call naturally surfaces the next
 * batch.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { preprocessReadTimeMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'preprocess-user');
  await ensurePersonalGroup(db, userId);
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(opts: {
  ageDays: number;
  isArchived?: boolean;
  isUnread?: boolean;
}): Promise<{ threadId: string; gid: string }> {
  const at = daysAgo(opts.ageDays);
  const now = new Date().toISOString();
  const gid = `t_${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: `Thread ${opts.ageDays}d old`,
      snippet: 'Hello',
      from_email: 'sender@example.com',
      category_id: null,
      last_message_at: at,
      is_unread: opts.isUnread === false ? 0 : 1,
      is_archived: opts.isArchived ? 1 : 0,
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
      subject: `Thread ${opts.ageDays}d old`,
      snippet: 'Hello',
      body_text: 'Hello there.',
      body_html: null,
      internal_date: at,
      is_unread: opts.isUnread === false ? 0 : 1,
      gmail_label_ids: JSON.stringify(['INBOX']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({}),
      // What a Gmail sync stores for a message with no invite (ADR 0080).
      ics_text: '',
      created_at: now,
    })
    .execute();
  return { threadId, gid };
}

function countingStub(): { extractor: EmailExtractor; calls: () => number } {
  let n = 0;
  return {
    extractor: {
      async extract() {
        n += 1;
        return null;
      },
    },
    calls: () => n,
  };
}

async function markedGids(): Promise<string[]> {
  const rows = await db
    .selectFrom('email_extraction_marks')
    .select('gmail_thread_id')
    .where('user_id', '=', userId)
    .where('kind', '=', 'read')
    .execute();
  return rows.map((r) => r.gmail_thread_id);
}

describe('preprocessReadTimeMagics', () => {
  it('warms the newest `limit` threads, oldest ones left alone', async () => {
    // 15 threads, ages 0..14 days — newest (0d) first.
    const seeded = await Promise.all(
      Array.from({ length: 15 }, (_, i) => seedThread({ ageDays: i })),
    );
    const { extractor, calls } = countingStub();

    const res = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });

    expect(res.processed).toBe(10);
    expect(calls()).toBe(10);
    const marked = new Set(await markedGids());
    expect(marked.size).toBe(10);
    // The newest 10 (ages 0..9) are marked; the oldest 5 (ages 10..14) are not.
    for (let i = 0; i < 10; i++) expect(marked.has(seeded[i].gid)).toBe(true);
    for (let i = 10; i < 15; i++) expect(marked.has(seeded[i].gid)).toBe(false);
  });

  it('self-advances: a second call picks up the next batch, not the same one', async () => {
    const seeded = await Promise.all(
      Array.from({ length: 15 }, (_, i) => seedThread({ ageDays: i })),
    );
    const { extractor, calls } = countingStub();

    const first = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });
    expect(first.processed).toBe(10);
    expect(calls()).toBe(10);

    const second = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });
    // Only 5 threads were left unmarked, so the self-advancing window picks
    // up exactly the remainder - never re-processing the first 10.
    expect(second.processed).toBe(5);
    expect(calls()).toBe(15);
    const marked = new Set(await markedGids());
    expect(marked.size).toBe(15);
    for (const s of seeded) expect(marked.has(s.gid)).toBe(true);

    // A third call finds nothing left to do.
    const third = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });
    expect(third.processed).toBe(0);
    expect(calls()).toBe(15);
  });

  it('never preprocesses an archived thread', async () => {
    const live = await seedThread({ ageDays: 0 });
    await seedThread({ ageDays: 1, isArchived: true });
    const { extractor, calls } = countingStub();

    const res = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });

    expect(res.processed).toBe(1);
    expect(calls()).toBe(1);
    expect(await markedGids()).toEqual([live.gid]);
  });

  it('a concurrent call is skipped by the in-flight guard, not doubled', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => seedThread({ ageDays: i })));
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slowExtractor: EmailExtractor = {
      async extract() {
        calls += 1;
        await gate;
        return null;
      },
    };

    const firstRun = preprocessReadTimeMagics(db, userId, { limit: 10, extractor: slowExtractor });
    // The first call has claimed the in-flight guard once its first (slow,
    // gated) extraction has started.
    expect(await waitFor(() => calls === 1)).toBe(true);
    const secondRun = preprocessReadTimeMagics(db, userId, { limit: 10, extractor: slowExtractor });

    const second = await secondRun;
    expect(second.processed).toBe(0); // skipped outright - the guard, not a race on marks

    release();
    const first = await firstRun;
    expect(first.processed).toBe(10);
    expect(calls).toBe(10); // not 20 - the second call never touched the LLM
  });

  // prod incident (ADR 0221): a user with five mailboxes going back months
  // had a large backlog of threads that were read-and-settled (handled
  // through some other channel, or simply read and left) but had never
  // been through the ADR 0180 read-time pass. Because this preprocessing
  // query had no age/bulk bound at all, repeated sync/open-triggered calls
  // walked straight through "newest unmarked" all the way back into that
  // backlog, running the FULL extraction+staging pass (bypassing every
  // background-sweep gate, which is only justified when a person actually
  // has the thread open) and surfacing fresh to-dos for months-old,
  // already-read mail.
  it('ADR 0221: does not preprocess old, already-read mail (settled, not still owed)', async () => {
    const old = await seedThread({ ageDays: 60, isUnread: false });
    const recent = await seedThread({ ageDays: 1, isUnread: false });
    const oldButUnread = await seedThread({ ageDays: 90, isUnread: true });
    const { extractor, calls } = countingStub();

    const res = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });

    // Only the recent-and-read and the old-but-unread threads are "still
    // owed" by ADR 0143's own rule; the old, read, settled one is history.
    expect(res.processed).toBe(2);
    expect(calls()).toBe(2);
    const marked = new Set(await markedGids());
    expect(marked.has(old.gid)).toBe(false);
    expect(marked.has(recent.gid)).toBe(true);
    expect(marked.has(oldButUnread.gid)).toBe(true);
  });

  it('is a no-op when EMAIL_PREPROCESS_READTIME_ENABLED is off', async () => {
    (env as { EMAIL_PREPROCESS_READTIME_ENABLED: boolean }).EMAIL_PREPROCESS_READTIME_ENABLED = false;
    try {
      await seedThread({ ageDays: 0 });
      const { extractor, calls } = countingStub();
      const res = await preprocessReadTimeMagics(db, userId, { limit: 10, extractor });
      expect(res).toEqual({ processed: 0 });
      expect(calls()).toBe(0);
    } finally {
      (env as { EMAIL_PREPROCESS_READTIME_ENABLED: boolean }).EMAIL_PREPROCESS_READTIME_ENABLED = true;
    }
  });
});
