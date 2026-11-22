/**
 * An address the model wrote must have a source before Chord mails, invites or
 * saves it (known-addresses.ts). Prod 2026-10-30: the model handed over twelve
 * mailing lists as `name@example.com`; the same model writes the recipients of
 * a chat-drafted email, the guests of an event and the address on a person.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { __testing, noteAddressesSeen } from '@/services/email/known-addresses.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('an address the model wrote needs a source', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    __testing.reset();
    userId = await createUser(db, 'alice');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const said = async (body: string): Promise<string> =>
    (await insertMessage(db, { groupId: personalId, senderId: userId, body })).id;

  const call = (name: string, args: Record<string, unknown>, triggeringMessageId: string | null, turnId = 'turn-1') =>
    applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      triggeringMessageId,
      turnId,
      call: { name, args } as never,
    });

  const commit = (name: string, args: Record<string, unknown>, triggeringMessageId: string | null) =>
    applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      triggeringMessageId,
      turnId: 'turn-1',
      call: { name, args } as never,
    });

  const mailFrom = async (from: string): Promise<void> => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    const gid = newId('gt');
    await db
      .insertInto('email_threads')
      .values({ id: threadId, user_id: userId, gmail_thread_id: gid, subject: 'Hi', from_email: from, last_message_at: now, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: gid,
        gmail_message_id: newId('gm'),
        from_email: from,
        to_emails: JSON.stringify(['alice@example.org']),
        cc_emails: JSON.stringify([]),
        subject: 'Hi',
        snippet: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
  };

  const draft = (to: string[]) => ({ to, subject: 'Dinner', body: 'Are you free Friday?' });

  it('refuses a drafted email to an address nobody gave, and stages nothing', async () => {
    const msg = await said('Email Ben and ask if he is free for dinner Friday');
    const res = await call('compose_email', draft(['ben@example.com']), msg);
    expect(res.data).toMatchObject({ reason: 'unknown_address', unknownAddresses: ['ben@example.com'] });
    expect(String((res.data as { instruction: string }).instruction)).toMatch(/Never guess an address/);
    expect(await listProposalsForGroup(db, personalId)).toHaveLength(0);
  });

  it('stages a drafted email to an address from the user mail, the user words, or their phone this turn', async () => {
    await mailFrom('ben.doe@school.example');
    const fromMail = await call('compose_email', draft(['Ben.Doe@school.example']), await said('Email Ben about dinner'));
    expect(fromMail.summary).toMatch(/^proposed compose_email/);

    const typed = await call('compose_email', draft(['karl.d@media.example']), await said('Email karl.d@media.example about dinner'));
    expect(typed.summary).toMatch(/^proposed compose_email/);

    noteAddressesSeen('turn-phone', ['priya@phone.example']);
    const fromPhone = await call('compose_email', draft(['priya@phone.example']), await said('Email Priya about dinner'), 'turn-phone');
    expect(fromPhone.summary).toMatch(/^proposed compose_email/);
    // A phone answer counts for its own turn only.
    const later = await call('compose_email', draft(['priya@phone.example']), await said('Email Priya again'), 'turn-later');
    expect(later.data).toMatchObject({ reason: 'unknown_address' });
  });

  it('checks cc as well as to', async () => {
    await mailFrom('ben.doe@school.example');
    const res = await call(
      'compose_email',
      { ...draft(['ben.doe@school.example']), cc: ['teacher@example.com'] },
      await said('Email Ben about dinner, cc his teacher'),
    );
    expect(res.data).toMatchObject({ unknownAddresses: ['teacher@example.com'] });
  });

  it('creates the event but does not invite a guest address nobody gave', async () => {
    const msg = await said('Add dinner with Ben Friday 7pm and invite him');
    const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await commit('create_event', { title: 'Dinner with Ben', startsAt, invitees: ['ben@example.com'] }, msg);
    expect(await db.selectFrom('events').select('title').execute()).toEqual([{ title: 'Dinner with Ben' }]);
    expect(res.summary).toMatch(/NOT invited: ben@example\.com/);
    expect(res.data).toMatchObject({ invited: [], unverifiedInvitees: ['ben@example.com'] });
  });

  it('will not save an address on a person when nobody gave it', async () => {
    const msg = await said("Save Ben's email");
    const res = await commit('update_person', { personName: 'Ben', email: 'ben@example.com' }, msg);
    expect(res.data).toMatchObject({ reason: 'unknown_address' });
    expect(await db.selectFrom('people').select('email').execute()).toEqual([]);

    const added = await commit('add_person', { displayName: 'Ben', email: 'ben@example.com' }, msg);
    expect(added.data).toMatchObject({ reason: 'unknown_address' });
    expect(await db.selectFrom('people').select('email').execute()).toEqual([]);
  });

  // Audit 2026-11-01: "typed" was a substring test over the user's words and
  // the mail check a LIKE over the recipients' JSON, so a part of a longer
  // address, or an address whose `_` matched any character, passed as known.
  it('takes only a whole typed address, not one inside a longer one', async () => {
    const res = await call(
      'compose_email',
      draft(['bob@x.com']),
      await said('Email notbob@x.com.evil about dinner'),
    );
    expect(res.data).toMatchObject({ reason: 'unknown_address', unknownAddresses: ['bob@x.com'] });
  });

  it('does not read `_` or `%` in an address as a wildcard against the user mail', async () => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    const gid = newId('gt');
    await db
      .insertInto('email_threads')
      .values({ id: threadId, user_id: userId, gmail_thread_id: gid, subject: 'Hi', from_email: 'alice@example.org', last_message_at: now, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: gid,
        gmail_message_id: newId('gm'),
        from_email: 'alice@example.org',
        to_emails: JSON.stringify(['axb@x.com']),
        cc_emails: JSON.stringify(['Carol.Smith@x.com']),
        subject: 'Hi',
        snippet: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    const wild = await call('compose_email', draft(['a_b@x.com', '%@x.com']), await said('Email them about dinner'));
    expect(wild.data).toMatchObject({ reason: 'unknown_address' });
    expect((wild.data as { unknownAddresses: string[] }).unknownAddresses.sort()).toEqual(['%@x.com', 'a_b@x.com']);
    // A real recipient (to or cc, any case) still counts.
    const real = await call('compose_email', draft(['AXB@x.com', 'carol.smith@x.com']), await said('Email them about dinner'));
    expect(real.summary).toMatch(/^proposed compose_email/);
  });

  it('checks nothing when no person is behind the call (a confirmed card, an import)', async () => {
    const res = await commit('update_person', { personName: 'Ben', email: 'ben@example.com' }, null);
    expect(res.data).toMatchObject({ email: 'ben@example.com' });
  });
});
