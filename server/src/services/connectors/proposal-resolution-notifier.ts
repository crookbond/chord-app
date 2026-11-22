/**
 * Proposal-resolution notifier (ADR 0029).
 *
 * Subscribes to `SSE.proposalResolved`. When a proposal resolves
 * (from any surface — mobile pill, TG inline button, /chord confirm
 * tool fence, programmatic), this updates every bridged copy of the
 * bundle announcement to remove the resolved proposal's buttons.
 *
 * Mechanics:
 *   1. Look up the resolved proposal → grab its `bundle_id` and
 *      `proposed_by_message_id`.
 *   2. Read `outbound_connector_messages` for that chord message id —
 *      gives one row per (platform, channel) the announcement was
 *      mirrored to.
 *   3. For each row, build the *remaining* action cards (only pending
 *      proposals in the bundle) and call the connector's
 *      `editActionButtons`. Empty card list → keyboard disappears.
 *
 * The TG renderer + connector handles the actual API call. Slack /
 * Discord connectors don't implement `editActionButtons` yet; the
 * notifier silently skips them.
 */
import type { Kysely } from 'kysely';

import { SSE, type BotCard, type ProposalResolvedEvent } from '@chord/kernel';

import { logger } from '../../config/logging';
import type { DB } from '../../db/schema';
import { buildProposalActionCard } from '../bot/proposal-cards';
import { isLeader } from '../cluster/leadership';
import { sseHub } from '../sse.hub';
import type { ConnectorRegistryView } from './registry-view';

export function startProposalResolutionNotifier(
  db: Kysely<DB>,
  registry: ConnectorRegistryView,
): () => void {
  return sseHub.onBroadcast((_channel, event, data) => {
    if (event !== SSE.proposalResolved) return;
    // ADR 0280 — every web copy hears every broadcast; one of them notifies.
    if (!isLeader('im')) return;
    const payload = data as ProposalResolvedEvent;
    void notifyResolution(db, registry, payload).catch((err) =>
      logger.warn('proposal-resolution-notifier: crashed', {
        err: (err as Error).message,
      }),
    );
  });
}

async function notifyResolution(
  db: Kysely<DB>,
  registry: ConnectorRegistryView,
  payload: ProposalResolvedEvent,
): Promise<void> {
  const proposal = await db
    .selectFrom('proposals')
    .select(['id', 'bundle_id', 'proposed_by_message_id'])
    .where('id', '=', payload.id)
    .executeTakeFirst();
  if (!proposal || !proposal.proposed_by_message_id) return;

  // Find every external mirror of the announcement so we can edit each
  // platform's copy. Skip silently when the message was never mirrored
  // (no bindings, or pre-ADR-0029 message with no recorded id).
  const sends = await db
    .selectFrom('outbound_connector_messages')
    .select([
      'platform',
      'external_channel_id',
      'external_message_id',
      'bot_user_id',
    ])
    .where('chord_message_id', '=', proposal.proposed_by_message_id)
    .execute();
  if (sends.length === 0) return;

  const remainingCards = await buildRemainingProposalCards(
    db,
    proposal.bundle_id,
    proposal.id,
  );

  for (const s of sends) {
    const conn = registry.getForBinding(
      s.platform as 'telegram' | 'slack' | 'discord',
      s.bot_user_id,
    );
    if (!conn || !conn.editActionButtons) continue;
    try {
      await conn.editActionButtons({
        externalChannelId: s.external_channel_id,
        externalMessageId: s.external_message_id,
        cards: remainingCards,
      });
    } catch (err) {
      // Edits expire / fail for the usual TG reasons (message too old,
      // bot removed from chat, etc.). Log-only — the entity state in
      // Chord is correct regardless.
      logger.info('proposal-resolution-notifier: edit failed', {
        platform: s.platform,
        externalChannelId: s.external_channel_id,
        externalMessageId: s.external_message_id,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Rebuild the action-card list for the announcement after `resolvedId`
 * resolves. Returns an empty array when:
 *   - the proposal wasn't part of a bundle (standalone proposal —
 *     the only button is gone, so the keyboard goes too).
 *   - every sibling has resolved (nothing left to confirm).
 */
async function buildRemainingProposalCards(
  db: Kysely<DB>,
  bundleId: string | null,
  resolvedId: string,
): Promise<BotCard[]> {
  if (!bundleId) return [];
  const remaining = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json'])
    .where('bundle_id', '=', bundleId)
    .where('status', '=', 'pending')
    .where('id', '!=', resolvedId)
    .execute();
  return remaining.map((r) => {
    let args: unknown = {};
    try {
      args = JSON.parse(r.args_json) as unknown;
    } catch {
      // Bad json shouldn't break the keyboard rebuild — proposalButtonLabel
      // falls back to the tool name.
    }
    return buildProposalActionCard(r.id, r.tool_name, args);
  });
}
