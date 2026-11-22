/**
 * ADR 0333 — the facts a chat turn sees name who each is about.
 *
 * Prod, 11 Nov 2026: asked "What is ben global entry" in the personal chat,
 * the bot answered with another family member's Global Entry number. Both
 * numbers were saved, but the prompt listed them as
 * `[persona] global_entry_number: <n>` with nothing saying whose was whose,
 * and only the 12 highest-confidence facts were shown at all.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { ALL_FACTS_UP_TO, factsForTurn, turnFactsBlock } from '@/services/bot/turn-facts.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { writeMemory } from '@/services/memory.service.js';
import { createPerson } from '@/services/people.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let groupId: string;
let ben: string;
let nolan: string;

async function factAbout(personId: string, key: string, value: string) {
  await writeMemory(db, {
    groupId,
    scope: 'persona',
    personaId: john,
    subjectType: 'person',
    subjectId: personId,
    key,
    value,
    source: 'explicit',
    status: 'confirmed',
    confidence: 1,
  });
}

async function postMessage(body: string): Promise<string> {
  const id = newId('m');
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: john,
      kind: 'text',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 1,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  groupId = (await ensurePersonalGroup(db, john)).id;
  ben = (await createPerson(db, { ownerUserId: john, displayName: 'Ben Doe' })).id;
  nolan = (await createPerson(db, { ownerUserId: john, displayName: 'Nolan Doe' })).id;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('facts in the chat prompt name their person', () => {
  it('puts the person on each of two Global Entry numbers (the prod failure)', async () => {
    await factAbout(nolan, 'global_entry_number', '154800334');
    await factAbout(ben, 'global_entry_number', '155605322');
    const trigger = await postMessage('What is ben global entry');

    const ctx = await buildLlmContext(db, {
      groupId,
      isPersonal: true,
      triggerMessageId: trigger,
      triggeringUserId: john,
      attachments: [],
      useNativeTools: false,
    });
    const system = String(ctx[0].content);
    expect(system).toContain('- Ben Doe · global entry number: 155605322');
    expect(system).toContain('- Nolan Doe · global entry number: 154800334');
    expect(system).not.toMatch(/\]\s*global_entry_number:/);
  });

  it('shows every fact, not the first 12, while the chat holds a normal number', async () => {
    for (let i = 0; i < 40; i++) await factAbout(nolan, `fact_${i}`, `value ${i}`);
    await factAbout(ben, 'global_entry_number', '155605322');

    const found = await factsForTurn(db, { groupId, userId: john, text: 'hello' });
    expect(found.total).toBe(41);
    expect(found.facts).toHaveLength(41);
    expect(turnFactsBlock(found, { isPersonal: true })).not.toContain('more saved facts');
  });

  it('above that, keeps every fact about the person named and every fact on the topic asked', async () => {
    // Filler from another person, written first so it is never "newest".
    for (let i = 0; i < ALL_FACTS_UP_TO + 40; i++) await factAbout(nolan, `hobby_${i}`, `thing ${i}`);
    await factAbout(nolan, 'global_entry_number', '154800334');
    for (let i = 0; i < 20; i++) await factAbout(ben, `detail_${i}`, `ben ${i}`);
    await factAbout(ben, 'global_entry_number', '155605322');
    // Newer than both Global Entry facts, so neither gets in by being new.
    for (let i = 0; i < 20; i++) await factAbout(nolan, `recent_${i}`, `recent ${i}`);

    const found = await factsForTurn(db, { groupId, userId: john, text: 'What is ben global entry' });
    const lines = found.facts.map((f) => `${f.about}|${f.memory.key}|${f.memory.value}`);
    // Every fact about Ben, whatever its topic.
    expect(lines).toContain('Ben Doe|global_entry_number|155605322');
    for (let i = 0; i < 20; i++) expect(lines).toContain(`Ben Doe|detail_${i}|ben ${i}`);
    // The other Global Entry number is shown too — labelled, so it cannot be mistaken.
    expect(lines).toContain('Nolan Doe|global_entry_number|154800334');
    // Unrelated old facts are left for list_memories.
    expect(lines).not.toContain('Nolan Doe|hobby_0|thing 0');
    const block = turnFactsBlock(found, { isPersonal: true });
    expect(block).toContain('more saved facts are not shown');
    expect(block).toContain('list_memories');
  });

  it("a follow-up keeps the person from the user's previous message", async () => {
    for (let i = 0; i < ALL_FACTS_UP_TO + 10; i++) await factAbout(nolan, `hobby_${i}`, `thing ${i}`);
    await factAbout(ben, 'passport_number', 'P1234567');
    for (let i = 0; i < 20; i++) await factAbout(nolan, `recent_${i}`, `recent ${i}`);
    await postMessage('What is ben global entry');
    const trigger = await postMessage('and the passport?');

    const ctx = await buildLlmContext(db, {
      groupId,
      isPersonal: true,
      triggerMessageId: trigger,
      triggeringUserId: john,
      attachments: [],
      useNativeTools: false,
    });
    expect(String(ctx[0].content)).toContain('- Ben Doe · passport number: P1234567');
  });
});
