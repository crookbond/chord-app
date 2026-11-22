/**
 * Message bodies in search (ADR 0110). The thread-level tsvector covers
 * subject, snippet and sender; everything actually said inside a message was
 * unfindable until now.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

/** A thread whose subject and snippet say nothing useful, and whose body does. */
async function seedThreadWithBody(
  userId: string,
  opts: {
    subject: string;
    snippet?: string;
    body: string | null;
    /** Write to the sync-owned excerpt instead of the reader-owned body. */
    asExcerpt?: boolean;
  },
): Promise<string> {
  const threadId = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: threadId,
      subject: opts.subject,
      snippet: opts.snippet ?? '',
      from_email: 'sender@example.com',
      gmail_label_ids: JSON.stringify(['INBOX']),
      last_message_at: now,
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
      gmail_message_id: newId('gm'),
      gmail_thread_id: threadId,
      from_email: 'sender@example.com',
      subject: opts.subject,
      snippet: opts.snippet ?? '',
      body_text: opts.asExcerpt ? null : opts.body,
      body_excerpt: opts.asExcerpt ? opts.body : null,
      internal_date: now,
      created_at: now,
    })
    .execute();
  return threadId;
}

async function emailHits(userId: string, query: string): Promise<string[]> {
  const personal = await ensurePersonalGroup(db, userId);
  const out = await searchHits(db, {
    userId,
    groupId: personal.id,
    crossGroup: true,
    query,
  });
  return out.hits.filter((h) => h.entityType === 'email').map((h) => h.title);
}

async function botEmailHits(userId: string, query: string): Promise<string[]> {
  const personal = await ensurePersonalGroup(db, userId);
  const out = await searchEverything(db, {
    userId,
    groupId: personal.id,
    crossGroup: true,
    query,
    categories: ['emails'],
  });
  return (out.emails ?? []).map((e) => e.subject);
}

describe('searching message bodies', () => {
  it('finds a thread by a word only its body contains', async () => {
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Re: our chat',
      snippet: 'Hi there,',
      body: 'The plumber is booked for Thursday at the Fairmount house.',
    });

    expect(await emailHits(uid, 'plumber')).toEqual(['Re: our chat']);
  });

  it('finds a confirmation code, which is the case FTS alone cannot tokenize', async () => {
    // ADR 0085's literal arm matters more in a body than in a subject: this is
    // where a booking reference actually lives.
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Your booking',
      body: 'Confirmation UA512X for two nights.',
    });

    expect(await emailHits(uid, '512')).toEqual(['Your booking']);
  });

  it('does not return a thread twice when subject AND body both match', async () => {
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Plumber on Thursday',
      body: 'Confirming the plumber for Thursday.',
    });

    expect(await emailHits(uid, 'plumber')).toEqual(['Plumber on Thursday']);
  });

  it('highlights the matching body, not an unrelated snippet', async () => {
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Re: our chat',
      snippet: 'Hi there,',
      body: 'The plumber is booked for Thursday.',
    });
    const personal = await ensurePersonalGroup(db, uid);

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'plumber',
    });
    const hit = out.hits.find((h) => h.entityType === 'email');

    expect(hit?.snippet).toContain('plumber');
  });

  it('still scopes bodies to their owner', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    await seedThreadWithBody(alice, { subject: 'Hers', body: 'the plumber comes Thursday' });

    expect(await emailHits(bob, 'plumber')).toEqual([]);
  });

  it('finds text that only sync has seen, not just what the reader fetched', async () => {
    // The reconciliation with 048: sync keeps a bounded excerpt for every
    // message and the whole body stays lazy, so an index reading `body_text`
    // alone would cover only threads someone had opened - which is exactly the
    // coverage-you-cannot-see that ADR 0110 refused.
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Re: our chat',
      snippet: 'Hi there,',
      body: 'The plumber is booked for Thursday.',
      asExcerpt: true,
    });

    expect(await emailHits(uid, 'plumber')).toEqual(['Re: our chat']);
  });

  it('prefers the full body when the reader has fetched it', async () => {
    // Past the excerpt's end is still findable once the whole message is
    // stored, so opening a thread widens what search can reach rather than
    // narrowing it.
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Long one',
      body: `${'filler '.repeat(400)} the plumber comes Thursday`,
    });

    expect(await emailHits(uid, 'plumber')).toEqual(['Long one']);
  });

  it('leaves a body-less thread alone rather than matching everything', async () => {
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, { subject: 'No body here', body: null });

    expect(await emailHits(uid, 'plumber')).toEqual([]);
  });

  it('the bot path matches the user path', async () => {
    // ADR 0085: one rule, both surfaces. A body arm on only one of them is
    // exactly the drift that ADR is about.
    const uid = await createUser(db, 'alice');
    await seedThreadWithBody(uid, {
      subject: 'Re: our chat',
      body: 'The plumber is booked for Thursday.',
    });

    expect(await botEmailHits(uid, 'plumber')).toEqual(await emailHits(uid, 'plumber'));
  });

  it('ranks a body match on its own merit, not last', async () => {
    // The thread tsvector knows nothing about a body, so scoring on it alone
    // gives every body-only hit a rank of 0 - which sorts the answer to a body
    // search to the bottom of that search. Same `greatest(...)` shape the Lists
    // arm uses for its items.
    const uid = await createUser(db, 'alice');
    // Older, and the match is only in the body.
    await seedThreadWithBody(uid, {
      subject: 'Re: our chat',
      body: 'plumber plumber plumber, the plumber is booked',
    });
    // Newer, and merely mentions it once in a long subject.
    await seedThreadWithBody(uid, {
      subject: 'Notes from the week including a plumber and much else besides',
      body: null,
    });

    const ranked = await emailHits(uid, 'plumber');

    expect(ranked[0]).toBe('Re: our chat');
  });

  it('indexes a body far larger than a tsvector can hold', async () => {
    // The generated column truncates before to_tsvector. Without that, one
    // oversized newsletter raises on INSERT and wedges the whole mailbox's
    // sync - the failure mode ADR 0106 was written about.
    const uid = await createUser(db, 'alice');
    const huge = 'lorem ipsum dolor sit amet '.repeat(60_000);

    await expect(
      seedThreadWithBody(uid, { subject: 'Newsletter', body: `${huge} plumber` }),
    ).resolves.toBeTruthy();

    // The tail past the truncation point is not indexed, and that is the
    // trade: storing the message always beats failing to store it.
    expect(await emailHits(uid, 'lorem')).toEqual(['Newsletter']);
  });
});
