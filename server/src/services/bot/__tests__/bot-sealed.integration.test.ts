/**
 * The bot must not notice that content is sealed (ADR 0201). Everything it
 * reads, mail through the `search` tool, and files through the excerpts placed
 * in its prompt, arrives as plaintext, and an ordinary turn runs end to end
 * with encryption on. These run with the mock LLM, so what is asserted is what
 * the bot was GIVEN and what it DID, not what a model said.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import { setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { saveFile } from '@/services/attachments.service.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { selectExcerptsForTurn } from '@/services/bot/retrieval.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const legacy = env as { CONTENT_LEGACY_TSV: boolean };
const originalLegacy = env.CONTENT_LEGACY_TSV;

let db: Kysely<DB>;
let userId: string;
const dirs: string[] = [];

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  setContentEncryption(true);
  legacy.CONTENT_LEGACY_TSV = false;
});
afterEach(async () => {
  legacy.CONTENT_LEGACY_TSV = originalLegacy;
  await closeTestDb(db);
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('an ordinary turn, with encryption on', () => {
  it('"add to Costco list" creates the list and posts a reply', async () => {
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
    const msg = await insertMessage(db, { groupId: group.id, senderId: userId, body: '@Chord add to Costco list - sunscreen, snorkels' });

    await runBotTurn(db, msg, { id: group.id, kind: 'group' });

    const lists = await db.selectFrom('lists').selectAll().where('group_id', '=', group.id).execute();
    expect(lists.map((l) => l.name)).toEqual(['Costco']);
    const items = await db.selectFrom('list_items').select('text').where('list_id', '=', lists[0]!.id).execute();
    expect(items.length).toBeGreaterThanOrEqual(1);
    const replies = await db.selectFrom('messages').select(['kind', 'body']).where('group_id', '=', group.id).where('kind', '=', 'bot').execute();
    expect(replies.length).toBeGreaterThan(0);
  });
});

describe('the bot searching mail', () => {
  it('finds sealed mail by subject, sender name and a body-only word, and shows plaintext', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    const id = await seedSyncedMail(db, userId, {
      subject: 'Permission slip due Friday',
      snippet: 'please sign and return',
      body: 'The zebrafish trip needs a signature.',
      fromName: 'Ms Chen',
      fromEmail: 'office@school.example',
    });

    for (const query of ['permission slip', 'chen', 'zebrafish']) {
      const result = await applyToolCall(db, {
        groupId: personal.id,
        actorUserId: userId,
        provenance: 'test',
        call: { name: 'search', args: { query, categories: ['emails'] } },
      });
      const card = result.cards?.find((c) => c.kind === 'email');
      expect(card, query).toBeDefined();
      expect(card?.title).toBe('Permission slip due Friday'); // opened, not ciphertext
      expect(card?.href).toBe(`/email/${id}`);
      expect(JSON.stringify(result)).not.toContain('enc1.');
    }
  });

  it('a sealed thread is not offered to a different user', async () => {
    const other = await createUser(db, 'mallory');
    const personal = await ensurePersonalGroup(db, other);
    await seedSyncedMail(db, userId, { subject: 'Private permission slip', snippet: 'x' });

    const result = await applyToolCall(db, {
      groupId: personal.id,
      actorUserId: other,
      provenance: 'test',
      call: { name: 'search', args: { query: 'permission', categories: ['emails'] } },
    });
    expect(result.cards?.find((c) => c.kind === 'email')).toBeUndefined();
  });
});

describe('the bot reading files', () => {
  it('its prompt carries the plaintext excerpt of a sealed file', async () => {
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
    dirs.push(path.join(env.FILES_DIR, 'group', group.id));
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId: group.id },
      uploadedBy: userId,
      filename: 'term.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Term calendar.\n\nPickup moves to 2:45 on Fridays.\n\nBring the swimming kit on Thursday.'),
      awaitExtraction: true,
    });
    const trigger = await insertMessage(db, { groupId: group.id, senderId: userId, body: '@Chord what time is pickup on friday' });

    const attachments = await selectExcerptsForTurn(db, {
      groupId: group.id,
      triggeringUserId: userId,
      triggerText: 'what time is pickup on friday',
    });
    const ctx = await buildLlmContext(db, {
      groupId: group.id,
      isPersonal: false,
      triggerMessageId: trigger.id,
      triggeringUserId: userId,
      attachments,
      useNativeTools: false,
    });

    const system = String(ctx[0]!.content);
    expect(attachments.map((a) => a.id)).toContain(att.id);
    expect(system).toContain('2:45');
    expect(system).not.toContain('enc1.');
  });
});
