/**
 * The attachment-import pass marks every message it has looked at (however it
 * went: a message that fails must not wedge the queue). That was one UPDATE per
 * message; it is one per batch. What gets marked must not change.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { importEmailAttachments } from '@/services/email/attachment-import.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function countMessageUpdates(db: Kysely<DB>): { db: Kysely<DB>; n: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'updateTable') {
        return (table: string) => {
          if (table === 'email_messages') n += 1;
          return (target.updateTable as (t: string) => unknown).call(target, table);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Kysely<DB>;
  return { db: proxy, n: () => n };
}

describe('attachment import marks', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'importer');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seed(count: number, spamEvery = 0): Promise<string[]> {
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const threadRow = newId('emt');
      await db
        .insertInto('email_threads')
        .values({
          id: threadRow,
          user_id: userId,
          gmail_thread_id: `gt${i}`,
          subject: `Receipt ${i}`,
          snippet: 'snippet',
          from_email: 'shop@example.com',
          last_message_at: now,
          is_unread: 1,
          is_archived: 0,
          gmail_label_ids: JSON.stringify(['INBOX']),
          created_at: now,
          updated_at: now,
        })
        .execute();
      const id = newId('emm');
      ids.push(id);
      await db
        .insertInto('email_messages')
        .values({
          id,
          user_id: userId,
          thread_id: threadRow,
          gmail_message_id: `gm${i}`,
          gmail_thread_id: `gt${i}`,
          internal_date: new Date(Date.now() - i * 1000).toISOString(),
          subject: `Receipt ${i}`,
          snippet: 'snippet',
          from_email: 'shop@example.com',
          is_unread: 1,
          gmail_label_ids: JSON.stringify(spamEvery > 0 && i % spamEvery === 0 ? ['SPAM'] : ['INBOX']),
          // A full-format sync stores '[]' when a message has no attachment parts.
          attachments_json: JSON.stringify([]),
          created_at: now,
        } as never)
        .execute();
    }
    return ids;
  }

  const unmarked = async (): Promise<number> =>
    (
      await db
        .selectFrom('email_messages')
        .select('id')
        .where('user_id', '=', userId)
        .where('attachments_imported_at', 'is', null)
        .execute()
    ).length;

  it('marks a batch of messages with one update, not one each', async () => {
    await seed(30);
    const counted = countMessageUpdates(db);
    const res = await importEmailAttachments(counted.db, userId, { limit: 50 });
    expect(res.processed).toBe(30);
    expect(counted.n()).toBe(1);
    expect(await unmarked()).toBe(0);
  });

  it('marks spam rows too, so they leave the queue without being imported', async () => {
    await seed(10, 2);
    const res = await importEmailAttachments(db, userId, { limit: 50 });
    expect(res).toMatchObject({ processed: 10, imported: 0 });
    expect(await unmarked()).toBe(0);
  });

  it('only marks the messages this pass took, and a second pass takes the rest', async () => {
    await seed(12);
    const first = await importEmailAttachments(db, userId, { limit: 5 });
    expect(first.processed).toBe(5);
    expect(await unmarked()).toBe(7);
    const second = await importEmailAttachments(db, userId, { limit: 50 });
    expect(second.processed).toBe(7);
    expect(await unmarked()).toBe(0);
    expect((await importEmailAttachments(db, userId, { limit: 50 })).processed).toBe(0);
  });
});
