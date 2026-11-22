/**
 * ADR 0220 — a file sent with nothing to say gets no bot reply; the
 * auto-filer's own "📎 Indexed —…" line is the acknowledgment.
 *
 * 2026-10-24 test run: a United confirmation screenshot sent from the app got
 * a visible reply on every try, on both models ("Importing the calendar —
 * events should appear shortly", "resend what you want me to do with it").
 * The app posts a picked file with the body `📎 <filename>`, and the bare
 * check kept the filename as if it were an instruction.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('a file sent from the app with no message', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const upload = async (filename: string, mimeType: string): Promise<string> => {
    const id = newId('a');
    const now = new Date().toISOString();
    await db
      .insertInto('attachments')
      .values({
        id,
        scope_kind: 'group',
        scope_id: groupId,
        uploaded_by: userId,
        filename,
        mime_type: mimeType,
        size: 1024,
        path: `test/${id}`,
        summary: null,
        extracted_text: null,
        image_meta: null,
        pinned: 0,
        indexed_at: now,
        created_at: now,
      })
      .execute();
    return id;
  };

  const botReplies = () =>
    db
      .selectFrom('messages')
      .select(['body', 'chord_visible'])
      .where('group_id', '=', groupId)
      .where('kind', '=', 'bot')
      .execute();

  it('the test-run case: "📎 united-confirmation.png" gets no visible reply', async () => {
    const attachmentId = await upload('united-confirmation.png', 'image/png');
    const trigger = await insertMessage(db, {
      groupId,
      senderId: userId,
      body: '📎 united-confirmation.png',
      attachmentId,
    });

    await runBotTurn(db, trigger, { id: groupId, kind: 'personal' });

    const replies = await botReplies();
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((r) => r.chord_visible === 0)).toBe(true);
  });

  it('a question sent with the file still gets an answer', async () => {
    const attachmentId = await upload('united-confirmation.png', 'image/png');
    const trigger = await insertMessage(db, {
      groupId,
      senderId: userId,
      body: 'what time does the first flight leave?',
      attachmentId,
    });

    await runBotTurn(db, trigger, { id: groupId, kind: 'personal' });

    expect((await botReplies()).some((r) => r.chord_visible === 1)).toBe(true);
  });
});
