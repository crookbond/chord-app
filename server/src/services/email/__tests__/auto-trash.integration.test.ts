/**
 * "Send their future mail to Trash" (ADR 0308): only mail that arrives after
 * the rule was set, only from that sender, through the ordinary Trash write.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trashed = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _userId: string, _threadId: string) => ({ ok: true as const })),
);
vi.mock('@/services/bot/email-actions.js', () => ({ trashEmailThread: trashed }));

import type { DB } from '@/db/schema.js';
import { applyAutoTrash, listAutoTrash, setAutoTrash } from '@/services/email/auto-trash.service.js';
import { newId } from '@/utils/ids.js';
import { closeParallelHandle, closeTestDb, createUser, openParallelHandle, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;

describe('send future mail to Trash', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    trashed.mockClear();
    db = await openTestDb();
    userId = await createUser(db, 'peace');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const thread = async (fromEmail: string, at: number, labels = ['INBOX'], archived = 0): Promise<string> => {
    const id = newId('et');
    const iso = new Date(at).toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id,
        user_id: userId,
        gmail_thread_id: newId('gt'),
        subject: 'Offer',
        from_email: fromEmail,
        last_message_at: iso,
        gmail_label_ids: JSON.stringify(labels),
        is_archived: archived,
        created_at: iso,
        updated_at: iso,
      })
      .execute();
    return id;
  };

  it('moves only mail that arrived after the rule, from that sender', async () => {
    const before = await thread('offers@valpak.example', Date.now() - DAY);
    await setAutoTrash(db, userId, ['Offers@Valpak.example'], true);
    const after = await thread('offers@valpak.example', Date.now() + 60_000);
    await thread('hello@school.example', Date.now() + 60_000);
    await thread('offers@valpak.example', Date.now() + 120_000, ['TRASH']);

    expect(await applyAutoTrash(db, userId)).toBe(1);
    expect(trashed.mock.calls.map((c) => c[2])).toEqual([after]);
    expect(trashed.mock.calls.map((c) => c[2])).not.toContain(before);
  });

  it('archived mail it cannot trash does not crowd out new inbox mail', async () => {
    // Audit: the pass selected archived threads too; IMAP refuses to trash
    // one, so 25+ of them re-selected every pass wedged the budget forever.
    await setAutoTrash(db, userId, ['offers@valpak.example'], true);
    for (let i = 0; i < 30; i++) await thread('offers@valpak.example', Date.now() + (100 + i) * 60_000, [], 1);
    const fresh = await thread('offers@valpak.example', Date.now() + 60_000);

    expect(await applyAutoTrash(db, userId)).toBe(1);
    expect(trashed.mock.calls.map((c) => c[2])).toEqual([fresh]);
  });

  it('keeps the original time when turned on twice, and stops when turned off', async () => {
    await setAutoTrash(db, userId, ['offers@valpak.example'], true);
    const [first] = await listAutoTrash(db, userId);
    await setAutoTrash(db, userId, ['offers@valpak.example'], true);
    expect(await listAutoTrash(db, userId)).toEqual([first]);

    await setAutoTrash(db, userId, ['offers@valpak.example'], false);
    expect(await listAutoTrash(db, userId)).toEqual([]);
    await thread('offers@valpak.example', Date.now() + 60_000);
    expect(await applyAutoTrash(db, userId)).toBe(0);
  });
});

describe('auto-trash rules under concurrent writes', () => {
  // Audit: setAutoTrash read the list, changed it, and wrote it back with no
  // lock, so two senders turned on at the same moment kept only one; and at
  // the cap the oldest rule was silently evicted (its mail came back).
  let db: Kysely<DB>;
  let par: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    par = openParallelHandle(db);
    userId = await createUser(db, 'peace');
  });
  afterEach(async () => {
    await closeParallelHandle(par);
    await closeTestDb(db);
  });

  it('two senders turned on at once both stay on', async () => {
    const senders = Array.from({ length: 6 }, (_, i) => `offers${i}@valpak.example`);
    await Promise.all(senders.map((s) => setAutoTrash(par, userId, [s], true)));
    expect((await listAutoTrash(db, userId)).map((r) => r.sender).sort()).toEqual([...senders].sort());
  });

  it('at the cap a new sender is refused, not made room for', async () => {
    const full = Array.from({ length: 200 }, (_, i) => `s${i}@lists.example`);
    await setAutoTrash(db, userId, full, true);
    const out = await setAutoTrash(db, userId, ['new@lists.example'], true);
    expect(out.refused).toEqual(['new@lists.example']);
    const kept = (await listAutoTrash(db, userId)).map((r) => r.sender);
    expect(kept).toHaveLength(200);
    expect(kept).toContain('s0@lists.example');
  });
});
