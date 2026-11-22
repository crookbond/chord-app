/**
 * A turn that leaves a card waiting for the user's tap is answered as a
 * visible reply, not the quiet receipt (ADR 0022). Prod 2026-10-31: a
 * personal-chat "Unsubscribe from 12 lists" card was staged by a turn the
 * receipt hid, and the app draws the confirm buttons only under a visible
 * bot reply - so the card could not be tapped on web or phone, and the
 * bot's note about the two lists left off it was never seen.
 */
import { SSE } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import type { LlmChunk } from '@/services/llm/types.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

const turns = vi.hoisted(() => ({ script: [] as ScriptedTurn[] }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'scripted' as const,
    defaultModel: 'scripted',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(): AsyncIterable<LlmChunk> {
      const turn = turns.script.shift();
      if (turn?.text) yield { type: 'text', delta: turn.text };
      if (turn?.toolCalls) {
        for (const c of turn.toolCalls) yield { type: 'tool_call', call: c };
        yield { type: 'done', reason: 'tool_calls' };
        return;
      }
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

const MAILTO = '<mailto:leave@list.example?subject=unsubscribe>';

describe('a turn that leaves a card waiting is a visible reply', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    userId = await createUser(db, 'alice');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const mailFrom = async (fromName: string, fromEmail: string): Promise<void> => {
    const threadId = newId('et');
    const gid = newId('gt');
    const now = new Date(Date.now() - 86_400_000).toISOString();
    await db
      .insertInto('email_threads')
      .values({ id: threadId, user_id: userId, gmail_thread_id: gid, subject: 'Sale', from_name: fromName, from_email: fromEmail, last_message_at: now, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: gid,
        gmail_message_id: newId('gm'),
        from_name: fromName,
        from_email: fromEmail,
        to_emails: JSON.stringify(['alice@example.org']),
        cc_emails: JSON.stringify([]),
        subject: 'Sale',
        snippet: '',
        gmail_label_ids: JSON.stringify(['INBOX']),
        list_unsubscribe: MAILTO,
        internal_date: now,
        created_at: now,
      })
      .execute();
  };

  const run = async (groupId: string, kind: 'group' | 'personal', body: string) => {
    const trigger = await insertMessage(db, { groupId, senderId: userId, body });
    const events: Array<{ name: string; data: unknown }> = [];
    const unsub = sseHub.onBroadcast((_c, name, data) => events.push({ name, data }));
    try {
      await runBotTurn(db, trigger, { id: groupId, kind });
    } finally {
      unsub();
    }
    const bot = await db
      .selectFrom('messages')
      .select(['body', 'chord_visible'])
      .where('group_id', '=', groupId)
      .where('kind', '=', 'bot')
      .executeTakeFirstOrThrow();
    return { trigger, events, bot };
  };

  it('shows the reply, and the card it staged, when an unsubscribe card is waiting', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    // An established chat, like hers: a first message would start onboarding
    // (ADR 0299), and a guided question is shown anyway, hiding the bug.
    await insertMessage(db, { groupId: personal.id, senderId: userId, body: 'what is on today' });
    await insertMessage(db, { groupId: personal.id, senderId: userId, body: 'thanks' });
    await mailFrom('Thursday Boot Company', 'thursday@thursdayboots.com');
    await mailFrom('Clinique Online', 'clinique@em.clinique.com');
    turns.script.push({
      toolCalls: [
        {
          id: 'c1',
          name: 'unsubscribe_from_senders',
          args: { senders: ['thursday@thursdayboots.com', 'clinique@em.clinique.com'] },
        },
      ],
    });
    turns.script.push({ text: 'I made a card for you to unsubscribe from 2 lists — tap Unsubscribe on it.' });

    const { trigger, events, bot } = await run(
      personal.id,
      'personal',
      'Unsubscribe me from Thursday Boot Company at thursday@thursdayboots.com; Unsubscribe me from Clinique Online at clinique@em.clinique.com',
    );

    const [card] = await db
      .selectFrom('proposals')
      .select(['status', 'proposed_by_message_id'])
      .where('group_id', '=', personal.id)
      .execute();
    expect(card).toMatchObject({ status: 'pending', proposed_by_message_id: trigger.id });
    expect(events.some((e) => e.name === SSE.botReceipt)).toBe(false);
    expect(events.some((e) => e.name === SSE.message && (e.data as { senderId: string | null }).senderId === null)).toBe(true);
    expect(bot.chord_visible).toBe(1);
    expect(bot.body).toMatch(/tap Unsubscribe/);
  });

  it('keeps the quiet receipt for a write that already happened', async () => {
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId });
    turns.script.push({ toolCalls: [{ id: 'c1', name: 'create_task', args: { title: 'pick up milk' } }] });
    turns.script.push({ text: 'Added.' });

    const { events, bot } = await run(group.id, 'group', '@Chord remind me to pick up milk');

    expect(events.some((e) => e.name === SSE.botReceipt)).toBe(true);
    expect(bot.chord_visible).toBe(0);
  });
});
