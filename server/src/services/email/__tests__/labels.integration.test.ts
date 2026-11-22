/**
 * Browsing by label (ADR 0125). Two things matter: the list is derived from
 * the mirror (so it answers for every provider), and a label reads ACROSS
 * folders, because the mail most likely to carry one is the mail that left
 * the inbox.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { listBrowsableLabels } from '@/services/email/labels.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

async function thread(subject: string, labels: string[], archived = false): Promise<string> {
  const now = new Date().toISOString();
  const id = newId('et');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: newId('gt'),
      subject,
      from_email: 'someone@example.com',
      gmail_label_ids: JSON.stringify(labels),
      is_archived: archived ? 1 : 0,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('the label list', () => {
  it('is empty when the mirror carries only system labels', async () => {
    // Outlook and IMAP land exactly this: no user labels to browse, which is
    // a short answer rather than an error.
    await thread('hi', ['INBOX', 'UNREAD']);

    expect(await listBrowsableLabels(db, userId)).toEqual([]);
  });

  it('finds user labels and counts what is filed under them', async () => {
    await thread('a', ['INBOX', 'Label_7']);
    await thread('b', ['Label_7'], true);
    await thread('c', ['Label_9']);

    const labels = await listBrowsableLabels(db, userId);

    expect(labels.map((l) => [l.id, l.threads, l.scope])).toEqual([
      ['Label_7', 2, 'provider'],
      ['Label_9', 1, 'provider'],
    ]);
  });

  it('drops Gmail category tabs, which are not labels anyone files with', async () => {
    await thread('a', ['INBOX', 'CATEGORY_PROMOTIONS', 'IMPORTANT', 'STARRED']);

    expect(await listBrowsableLabels(db, userId)).toEqual([]);
  });

  it('never counts mail belonging to someone else', async () => {
    const other = await createUser(db, 'bob');
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: other,
        gmail_thread_id: newId('gt'),
        subject: 'theirs',
        gmail_label_ids: JSON.stringify(['Label_7']),
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    expect(await listBrowsableLabels(db, userId)).toEqual([]);
  });
});

describe('browsing one', () => {
  it('reads across folders, archived mail included', async () => {
    // The whole point: labelling and archiving are orthogonal in Gmail, and
    // an inbox-only label view would show almost nothing.
    await thread('in the inbox', ['INBOX', 'Label_7']);
    await thread('archived', ['Label_7'], true);
    await thread('other label', ['INBOX', 'Label_9']);

    const rows = await listThreads(db, userId, { labelId: 'Label_7' });

    expect(rows.map((r) => r.subject).sort()).toEqual(['archived', 'in the inbox']);
  });

  it('leaves deleted mail out', async () => {
    await thread('binned', ['Label_7', 'TRASH'], true);

    expect(await listThreads(db, userId, { labelId: 'Label_7' })).toEqual([]);
  });

  it('matches nothing for a label nobody carries', async () => {
    await thread('a', ['INBOX', 'Label_7']);

    expect(await listThreads(db, userId, { labelId: 'Label_nope' })).toEqual([]);
  });
});
