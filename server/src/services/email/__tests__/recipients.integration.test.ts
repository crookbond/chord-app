/**
 * Recipient suggestions (ADR 0114). The rule that matters most is the scope
 * one: suggestions come from the user's own mail and their own people rows,
 * never from a global lookup of everyone's addresses.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { suggestRecipients } from '@/services/email/recipients.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedMessage(
  userId: string,
  opts: { from?: string; fromName?: string; to?: string[]; at?: string },
): Promise<void> {
  const threadId = newId('emt');
  const now = opts.at ?? new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: threadId,
      subject: 'x',
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
      from_email: opts.from ?? null,
      from_name: opts.fromName ?? null,
      to_emails: JSON.stringify(opts.to ?? []),
      subject: 'x',
      internal_date: now,
      created_at: now,
    })
    .execute();
}

const emails = (rows: { email: string }[]) => rows.map((r) => r.email);

describe('suggestRecipients', () => {
  it('offers someone the mailbox has heard from', async () => {
    const uid = await createUser(db, 'alice');
    await seedMessage(uid, { from: 'chen@school.example', fromName: 'Ms Chen' });

    const out = await suggestRecipients(db, uid, 'chen');

    expect(emails(out)).toContain('chen@school.example');
    expect(out[0].name).toBe('Ms Chen');
  });

  it('matches on the display name, not just the address', async () => {
    // People search for "chen", not for the address they never memorised.
    const uid = await createUser(db, 'alice');
    await seedMessage(uid, { from: 'office@sch.example', fromName: 'Ms Chen' });

    expect(emails(await suggestRecipients(db, uid, 'chen'))).toContain('office@sch.example');
  });

  it('offers someone the user has written to', async () => {
    const uid = await createUser(db, 'alice');
    await seedMessage(uid, { from: 'me@example.com', to: ['neighbour@example.com'] });

    expect(emails(await suggestRecipients(db, uid, 'neighbour'))).toContain(
      'neighbour@example.com',
    );
  });

  it('never offers another user\'s correspondents', async () => {
    // The load-bearing one. A prefix search over everyone's addresses is a
    // directory, which is not what a compose field should be.
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    await seedMessage(alice, { from: 'private@example.com' });

    expect(await suggestRecipients(db, bob, 'private')).toEqual([]);
  });

  it('ranks the person you mail constantly above the one you mailed once', async () => {
    const uid = await createUser(db, 'alice');
    for (let i = 0; i < 5; i += 1) {
      await seedMessage(uid, { from: 'often@example.com', at: `2026-08-0${i + 1}T10:00:00.000Z` });
    }
    await seedMessage(uid, { from: 'once@example.com', at: '2026-08-20T10:00:00.000Z' });

    const out = await suggestRecipients(db, uid, 'example.com');

    // Recency alone would put `once` first; frequency is the better guess at
    // who is being written to.
    expect(out[0].email).toBe('often@example.com');
  });

  it('puts a named person above a bare correspondent', async () => {
    const uid = await createUser(db, 'alice');
    const now = new Date().toISOString();
    await db
      .insertInto('people')
      .values({
        id: newId('per'),
        owner_user_id: uid,
        display_name: 'Aunt Ruth',
        email: 'ruth@example.com',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await seedMessage(uid, { from: 'newsletter@example.com' });

    const out = await suggestRecipients(db, uid, 'example.com');

    expect(out[0].email).toBe('ruth@example.com');
    expect(out[0].source).toBe('person');
  });

  it('stays quiet under two characters', async () => {
    // A one-letter prefix matches most of a mailbox: a slow scan for a list
    // nobody can use. Same floor ADR 0085 put on the literal search arm.
    const uid = await createUser(db, 'alice');
    await seedMessage(uid, { from: 'chen@school.example' });

    expect(await suggestRecipients(db, uid, 'c')).toEqual([]);
    expect(await suggestRecipients(db, uid, '')).toEqual([]);
  });

  it('returns one row per address however many messages carried it', async () => {
    const uid = await createUser(db, 'alice');
    await seedMessage(uid, { from: 'chen@school.example', fromName: 'Ms Chen' });
    await seedMessage(uid, { from: 'me@example.com', to: ['chen@school.example'] });

    const out = await suggestRecipients(db, uid, 'chen@school');

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ms Chen');
  });
});
