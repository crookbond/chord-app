/**
 * A suggestion card in chat says what happened to it once it is answered.
 *
 * The card's text ("tap to unsubscribe", "proposed — awaiting confirmation")
 * is saved on the bot reply when the card is staged, and the app and the
 * bridges draw that saved text. Answering a card used to remove only its
 * buttons, so a done unsubscribe still read "tap to unsubscribe" forever.
 *
 * Hangs off `onBroadcast` like the To Do's mirror (ADR 0105): proposals are
 * settled from about ten places (app, Telegram, WhatsApp YES/NO, typed
 * confirm, expiry, a deleted email) and every one of them broadcasts
 * `proposal.resolved`, so none has to remember to call this.
 */
import type { Kysely } from 'kysely';

import { SSE, type BotCard, type ProposalResolvedEvent } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { DB } from '../db/schema.js';
import { runInBackground } from '../utils/background.js';
import { isLeader } from './cluster/leadership.js';
import { sseHub } from './sse.hub.js';

type Outcome = ProposalResolvedEvent['status'];

const AWAITING = 'proposed — awaiting confirmation';

const OUTCOME_TEXT: Record<Outcome, string> = {
  confirmed: '✓ Done',
  rejected: 'Cancelled',
  expired: 'Expired',
};

function answersProposal(card: BotCard, proposalId: string): boolean {
  if (card.callback?.id === proposalId) return true;
  return (card.buttons ?? []).some((b) => b.callback?.id === proposalId);
}

/**
 * The card as it reads once answered: the "tap to …" part of its meta is
 * replaced by the outcome, the waiting subtitle goes, and so do the
 * confirm/cancel buttons (nothing is left to answer).
 */
export function answeredProposalCard(card: BotCard, outcome: Outcome): BotCard {
  const parts = (card.meta ?? '')
    .split(' · ')
    .map((p) => p.trim())
    .filter((p) => p && !/^tap to\b/i.test(p));
  parts.push(OUTCOME_TEXT[outcome]);
  const next: BotCard = { ...card, meta: parts.join(' · ') };
  if (next.subtitle === AWAITING) delete next.subtitle;
  delete next.buttons;
  delete next.callback;
  return next;
}

/**
 * Rewrite every saved card in the group that answers this proposal.
 *
 * A proposal's card is saved on exactly one of two messages: the message that
 * staged it (`proposed_by_message_id` — a photo's "I see 2 tasks" announcement)
 * or the bot reply to it (`reply_to_id` — a chat turn stages with the user's
 * message as trigger, and the reply carries the card). Only those are read; a
 * proposal with no staging message (email suggestions) has no chat card. Not a
 * text search over every card in the group, which grew with the chat.
 */
export async function markProposalCardsAnswered(
  db: Kysely<DB>,
  groupId: string,
  proposalId: string,
  outcome: Outcome,
): Promise<void> {
  const proposal = await db
    .selectFrom('proposals')
    .select('proposed_by_message_id')
    .where('id', '=', proposalId)
    .executeTakeFirst();
  const stagedBy = proposal?.proposed_by_message_id;
  if (!stagedBy) return;
  const trigger = await db
    .selectFrom('messages')
    .select('created_at')
    .where('id', '=', stagedBy)
    .where('group_id', '=', groupId)
    .executeTakeFirst();
  if (!trigger) return;
  const rows = await db
    .selectFrom('message_cards')
    .innerJoin('messages', 'messages.id', 'message_cards.message_id')
    .select(['message_cards.message_id as messageId', 'message_cards.cards_json as cardsJson'])
    .where('messages.group_id', '=', groupId)
    // The reply follows its trigger; bounding by time keeps the scan on the
    // (group_id, created_at) index instead of the whole chat.
    .where('messages.created_at', '>=', trigger.created_at)
    .where((eb) =>
      eb.or([eb('messages.id', '=', stagedBy), eb('messages.reply_to_id', '=', stagedBy)]),
    )
    .execute();
  for (const row of rows) {
    let cards: BotCard[];
    try {
      const parsed = JSON.parse(row.cardsJson) as unknown;
      if (!Array.isArray(parsed)) continue;
      cards = parsed as BotCard[];
    } catch {
      continue;
    }
    let changed = false;
    const next = cards.map((c) => {
      if (!answersProposal(c, proposalId)) return c;
      changed = true;
      return answeredProposalCard(c, outcome);
    });
    if (!changed) continue;
    await db
      .updateTable('message_cards')
      .set({ cards_json: JSON.stringify(next) })
      .where('message_id', '=', row.messageId)
      .execute();
    sseHub.broadcast(groupId, SSE.botCard, { messageId: row.messageId, cards: next });
  }
}

export function startProposalCardStatus(db: Kysely<DB>): () => void {
  return sseHub.onBroadcast((channel, event, data) => {
    if (event !== SSE.proposalResolved) return;
    if (channel.startsWith('user:')) return;
    // ADR 0280 — every worker copy hears every broadcast; one of them writes.
    if (!isLeader('worker')) return;
    const { id, status } = data as ProposalResolvedEvent;
    runInBackground(
      markProposalCardsAnswered(db, channel, id, status).catch((err) =>
        logger.warn('proposal card status update failed', { proposalId: id, err: (err as Error).message }),
      ),
    );
  });
}
