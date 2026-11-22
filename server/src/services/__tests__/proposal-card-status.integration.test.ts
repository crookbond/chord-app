/**
 * A suggestion card in chat says what happened once it is answered.
 *
 * Prod 2026-10-31: "Unsubscribe from QUADRUPLE-IMPACT MATCH EXPIRING (via
 * DSCC)" was staged at 18:52:14 and confirmed in the app two seconds later;
 * the unsubscribe went through, but the card in chat still read "tap to
 * unsubscribe" - its text is saved on the bot reply when staged and nothing
 * rewrote it on resolve.
 */
import { SSE, type BotCard } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import type { LlmChunk } from '@/services/llm/types.js';
import { answeredProposalCard, startProposalCardStatus } from '@/services/proposal-card-status.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import { settleBackgroundWork } from '@/utils/background.js';
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

const DSCC = 'info@go.dscc.org';

describe('an answered suggestion card says so', () => {
  let db: Kysely<DB>;
  let userId: string;
  let stop: () => void;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    userId = await createUser(db, 'john');
    stop = startProposalCardStatus(db);
  });
  afterEach(async () => {
    stop();
    await closeTestDb(db);
  });

  const dsccMail = async (): Promise<void> => {
    const threadId = newId('et');
    const gid = newId('gt');
    const now = new Date(Date.now() - 86_400_000).toISOString();
    const subject = 'QUADRUPLE-IMPACT MATCH EXPIRING';
    await db
      .insertInto('email_threads')
      .values({ id: threadId, user_id: userId, gmail_thread_id: gid, subject, from_name: 'DSCC', from_email: DSCC, last_message_at: now, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: gid,
        gmail_message_id: newId('gm'),
        from_name: 'DSCC',
        from_email: DSCC,
        to_emails: JSON.stringify(['john@example.org']),
        cc_emails: JSON.stringify([]),
        subject,
        snippet: '',
        gmail_label_ids: JSON.stringify(['INBOX']),
        list_unsubscribe: '<mailto:unsubscribe@go.dscc.org?subject=unsubscribe>',
        internal_date: now,
        created_at: now,
      })
      .execute();
  };

  const stageDsccCard = async (): Promise<{ groupId: string; proposalId: string; botId: string }> => {
    const personal = await ensurePersonalGroup(db, userId);
    await insertMessage(db, { groupId: personal.id, senderId: userId, body: 'what is on today' });
    await insertMessage(db, { groupId: personal.id, senderId: userId, body: 'thanks' });
    await dsccMail();
    turns.script.push({ toolCalls: [{ id: 'c1', name: 'unsubscribe_from_sender', args: { sender: 'go.dscc.org' } }] });
    turns.script.push({ text: 'Tap Unsubscribe on the card.' });
    const trigger = await insertMessage(db, { groupId: personal.id, senderId: userId, body: 'unsubscribe me from DSCC' });
    await runBotTurn(db, trigger, { id: personal.id, kind: 'personal' });
    const proposal = await db
      .selectFrom('proposals')
      .select('id')
      .where('group_id', '=', personal.id)
      .executeTakeFirstOrThrow();
    const bot = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', personal.id)
      .where('kind', '=', 'bot')
      .executeTakeFirstOrThrow();
    return { groupId: personal.id, proposalId: proposal.id, botId: bot.id };
  };

  const savedCard = async (botId: string): Promise<BotCard> => {
    const row = await db
      .selectFrom('message_cards')
      .select('cards_json')
      .where('message_id', '=', botId)
      .executeTakeFirstOrThrow();
    const cards = JSON.parse(row.cards_json) as BotCard[];
    return cards.find((c) => c.title.startsWith('Unsubscribe'))!;
  };

  it('reads Done, with no buttons, once the unsubscribe is confirmed', async () => {
    const { groupId, proposalId, botId } = await stageDsccCard();
    expect((await savedCard(botId)).meta).toBe('tap to unsubscribe');

    const pushed: unknown[] = [];
    const unhook = sseHub.onBroadcast((_c, e, d) => {
      if (e === SSE.botCard) pushed.push(d);
    });
    await db.updateTable('proposals').set({ status: 'confirmed' }).where('id', '=', proposalId).execute();
    sseHub.broadcast(groupId, SSE.proposalResolved, { id: proposalId, status: 'confirmed' });
    await settleBackgroundWork();
    unhook();

    const card = await savedCard(botId);
    expect(card.meta).toBe('✓ Done');
    expect(card.buttons).toBeUndefined();
    expect(card.subtitle).not.toBe('proposed — awaiting confirmation');
    expect(pushed).toEqual([expect.objectContaining({ messageId: botId })]);
  });

  it('reads Cancelled when the card is dismissed', async () => {
    const { groupId, proposalId, botId } = await stageDsccCard();
    sseHub.broadcast(groupId, SSE.proposalResolved, { id: proposalId, status: 'rejected' });
    await settleBackgroundWork();
    expect((await savedCard(botId)).meta).toBe('Cancelled');
  });

  it('keeps the rest of the meta line and drops only the "tap to" part', () => {
    const card: BotCard = {
      kind: 'email',
      title: 'New email: Dinner',
      subtitle: 'proposed — awaiting confirmation',
      meta: 'from me@x.com · to Ana · tap to send',
      buttons: [{ label: 'Send', callback: { verb: 'p+', id: 'prop_1' } }],
    };
    expect(answeredProposalCard(card, 'expired')).toEqual({
      kind: 'email',
      title: 'New email: Dinner',
      meta: 'from me@x.com · to Ana · Expired',
    });
  });
});
