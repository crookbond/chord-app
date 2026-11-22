/**
 * The vacation responder pass (ADR 0124). The rules about WHO gets answered
 * are tested in the kernel; this is about the pass around them - what it
 * selects, what it remembers, and the two things it must never do: reply
 * twice, or mark someone's mail read on their behalf.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const replies: { threadRowId: string; body: string; markRead?: boolean }[] = [];
let throwOnSend = false;

vi.mock('@/services/google/gmail.service.js', () => ({
  sendReply: async (
    _db: unknown,
    _userId: string,
    input: { threadRowId: string; body: string; markRead?: boolean },
  ) => {
    if (throwOnSend) throw new Error('provider down');
    replies.push(input);
    return null;
  },
}));

const { getVacation, runVacationReplies, setVacation } = await import(
  '@/services/email/vacation.service.js'
);

let db: Kysely<DB>;
let userId: string;

async function arrive(opts: {
  from: string;
  to?: string[];
  minutesAgo?: number;
  bulk?: boolean;
  listUnsubscribe?: string | null;
  archived?: boolean;
}): Promise<string> {
  const when = new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString();
  const id = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'hello',
      from_email: opts.from,
      last_message_at: when,
      bulk: opts.bulk ? 1 : 0,
      is_archived: opts.archived ? 1 : 0,
      created_at: when,
      updated_at: when,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: 'hello',
      snippet: 'hello',
      from_email: opts.from,
      to_emails: JSON.stringify(opts.to ?? ['alice@example.com']),
      cc_emails: JSON.stringify([]),
      list_unsubscribe: opts.listUnsubscribe ?? null,
      ics_text: '',
      internal_date: when,
      created_at: when,
    })
    .execute();
  return id;
}

const ON = {
  enabled: true,
  subject: null,
  body: 'Away until the 3rd.',
  startsAt: null,
  endsAt: null,
};

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  await db.updateTable('users').set({ email: 'alice@example.com' }).where('id', '=', userId).execute();
  replies.length = 0;
  throwOnSend = false;
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('settings', () => {
  it('is off until it is turned on', async () => {
    expect((await getVacation(db, userId)).enabled).toBe(false);
  });

  it('round-trips what was saved', async () => {
    const saved = await setVacation(db, userId, { ...ON, subject: 'Out of office' });

    expect(saved).toMatchObject({ enabled: true, subject: 'Out of office' });
  });
});

describe('the pass', () => {
  it('does nothing when the responder is off', async () => {
    await arrive({ from: 'friend@example.com' });

    expect(await runVacationReplies(db, userId)).toBe(0);
  });

  it('answers a person who wrote to you', async () => {
    await setVacation(db, userId, ON);
    const tid = await arrive({ from: 'friend@example.com' });

    expect(await runVacationReplies(db, userId)).toBe(1);
    // No signature ever set: the Chord default goes (ADR 0260 addendum).
    expect(replies[0]).toMatchObject({
      threadRowId: tid,
      body: 'Away until the 3rd.\n\n-- \nGet Chord at https://www.chordapp.ai',
    });
  });

  it('carries the signature, since nobody types an auto-reply and the send adds none', async () => {
    await db
      .updateTable('users')
      .set({ email_signature: 'Alice\nSent from Chord' })
      .where('id', '=', userId)
      .execute();
    await setVacation(db, userId, ON);
    await arrive({ from: 'friend@example.com' });

    await runVacationReplies(db, userId);

    expect(replies[0].body).toBe('Away until the 3rd.\n\n-- \nAlice\nSent from Chord');
  });

  it('does not mark their mail read', async () => {
    // An auto-reply is not reading. Marking it read would hide the thread
    // from the decision queue and from the new-mail notification.
    await setVacation(db, userId, ON);
    await arrive({ from: 'friend@example.com' });

    await runVacationReplies(db, userId);

    expect(replies[0].markRead).toBe(false);
  });

  it('answers each sender once, however many times they write', async () => {
    await setVacation(db, userId, ON);
    await arrive({ from: 'friend@example.com' });
    await runVacationReplies(db, userId);
    await arrive({ from: 'friend@example.com' });

    expect(await runVacationReplies(db, userId)).toBe(0);
    expect(replies).toHaveLength(1);
  });

  it('ignores mail that arrived before the holiday started', async () => {
    // Switching the responder on must not answer a week of read mail.
    await arrive({ from: 'friend@example.com', minutesAgo: 60 });
    await setVacation(db, userId, ON);

    expect(await runVacationReplies(db, userId)).toBe(0);
  });

  it('ignores a mailing list and an archived thread', async () => {
    await setVacation(db, userId, ON);
    await arrive({ from: 'news@list.example', listUnsubscribe: '<mailto:u@l.example>' });
    await arrive({ from: 'someone@example.com', archived: true });

    expect(await runVacationReplies(db, userId)).toBe(0);
  });

  it('refuses to send when there is nothing to say', async () => {
    // An empty holiday message would go out as a blank email.
    await db
      .updateTable('users')
      .set({ vacation_enabled: 1, vacation_body: null, vacation_since: '2000-01-01T00:00:00.000Z' })
      .where('id', '=', userId)
      .execute();
    await arrive({ from: 'friend@example.com' });

    expect(await runVacationReplies(db, userId)).toBe(0);
  });

  it('does not retry a failed send into a second copy', async () => {
    // The sender is claimed before the provider is called, so a transient
    // failure costs one reply rather than duplicating it forever.
    await setVacation(db, userId, ON);
    await arrive({ from: 'friend@example.com' });
    throwOnSend = true;
    expect(await runVacationReplies(db, userId)).toBe(0);

    throwOnSend = false;

    expect(await runVacationReplies(db, userId)).toBe(0);
    expect(replies).toHaveLength(0);
  });

  it('starts a fresh trip when turned off and on again', async () => {
    await setVacation(db, userId, ON);
    await arrive({ from: 'friend@example.com' });
    await runVacationReplies(db, userId);

    await setVacation(db, userId, { ...ON, enabled: false });
    await setVacation(db, userId, ON);
    await arrive({ from: 'friend@example.com' });

    expect(await runVacationReplies(db, userId)).toBe(1);
  });
});

// The scan read the OLDEST 100 messages since the holiday began, every tick,
// and its lower bound never moved: once 100 skipped messages (bulk, mail to
// others, senders already answered) sat at the front, nobody new was ever
// answered for the rest of the holiday.
describe('a busy holiday', () => {
  it('still answers a new sender after 100+ skipped messages', async () => {
    await setVacation(db, userId, ON);
    for (let i = 0; i < 110; i++) {
      // Negative minutesAgo = after the responder was switched on.
      await arrive({ from: `deals${i}@shop.example.com`, bulk: true, minutesAgo: -(i + 1) });
    }
    await arrive({ from: 'friend@example.com', minutesAgo: -200 });

    let sent = 0;
    for (let tick = 0; tick < 3; tick++) sent += await runVacationReplies(db, userId);

    expect(sent).toBe(1);
    expect(replies).toHaveLength(1);
  });
});
