/**
 * The action axis: what a thread wants FROM YOU, orthogonal to the category
 * tree that says what it is about. One value per thread, independent of where
 * it sits in the tree.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmailClassificationSnapshot } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { parseClassifierResponse } from '@/services/email/llm-classifier.js';
import { classifyAction } from '@/services/email/mock-classifier.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(userId: string, gmailThreadId: string): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gmailThreadId,
      subject: gmailThreadId,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

const CATS = [{ id: 'c1', parentId: null, title: 'Friends & family', depth: 0 }];

function snap(
  userId: string,
  assignments: EmailClassificationSnapshot['assignments'],
): EmailClassificationSnapshot {
  return { version: 1, userId, categories: CATS, assignments };
}

async function actionOf(threadId: string): Promise<string | null> {
  const row = await db
    .selectFrom('email_threads')
    .select('action')
    .where('id', '=', threadId)
    .executeTakeFirst();
  return row?.action ?? null;
}

describe('action axis - ingest', () => {
  it('persists the action alongside the category', async () => {
    const uid = await createUser(db, 'alice');
    const t = await seedThread(uid, 'g1');

    await ingestClassification(
      db,
      uid,
      snap(uid, [{ gmailThreadId: 'g1', categoryId: 'c1', action: 'reply_needed' }]),
    );

    expect(await actionOf(t)).toBe('reply_needed');
  });

  it('defaults a missing action to other, not null', async () => {
    // The external classifier (ADR 0061 seam) may predate this axis; a
    // classified thread must still have an action so filters never hide it.
    const uid = await createUser(db, 'alice');
    const t = await seedThread(uid, 'g1');

    await ingestClassification(db, uid, snap(uid, [{ gmailThreadId: 'g1', categoryId: 'c1' }]));

    expect(await actionOf(t)).toBe('other');
  });

  it('is independent of the category - one category, different actions', async () => {
    const uid = await createUser(db, 'alice');
    const a = await seedThread(uid, 'g1');
    const b = await seedThread(uid, 'g2');

    await ingestClassification(
      db,
      uid,
      snap(uid, [
        { gmailThreadId: 'g1', categoryId: 'c1', action: 'reply_needed' },
        { gmailThreadId: 'g2', categoryId: 'c1', action: 'informational' },
      ]),
    );

    expect(await actionOf(a)).toBe('reply_needed');
    expect(await actionOf(b)).toBe('informational');
  });

  it('clears the action on snapshot-replace when the thread drops out', async () => {
    const uid = await createUser(db, 'alice');
    const t = await seedThread(uid, 'g1');
    await ingestClassification(
      db,
      uid,
      snap(uid, [{ gmailThreadId: 'g1', categoryId: 'c1', action: 'to_do' }]),
    );

    await ingestClassification(db, uid, snap(uid, []));

    expect(await actionOf(t)).toBeNull();
  });
});

describe('action axis - filtering', () => {
  it('filters the thread list by action, and composes with no filter', async () => {
    const uid = await createUser(db, 'alice');
    await seedThread(uid, 'g1');
    await seedThread(uid, 'g2');
    await seedThread(uid, 'g3');
    await ingestClassification(
      db,
      uid,
      snap(uid, [
        { gmailThreadId: 'g1', categoryId: 'c1', action: 'to_do' },
        { gmailThreadId: 'g2', categoryId: 'c1', action: 'reply_needed' },
        { gmailThreadId: 'g3', categoryId: 'c1', action: 'informational' },
      ]),
    );

    const all = await listThreads(db, uid, {});
    const actionable = await listThreads(db, uid, { actions: ['to_do', 'reply_needed'] });

    expect(all).toHaveLength(3);
    expect(actionable.map((t) => t.action).sort()).toEqual(['reply_needed', 'to_do']);
  });

  it('exposes the action on the thread summary', async () => {
    const uid = await createUser(db, 'alice');
    await seedThread(uid, 'g1');
    await ingestClassification(
      db,
      uid,
      snap(uid, [{ gmailThreadId: 'g1', categoryId: 'c1', action: 'to_do' }]),
    );

    const [thread] = await listThreads(db, uid, {});
    expect(thread.action).toBe('to_do');
  });

  it('filters to unread threads, and composes with an action filter', async () => {
    const uid = await createUser(db, 'alice');
    const unreadTodo = await seedThread(uid, 'g1');
    const unreadFyi = await seedThread(uid, 'g2');
    await seedThread(uid, 'g3');
    await db
      .updateTable('email_threads')
      .set({ is_unread: 1 })
      .where('id', 'in', [unreadTodo, unreadFyi])
      .execute();
    await ingestClassification(
      db,
      uid,
      snap(uid, [
        { gmailThreadId: 'g1', categoryId: 'c1', action: 'to_do' },
        { gmailThreadId: 'g2', categoryId: 'c1', action: 'informational' },
        { gmailThreadId: 'g3', categoryId: 'c1', action: 'to_do' },
      ]),
    );

    const unread = await listThreads(db, uid, { unreadOnly: true });
    expect(unread.map((t) => t.id).sort()).toEqual([unreadTodo, unreadFyi].sort());
    const unreadTodos = await listThreads(db, uid, { unreadOnly: true, actions: ['to_do'] });
    expect(unreadTodos.map((t) => t.id)).toEqual([unreadTodo]);
  });

  it('leaves an unclassified thread with a null action', async () => {
    const uid = await createUser(db, 'alice');
    await seedThread(uid, 'g1');

    const [thread] = await listThreads(db, uid, {});
    expect(thread.action).toBeNull();
  });
});

describe('action axis - LLM response parsing', () => {
  const allowed = new Set(['g1']);

  it('parses a valid action', () => {
    const out = parseClassifierResponse(
      '{"assignments":[{"gmailThreadId":"g1","path":["Travel"],"action":"to_do"}]}',
      allowed,
      3,
    );
    expect(out[0].action).toBe('to_do');
  });

  it('drops an unknown action rather than persisting garbage', () => {
    const out = parseClassifierResponse(
      '{"assignments":[{"gmailThreadId":"g1","path":["Travel"],"action":"URGENT!!"}]}',
      allowed,
      3,
    );
    expect(out).toHaveLength(1);
    expect(out[0].action).toBeUndefined();
  });

  it('still classifies when the action is absent', () => {
    const out = parseClassifierResponse(
      '{"assignments":[{"gmailThreadId":"g1","path":["Travel"]}]}',
      allowed,
      3,
    );
    expect(out[0].path).toEqual(['Travel']);
    expect(out[0].action).toBeUndefined();
  });
});

describe('action axis - mock fixture', () => {
  it('reads an RSVP as a to-do and a statement as informational', () => {
    expect(classifyAction('Maya birthday party - RSVP by Tue')).toBe('to_do');
    expect(classifyAction('Your March statement is ready')).toBe('informational');
  });

  it('is deterministic', () => {
    expect(classifyAction('Permission slip due Friday')).toBe(
      classifyAction('Permission slip due Friday'),
    );
  });
});
