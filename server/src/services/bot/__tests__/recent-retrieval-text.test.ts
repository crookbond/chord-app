/**
 * Attachment retrieval is built from the last few human turns, so a follow-up
 * that drops the file's keywords ("summarize it") still carries the earlier
 * "nolan vaccine record" terms and re-finds the document.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { recentRetrievalText } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('recentRetrievalText', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('carries recent file keywords into a content-free follow-up', async () => {
    const uid = await createUser(db);
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    await insertMessage(db, { groupId: g.id, senderId: uid, body: 'do you have nolan vaccine record' });
    await insertMessage(db, { groupId: g.id, senderId: uid, body: 'give me the file' });
    const trigger = await insertMessage(db, { groupId: g.id, senderId: uid, body: 'summarize it' });

    const text = await recentRetrievalText(db, g.id, trigger);
    expect(text).toContain('summarize it');
    expect(text.toLowerCase()).toContain('nolan');
    expect(text.toLowerCase()).toContain('vaccine');
  });

  it('always includes the trigger body even if not yet persisted', async () => {
    const uid = await createUser(db);
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const fakeTrigger = {
      id: 'm_unsaved',
      groupId: g.id,
      senderId: uid,
      body: 'when did he get rubella',
      kind: 'text' as const,
      createdAt: new Date().toISOString(),
    } as Parameters<typeof recentRetrievalText>[2];

    const text = await recentRetrievalText(db, g.id, fakeTrigger);
    expect(text).toContain('when did he get rubella');
  });
});
