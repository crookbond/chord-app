/**
 * The bot's `search` tool must turn an email hit into a tappable card
 * (ADR 0059) - `buildSearchCards` used to omit `emails` entirely from its
 * param type and body, so a question like "emails about school" answered in
 * prose with nothing to tap: no card, no `router.push`, no way back to the
 * thread's own decisions screen (`/email/[threadId].tsx`).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedEmail(
  userId: string,
  subject: string,
  opts: { action?: 'to_do' | 'reply_needed' | 'informational' | 'other' } = {},
): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: id,
      subject,
      snippet: 'please sign and return',
      from_email: 'office@example.org',
      action: opts.action ?? null,
      is_archived: 0,
      gmail_label_ids: JSON.stringify(['INBOX']),
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

describe('the search tool turns an email hit into a tappable card', () => {
  it('produces a kind:"email" card that deep-links to the thread', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const threadId = await seedEmail(uid, 'Permission slip due Friday', { action: 'to_do' });

    const result = await applyToolCall(db, {
      groupId: personal.id,
      actorUserId: uid,
      provenance: 'test',
      call: { name: 'search', args: { query: 'permission slip', categories: ['emails'] } },
    });

    const emailCard = result.cards?.find((c) => c.kind === 'email');
    expect(emailCard).toBeDefined();
    expect(emailCard?.title).toBe('Permission slip due Friday');
    expect(emailCard?.subtitle).toBe('office@example.org');
    // The thread's own decisions screen - the one that renders its magic
    // suggestions - not a category/tile list.
    expect(emailCard?.href).toBe(`/email/${threadId}`);
    expect(emailCard?.meta).toBe('to_do');
  });

  it('falls back to the received date when the thread has no action', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Permission slip due Friday');

    const result = await applyToolCall(db, {
      groupId: personal.id,
      actorUserId: uid,
      provenance: 'test',
      call: { name: 'search', args: { query: 'permission slip', categories: ['emails'] } },
    });

    const emailCard = result.cards?.find((c) => c.kind === 'email');
    expect(emailCard?.meta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never produces an email card from a shared group (ADR 0032)', async () => {
    const uid = await createUser(db, 'alice');
    await seedEmail(uid, 'Permission slip due Friday');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });

    const result = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: 'test',
      call: { name: 'search', args: { query: 'permission slip' } },
    });

    expect(result.cards?.some((c) => c.kind === 'email')).toBe(false);
  });
});
