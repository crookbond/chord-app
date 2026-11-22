/**
 * Search operators against real rows (ADR 0126). The parsing is unit-tested;
 * this is about what the operators actually select, and about the rule that an
 * operator narrows the search to mail.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function mail(opts: {
  subject: string;
  from: string;
  fromName?: string;
  daysAgo?: number;
  withAttachment?: boolean;
}): Promise<string> {
  const when = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString();
  const id = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject: opts.subject,
      snippet: opts.subject,
      from_email: opts.from,
      from_name: opts.fromName ?? null,
      last_message_at: when,
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
      subject: opts.subject,
      snippet: opts.subject,
      from_email: opts.from,
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      attachments_json: opts.withAttachment
        ? JSON.stringify([{ id: 'a1', filename: 'form.pdf', mimeType: 'application/pdf', size: 10 }])
        : '[]',
      ics_text: '',
      internal_date: when,
      created_at: when,
    })
    .execute();
  return id;
}

async function find(query: string): Promise<string[]> {
  const res = await searchHits(db, { userId, groupId, query, crossGroup: true });
  return res.hits.map((h) => h.title);
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Personal',
      kind: 'personal',
      invite_code: 'OPSRCH',
      ingest_email: 'ops@chord.app',
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
  await addMember(db, groupId, userId, 'owner');
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('from:', () => {
  it('narrows to a sender, and matches the display name too', async () => {
    // People search for "the school", not for an address they never memorised.
    await mail({ subject: 'picture day', from: 'office@lcps.org', fromName: 'Loudoun Schools' });
    await mail({ subject: 'picture day', from: 'someone@else.example' });

    expect(await find('from:lcps picture')).toEqual(['picture day']);
    expect(await find('from:loudoun picture')).toEqual(['picture day']);
  });

  it('works with no search terms at all', async () => {
    await mail({ subject: 'one', from: 'office@lcps.org' });
    await mail({ subject: 'two', from: 'office@lcps.org' });
    await mail({ subject: 'three', from: 'other@example.com' });

    expect((await find('from:lcps.org')).sort()).toEqual(['one', 'two']);
  });
});

describe('has:attachment', () => {
  it('finds only mail carrying a file', async () => {
    await mail({ subject: 'permission slip', from: 'a@x.example', withAttachment: true });
    await mail({ subject: 'permission slip talk', from: 'b@x.example' });

    expect(await find('has:attachment permission')).toEqual(['permission slip']);
  });
});

describe('dates', () => {
  it('bounds the range', async () => {
    await mail({ subject: 'recent receipt', from: 'a@x.example', daysAgo: 1 });
    await mail({ subject: 'old receipt', from: 'a@x.example', daysAgo: 30 });

    expect(await find('newer_than:7d receipt')).toEqual(['recent receipt']);
    expect(await find('older_than:7d receipt')).toEqual(['old receipt']);
  });
});

describe('what an operator does to the rest of the search', () => {
  it('narrows the search to mail', async () => {
    // A task has no sender, so returning unfiltered tasks beside filtered mail
    // would answer a question nobody asked.
    await db
      .insertInto('tasks')
      .values({
        id: newId('tk'),
        group_id: groupId,
        title: 'picture day forms',
        status: 'open',
        created_by: userId,
        created_at: new Date().toISOString(),
      })
      .execute();
    await mail({ subject: 'picture day', from: 'office@lcps.org' });

    expect(await find('picture')).toContain('picture day forms');
    expect(await find('from:lcps picture')).toEqual(['picture day']);
  });

  it('leaves an ordinary query alone', async () => {
    await mail({ subject: 'dinner plans', from: 'mom@example.com' });

    expect(await find('dinner')).toEqual(['dinner plans']);
  });

  it('finds Chord-labelled mail via label:', async () => {
    const id = await mail({ subject: 'family plans', from: 'a@x.example' });
    await db
      .updateTable('email_threads')
      .set({ chord_label_ids: JSON.stringify(['Family']) })
      .where('id', '=', id)
      .execute();
    await mail({ subject: 'other', from: 'b@x.example' });

    expect(await find('label:family')).toEqual(['family plans']);
    expect(await find('label:Family')).toEqual(['family plans']);
  });

  it('label: returns the same email ids on searchHits and searchEverything', async () => {
    const id = await mail({ subject: 'family plans', from: 'a@x.example' });
    await db
      .updateTable('email_threads')
      .set({ chord_label_ids: JSON.stringify(['Family']) })
      .where('id', '=', id)
      .execute();
    await mail({ subject: 'other', from: 'b@x.example' });

    const hits = await searchHits(db, {
      userId,
      groupId,
      query: 'label:Family',
      crossGroup: true,
    });
    const bot = await searchEverything(db, {
      userId,
      groupId,
      query: 'label:Family',
      crossGroup: true,
      perCategory: 25,
    });
    const hitIds = hits.hits
      .filter((h) => h.entityType === 'email')
      .map((h) => h.entityId)
      .sort();
    const botIds = bot.emails.map((e) => e.id).sort();
    expect(hitIds).toEqual([id]);
    expect(botIds).toEqual(hitIds);
  });
});
