/**
 * Rewriting an answered card reads only the messages the card can be on.
 *
 * The bug: `markProposalCardsAnswered` searched every saved card in the group
 * with `cards_json LIKE '%<proposalId>%'` on each resolution — a scan that
 * grew with the chat and ran for every confirm, reject and expiry. A card is
 * saved either on the message that staged the proposal (a photo's bundle
 * announcement) or on the bot reply to it (a chat turn), so those are read.
 */
import type { BotCard } from '@chord/kernel';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { postMessage } from '@/services/messages.service.js';
import { markProposalCardsAnswered } from '@/services/proposal-card-status.js';
import { createProposal } from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

class QuerySpy implements KyselyPlugin {
  nodes: RootOperationNode[] = [];
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    this.nodes.push(args.node);
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

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

const card = (proposalId: string): BotCard => ({
  kind: 'action',
  title: 'Sign the slip',
  meta: 'tap to confirm',
  buttons: [
    { label: 'Confirm', callback: { verb: 'p+', id: proposalId } },
    { label: 'Cancel', callback: { verb: 'p-', id: proposalId } },
  ],
});

async function saveCards(messageId: string, cards: BotCard[]) {
  await db
    .insertInto('message_cards')
    .values({ message_id: messageId, cards_json: JSON.stringify(cards), created_at: new Date().toISOString() })
    .execute();
}

async function cardsOn(messageId: string): Promise<BotCard[]> {
  const row = await db.selectFrom('message_cards').select('cards_json').where('message_id', '=', messageId).executeTakeFirstOrThrow();
  return JSON.parse(row.cards_json) as BotCard[];
}

async function stage(stagedBy: string) {
  return createProposal(db, {
    groupId,
    proposedByUserId: userId,
    proposedByMessageId: stagedBy,
    toolName: 'create_task',
    args: { title: 'Sign the slip' },
    provenance: null,
  });
}

describe('markProposalCardsAnswered', () => {
  it('rewrites the card on the bot reply to the staging message', async () => {
    const trigger = await postMessage(db, { groupId, senderId: userId, body: 'remind me to sign the slip' });
    const p = await stage(trigger.id);
    const reply = await postMessage(db, { groupId, senderId: null, body: 'Want me to add it?', replyToId: trigger.id });
    await saveCards(reply.id, [card(p.id)]);

    await markProposalCardsAnswered(db, groupId, p.id, 'confirmed');

    const [c] = await cardsOn(reply.id);
    expect(c!.meta).toBe('✓ Done');
    expect(c!.buttons).toBeUndefined();
  });

  it('rewrites the card on a bundle announcement that staged it', async () => {
    const announcement = await postMessage(db, { groupId, senderId: null, body: '📎 I see 1 task' });
    const p = await stage(announcement.id);
    await saveCards(announcement.id, [card(p.id)]);

    await markProposalCardsAnswered(db, groupId, p.id, 'rejected');

    expect((await cardsOn(announcement.id))[0]!.meta).toBe('Cancelled');
  });

  it('does not text-search every card in the chat', async () => {
    const trigger = await postMessage(db, { groupId, senderId: userId, body: 'remind me to sign the slip' });
    const p = await stage(trigger.id);
    const reply = await postMessage(db, { groupId, senderId: null, body: 'Want me to add it?', replyToId: trigger.id });
    await saveCards(reply.id, [card(p.id)]);

    const spy = new QuerySpy();
    const spied = db.withPlugin(spy);
    await markProposalCardsAnswered(spied, groupId, p.id, 'confirmed');

    const sqls = spy.nodes.map((n) => db.getExecutor().compileQuery(n, { queryId: 'spy' } as never).sql);
    expect(sqls.some((s) => /cards_json"?\s+like/i.test(s))).toBe(false);
    expect((await cardsOn(reply.id))[0]!.meta).toBe('✓ Done');
  });
});
