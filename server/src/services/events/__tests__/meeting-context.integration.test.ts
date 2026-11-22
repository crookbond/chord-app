/**
 * ADR 0163 — a meeting remembers why. `buildMeetingContext` searches the
 * user's own mail for correspondence with an invited attendee and spends one
 * LLM call ONLY when something is found; `buildAndStoreMeetingContext`
 * persists the result onto `events.meeting_context`.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { createEvent } from '@/services/events.service.js';
import {
  buildAndStoreMeetingContext,
  buildMeetingContext,
  type CorrespondenceSummarizer,
  type MatchedMessage,
} from '@/services/events/meeting-context.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'meeting-user');
  await db.updateTable('users').set({ email: 'john@example.com' }).where('id', '=', userId).execute();
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

async function insertMailMessage(
  fromEmail: string,
  toEmails: string[],
  opts: { subject?: string; body?: string; daysAgo?: number } = {},
): Promise<void> {
  const now = new Date();
  now.setDate(now.getDate() - (opts.daysAgo ?? 0));
  const iso = now.toISOString();
  const threadId = newId('et');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: threadId,
      subject: opts.subject ?? 'Re: meeting',
      snippet: opts.body?.slice(0, 100) ?? '',
      from_email: fromEmail,
      last_message_at: iso,
      created_at: iso,
      updated_at: iso,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('em'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: newId('gm'),
      gmail_thread_id: threadId,
      from_email: fromEmail,
      to_emails: JSON.stringify(toEmails),
      cc_emails: JSON.stringify([]),
      subject: opts.subject ?? 'Re: meeting',
      snippet: opts.body?.slice(0, 100) ?? '',
      body_text: opts.body ?? null,
      internal_date: iso,
      created_at: iso,
    })
    .execute();
}

function fakeSummarizer(phrase: string | null): {
  fn: CorrespondenceSummarizer;
  calls: Array<{ withWhom: string; messages: MatchedMessage[] }>;
} {
  const calls: Array<{ withWhom: string; messages: MatchedMessage[] }> = [];
  const fn: CorrespondenceSummarizer = async (_db, _userId, withWhom, messages) => {
    calls.push({ withWhom, messages });
    return phrase;
  };
  return { fn, calls };
}

describe('buildMeetingContext', () => {
  it('no attendees → returns null without ever calling the summarizer', async () => {
    const { fn, calls } = fakeSummarizer('should not be used');
    const out = await buildMeetingContext(db, userId, [], new Date().toISOString(), fn);
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('an attendee with no correspondence → null, no LLM call made', async () => {
    const { fn, calls } = fakeSummarizer('should not be used');
    const out = await buildMeetingContext(
      db,
      userId,
      ['stranger@nowhere.com'],
      new Date().toISOString(),
      fn,
    );
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('an attendee with a matching thread → one call, parsed phrase returned', async () => {
    await insertMailMessage('bill@acme.com', ['john@example.com'], {
      subject: 'Q3 budget review',
      body: 'Can we go over the budget, timeline, and staffing plan Thursday?',
    });
    const { fn, calls } = fakeSummarizer('budget, timeline, and staffing');
    const out = await buildMeetingContext(
      db,
      userId,
      ['bill@acme.com'],
      new Date().toISOString(),
      fn,
    );
    expect(out).toBe('budget, timeline, and staffing');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.subject).toBe('Q3 budget review');
  });

  it('the caller\'s own email is excluded from the attendee search', async () => {
    const { fn, calls } = fakeSummarizer('should not be used');
    const out = await buildMeetingContext(
      db,
      userId,
      ['john@example.com'],
      new Date().toISOString(),
      fn,
    );
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('mail older than the 60-day window is not found', async () => {
    await insertMailMessage('bill@acme.com', ['john@example.com'], { daysAgo: 90 });
    const { fn, calls } = fakeSummarizer('should not be used');
    const out = await buildMeetingContext(
      db,
      userId,
      ['bill@acme.com'],
      new Date().toISOString(),
      fn,
    );
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('only the first 3 attendees are searched', async () => {
    const emails = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'];
    await insertMailMessage('d@x.com', ['john@example.com'], { subject: 'From d' });
    const { fn, calls } = fakeSummarizer('found it');
    const out = await buildMeetingContext(db, userId, emails, new Date().toISOString(), fn);
    // d@x.com is 4th and never searched, so no correspondence is found at all.
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('finds correspondence the user sent (to/cc), not just received', async () => {
    await insertMailMessage('john@example.com', ['bill@acme.com'], {
      subject: 'Following up',
      body: 'Sending over the agenda for our sync',
    });
    const { fn, calls } = fakeSummarizer('the agenda');
    const out = await buildMeetingContext(
      db,
      userId,
      ['bill@acme.com'],
      new Date().toISOString(),
      fn,
    );
    expect(out).toBe('the agenda');
    expect(calls).toHaveLength(1);
  });

  it('is a no-op when the flag is off', async () => {
    await insertMailMessage('bill@acme.com', ['john@example.com']);
    const { fn, calls } = fakeSummarizer('should not be used');
    (env as { MEETING_CONTEXT_ENABLED: boolean }).MEETING_CONTEXT_ENABLED = false;
    try {
      const out = await buildMeetingContext(db, userId, ['bill@acme.com'], new Date().toISOString(), fn);
      expect(out).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      (env as { MEETING_CONTEXT_ENABLED: boolean }).MEETING_CONTEXT_ENABLED = true;
    }
  });
});

describe('buildAndStoreMeetingContext', () => {
  it('persists the phrase onto events.meeting_context', async () => {
    const ev = await createEvent(db, {
      groupId,
      title: 'Coffee with Bill',
      startsAt: new Date().toISOString(),
      createdBy: userId,
    });
    await insertMailMessage('bill@acme.com', ['john@example.com'], {
      subject: 'Coffee?',
      body: 'Want to grab coffee and talk about the new hire?',
    });
    const { fn } = fakeSummarizer('the new hire');
    await buildAndStoreMeetingContext(db, userId, ev.id, ['bill@acme.com'], fn);

    const row = await db
      .selectFrom('events')
      .select('meeting_context')
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    expect(row.meeting_context).toBe('the new hire');
  });

  it('leaves meeting_context null when nothing is found', async () => {
    const ev = await createEvent(db, {
      groupId,
      title: 'Family dinner',
      startsAt: new Date().toISOString(),
      createdBy: userId,
    });
    const { fn } = fakeSummarizer('should not be used');
    await buildAndStoreMeetingContext(db, userId, ev.id, ['stranger@nowhere.com'], fn);

    const row = await db
      .selectFrom('events')
      .select('meeting_context')
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    expect(row.meeting_context).toBeNull();
  });
});
