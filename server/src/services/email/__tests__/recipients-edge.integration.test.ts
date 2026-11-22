/**
 * Recipient suggestions, the parts the first ADR 0114 tests do not reach:
 * what happens with your own address, wildcard characters, the result cap, and
 * how a named person and a correspondent merge. These are the rules a
 * blind-token rewrite of the autocomplete has to keep.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { suggestRecipients } from '@/services/email/recipients.service.js';
import { createPerson } from '@/services/people.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let uid: string;

beforeEach(async () => {
  db = await openTestDb();
  uid = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedMessage(opts: {
  from?: string;
  fromName?: string;
  to?: string[];
  at?: string;
  labels?: string[];
  owner?: string;
}): Promise<void> {
  const owner = opts.owner ?? uid;
  const threadId = newId('emt');
  const now = opts.at ?? new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: owner,
      gmail_thread_id: threadId,
      subject: 'x',
      gmail_label_ids: JSON.stringify(opts.labels ?? ['INBOX']),
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: owner,
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

describe('who is suggested when nobody says who', () => {
  it('matches in the middle of an address, not only at the start', async () => {
    await seedMessage({ from: 'front.office@school.example' });
    expect(emails(await suggestRecipients(db, uid, 'office'))).toContain('front.office@school.example');
  });

  it('is case-insensitive on both the query and the stored address', async () => {
    await seedMessage({ from: 'Chen@School.Example', fromName: 'Ms CHEN' });

    expect(emails(await suggestRecipients(db, uid, 'CHEN'))).toEqual(['chen@school.example']);
    expect(emails(await suggestRecipients(db, uid, 'chen'))).toEqual(['chen@school.example']);
  });

  it('returns each address once even when it appears as sender and as recipient', async () => {
    await seedMessage({ from: 'chen@school.example' });
    await seedMessage({ to: ['Chen@School.Example'] });

    expect(emails(await suggestRecipients(db, uid, 'chen'))).toEqual(['chen@school.example']);
  });

  it('offers the user their own address once they have sent mail (pinned: no self-exclusion)', async () => {
    // A sent message mirrors with the user as From. Nothing removes it from
    // the autocomplete. Pinned as today's behaviour; whether "me" belongs in
    // "To:" is a product call the rewrite should make on purpose.
    await seedMessage({ from: 'alice@family.example', labels: ['SENT'], to: ['chen@school.example'] });

    expect(emails(await suggestRecipients(db, uid, 'alice'))).toEqual(['alice@family.example']);
  });

  it('includes trashed mail (pinned: the suggestion source has no folder filter)', async () => {
    await seedMessage({ from: 'deleted@x.example', labels: ['TRASH'] });
    expect(emails(await suggestRecipients(db, uid, 'deleted'))).toContain('deleted@x.example');
  });
});

describe('wildcard characters typed into the box', () => {
  it('"%" and "_" match themselves, not everything', async () => {
    await seedMessage({ from: 'a_b@x.example' });
    await seedMessage({ from: 'axb@x.example' });
    await seedMessage({ from: 'plain@x.example' });

    expect(emails(await suggestRecipients(db, uid, 'a_b'))).toEqual(['a_b@x.example']);
    expect(await suggestRecipients(db, uid, '%%')).toEqual([]);
    expect(await suggestRecipients(db, uid, '__')).toEqual([]);
  });

  it('a backslash does not throw', async () => {
    await seedMessage({ from: 'chen@school.example' });
    await expect(suggestRecipients(db, uid, 'c\\h')).resolves.toEqual([]);
  });
});

describe('the result cap and ordering', () => {
  it('returns at most eight suggestions', async () => {
    for (let i = 0; i < 12; i++) {
      await seedMessage({ from: `parent${i}@school.example` });
    }
    expect(await suggestRecipients(db, uid, 'parent')).toHaveLength(8);
  });

  it('ranks by how often you exchange mail, then by recency', async () => {
    await seedMessage({ from: 'rare@x.example', at: '2026-09-10T10:00:00.000Z' });
    await seedMessage({ from: 'often@x.example', at: '2026-08-01T10:00:00.000Z' });
    await seedMessage({ from: 'often@x.example', at: '2026-08-02T10:00:00.000Z' });
    await seedMessage({ from: 'often@x.example', at: '2026-08-03T10:00:00.000Z' });

    expect(emails(await suggestRecipients(db, uid, 'x.example'))).toEqual([
      'often@x.example',
      'rare@x.example',
    ]);
  });

  it('counts an address you wrote to twice as heavily as one that wrote to you', async () => {
    await seedMessage({ from: 'inbound@x.example' });
    await seedMessage({ from: 'inbound@x.example' });
    await seedMessage({ to: ['outbound@x.example'] });
    await seedMessage({ to: ['outbound@x.example'] });
    await seedMessage({ to: ['outbound@x.example'] });

    const out = emails(await suggestRecipients(db, uid, 'x.example'));
    expect(out[0]).toBe('outbound@x.example');
  });
});

describe('people you have named', () => {
  it('a named person outranks a frequent correspondent and supplies the name', async () => {
    for (let i = 0; i < 5; i++) await seedMessage({ from: 'sara@school.example', fromName: 'S. Chen' });
    await createPerson(db, { ownerUserId: uid, displayName: 'Sara Chen', email: 'sara@school.example' });

    const out = await suggestRecipients(db, uid, 'sara');
    expect(out).toHaveLength(1);
    expect(out[0]!.email).toBe('sara@school.example');
    expect(out[0]!.name).toBe('Sara Chen');
  });

  it('finds a named person by display name even if they never wrote to you', async () => {
    await createPerson(db, { ownerUserId: uid, displayName: 'Grandma Ruth', email: 'ruth@family.example' });

    expect(emails(await suggestRecipients(db, uid, 'ruth'))).toEqual(['ruth@family.example']);
    expect(emails(await suggestRecipients(db, uid, 'grandma'))).toEqual(['ruth@family.example']);
  });

  it('never suggests a person who has no email', async () => {
    await createPerson(db, { ownerUserId: uid, displayName: 'No Email Person' });
    expect(await suggestRecipients(db, uid, 'person')).toEqual([]);
  });

  it("never suggests another user's people or mail", async () => {
    const bob = await createUser(db, 'bob');
    await createPerson(db, { ownerUserId: bob, displayName: 'Ruth', email: 'ruth@family.example' });
    await seedMessage({ owner: bob, from: 'secret@bob.example' });

    expect(await suggestRecipients(db, uid, 'ruth')).toEqual([]);
    expect(await suggestRecipients(db, uid, 'secret')).toEqual([]);
  });
});
