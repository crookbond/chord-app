/**
 * ADR 0162 — a calendar event remembers what made it. `buildEventContextExcerpt`
 * is deterministic (no LLM): a `gmail:` provenance excerpts the source
 * thread's subject/snippet plus a link back to it; a `chat:` provenance
 * excerpts the triggering message's own text; anything else is null.
 * `createEvent` only fills in `description` when the caller left it
 * unspecified — an explicit (even null) value always wins.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { createEvent } from '@/services/events.service.js';
import { buildEventContextExcerpt } from '@/services/events/context-excerpt.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'excerpt-user');
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('buildEventContextExcerpt', () => {
  it('null provenance → null', async () => {
    expect(await buildEventContextExcerpt(db, userId, null)).toBeNull();
  });

  it('unrecognized provenance shape → null', async () => {
    expect(await buildEventContextExcerpt(db, userId, 'attachment:abc')).toBeNull();
  });

  it('gmail provenance → subject + snippet + link', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: userId,
        gmail_thread_id: 'g-1',
        subject: 'Coffee next week?',
        snippet: 'Would Tuesday at 10 work for you?',
        from_email: 'bill@example.com',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const out = await buildEventContextExcerpt(db, userId, 'gmail:g-1');
    expect(out).toContain('Coffee next week?');
    expect(out).toContain('Would Tuesday at 10 work for you?');
  });

  it('gmail provenance with no matching thread → null', async () => {
    expect(await buildEventContextExcerpt(db, userId, 'gmail:missing')).toBeNull();
  });

  it('chat provenance → the triggering message text and sender', async () => {
    const msg = await insertMessage(db, {
      groupId,
      senderId: userId,
      body: 'add meeting with Bill Thursday 3pm',
    });
    const out = await buildEventContextExcerpt(db, userId, `chat:${msg.id}`);
    expect(out).toContain('add meeting with Bill Thursday 3pm');
  });

  it('chat provenance truncates a long message', async () => {
    const long = 'x'.repeat(400);
    const msg = await insertMessage(db, { groupId, senderId: userId, body: long });
    const out = await buildEventContextExcerpt(db, userId, `chat:${msg.id}`);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(long.length);
  });

  it('chat provenance with no matching message → null', async () => {
    expect(await buildEventContextExcerpt(db, userId, 'chat:missing')).toBeNull();
  });

  it('returns null when the flag is off', async () => {
    (env as { EVENT_CONTEXT_EXCERPT_ENABLED: boolean }).EVENT_CONTEXT_EXCERPT_ENABLED = false;
    try {
      expect(await buildEventContextExcerpt(db, userId, 'gmail:g-1')).toBeNull();
    } finally {
      (env as { EVENT_CONTEXT_EXCERPT_ENABLED: boolean }).EVENT_CONTEXT_EXCERPT_ENABLED = true;
    }
  });
});

describe('createEvent — description auto-fill', () => {
  it('auto-fills description from gmail provenance when the caller supplied none', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: userId,
        gmail_thread_id: 'g-2',
        subject: 'School play',
        snippet: 'Rehearsal moved to the gym',
        from_email: 'school@example.com',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const ev = await createEvent(db, {
      groupId,
      title: 'School play',
      startsAt: '2027-01-05T18:00:00-05:00',
      createdBy: userId,
      sourceRawContext: 'gmail:g-2',
    });
    expect(ev.description).toContain('School play');
    expect(ev.description).toContain('Rehearsal moved to the gym');
  });

  it('an explicit description (even null) is never overridden', async () => {
    const ev = await createEvent(db, {
      groupId,
      title: 'Team sync',
      startsAt: '2027-01-05T18:00:00-05:00',
      createdBy: userId,
      sourceRawContext: 'chat:does-not-exist-but-should-not-matter',
      description: null,
    });
    expect(ev.description).toBeUndefined();
  });

  it('no provenance → no description', async () => {
    const ev = await createEvent(db, {
      groupId,
      title: 'Untraced event',
      startsAt: '2027-01-05T18:00:00-05:00',
      createdBy: userId,
    });
    expect(ev.description).toBeUndefined();
  });
});
