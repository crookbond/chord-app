/**
 * Undo send (ADR 0115). A queued message is a draft with a time on it, so the
 * tests are mostly about that state machine: queue sets the stamp, undo clears
 * it, a failed send clears it too and leaves a reason.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listDrafts, saveDraft } from '@/services/email/drafts.service.js';
import {
  cancelQueuedSend,
  flushDueSends,
  queueSend,
} from '@/services/email/outbox.service.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

async function queuedDraft(): Promise<string> {
  const draft = await saveDraft(db, userId, {
    kind: 'new',
    to: ['them@example.com'],
    subject: 'Ladder',
    body: 'Saturday?',
  });
  const queued = await queueSend(db, userId, draft.id);
  return queued!.draftId;
}

/** Make a queued message due, without waiting out the real undo window. */
async function makeDue(id: string): Promise<void> {
  await db
    .updateTable('email_drafts')
    .set({ send_after: new Date(Date.now() - 1000).toISOString() })
    .where('id', '=', id)
    .execute();
}

const rowOf = (id: string) =>
  db
    .selectFrom('email_drafts')
    .select(['send_after', 'last_error'])
    .where('id', '=', id)
    .executeTakeFirst();

describe('undo send', () => {
  it('holds the message instead of sending it', async () => {
    const id = await queuedDraft();

    expect(await flushDueSends(db)).toBe(0);
    expect((await rowOf(id))?.send_after).toBeTruthy();
  });

  it('takes a queued message out of the Drafts list', async () => {
    // It is on its way out, not something to pick up and edit.
    await queuedDraft();

    expect(await listDrafts(db, userId)).toHaveLength(0);
  });

  it('undo puts it back where it was being written', async () => {
    const id = await queuedDraft();

    expect(await cancelQueuedSend(db, userId, id)).toBe(true);
    expect((await rowOf(id))?.send_after).toBeNull();
    expect(await listDrafts(db, userId)).toHaveLength(1);
  });

  it('sends it once the hold expires, and the draft is gone', async () => {
    const id = await queuedDraft();
    await makeDue(id);

    expect(await flushDueSends(db)).toBe(1);
    expect(await rowOf(id)).toBeUndefined();
  });

  it('refuses an undo for a message that already went', async () => {
    // The honest answer to a tap that lost the race. Reporting success would
    // tell the sender we stopped something we did not.
    const id = await queuedDraft();
    await makeDue(id);
    await flushDueSends(db);

    expect(await cancelQueuedSend(db, userId, id)).toBe(false);
  });

  it('never sends the same message twice', async () => {
    // Two overlapping ticks. A duplicate email is not something an apology
    // fixes, so the row is claimed before the provider is called.
    const id = await queuedDraft();
    await makeDue(id);

    const [a, b] = await Promise.all([flushDueSends(db), flushDueSends(db)]);

    expect(a + b).toBe(1);
  });

  it('is scoped to its owner', async () => {
    const bob = await createUser(db, 'bob');
    const id = await queuedDraft();

    expect(await cancelQueuedSend(db, bob, id)).toBe(false);
    expect((await rowOf(id))?.send_after).toBeTruthy();
  });

  it('a message that cannot go becomes a draft again, with the reason', async () => {
    // Not a retry loop: ADR 0103 had one of those re-push the same failure for
    // two months. Here it lands where the user is looking.
    const draft = await saveDraft(db, userId, {
      kind: 'new',
      to: ['them@example.com'],
      body: 'x',
      attachmentIds: ['att_does_not_exist'],
    });
    const queued = await queueSend(db, userId, draft.id);
    await makeDue(queued!.draftId);

    expect(await flushDueSends(db)).toBe(0);
    const row = await rowOf(queued!.draftId);
    expect(row?.send_after).toBeNull();
    expect(row?.last_error).toBeTruthy();
    expect(await listDrafts(db, userId)).toHaveLength(1);
  });

  it('refuses to queue a draft that is not the user\'s', async () => {
    const bob = await createUser(db, 'bob');
    const draft = await saveDraft(db, userId, { kind: 'new', body: 'x' });

    expect(await queueSend(db, bob, draft.id)).toBeNull();
  });
});
