/**
 * Telegram callback_query handler (ADR 0029).
 *
 * Decodes the `data` field of a callback_query update (encoded as
 * `verb:id` by `telegram.renderer.ts`), looks up the tapping TG user's
 * Chord identity, checks group membership, and routes to a verb-
 * specific handler. Returns a short toast string that the connector
 * uses to call `answerCallbackQuery`.
 *
 * The function always returns a toast — even on permission denial or
 * stale-button cases — because Telegram's UI shows a spinner on the
 * button until `answerCallbackQuery` fires. Silent failure is worse
 * than a "you can't do that" toast.
 */
import type { Kysely } from 'kysely';

import { SSE } from '@chord/kernel';

import { logger } from '../../../config/logging';
import type { DB } from '../../../db/schema';
import { runInBackground } from '../../../utils/background';
import { runDailyScanForUserNow } from '../../proactive.service';
import { sseHub } from '../../sse.hub';
import {
  confirmProposal,
  getProposal,
  rejectProposal,
} from '../../proposals.service';
import { lookupIdentity } from '../identity-resolver';
import type { ConnectorPlatform } from '../types';
import { claimPendingBriefing, optOutOfBriefing } from '../whatsapp/session-window';

export interface CallbackContext {
  /** External user id (string) of whoever tapped the button. */
  externalUserId: string;
  /** The bot identity that received the update. Null for deploy-wide. */
  receivedByBotUserId: string | null;
  /** The payload from the button: `callback_data` (Telegram) /
   *  `ButtonPayload` (WhatsApp), encoded `verb:id`. */
  data: string;
  /** Platform the tap came from, for identity lookup. Defaults to telegram
   *  (the original ADR 0029 surface). WhatsApp (ADR 0053 §7) passes its own. */
  platform?: ConnectorPlatform;
}

export interface CallbackResult {
  /** Short toast for `answerCallbackQuery.text`. Always set. */
  toast: string;
  /** When true, TG renders the toast as a modal alert instead of a
   *  brief banner. Reserve for important confirmations / errors. */
  alert?: boolean;
  /**
   * ADR 0091 — the group this toast belongs to, when the toast is really a
   * message body rather than a banner. `handleButtonTap` turns it into a
   * "read more" link: on WhatsApp the follow-up IS the briefing delivery, and
   * a briefing routinely exceeds the 1600-char cap, so without this it was
   * clipped to a bare `…` with no way to read the rest.
   */
  groupId?: string;
}

const VERB_RE = /^([a-zA-Z+-]{1,8}):(.{1,60})$/;

export async function handleCallback(
  db: Kysely<DB>,
  ctx: CallbackContext,
): Promise<CallbackResult> {
  const match = ctx.data.match(VERB_RE);
  if (!match) {
    logger.info('tg callback: unparseable data', { data: ctx.data });
    return { toast: "Sorry, I couldn't read that button." };
  }
  const [, verb, id] = match;
  const platform = ctx.platform ?? 'telegram';

  switch (verb) {
    case 'p+':
      return await handleProposalConfirm(db, id, ctx.externalUserId, platform);
    case 'p-':
      return await handleProposalReject(db, id, ctx.externalUserId, platform);
    // ADR 0089 — answers to the out-of-window briefing nudge. WhatsApp only.
    case 'n+':
      return await handleBriefingYes(db, ctx.externalUserId, platform);
    case 'n-':
      return await handleBriefingNo(db, ctx.externalUserId, platform);
    default:
      logger.info('tg callback: unknown verb', { verb, data: ctx.data });
      return { toast: 'Unknown action.' };
  }
}

/**
 * ADR 0089 — "Yes, send it". The tap itself reopened WhatsApp's session window
 * (`recordInbound` stamps it on every inbound), so the parked briefing can now
 * go out as ordinary text. It rides back as the toast because `handleButtonTap`
 * posts that as a follow-up message — on WhatsApp the follow-up IS the delivery.
 */
async function handleBriefingYes(
  db: Kysely<DB>,
  externalUserId: string,
  platform: ConnectorPlatform,
): Promise<CallbackResult> {
  if (platform !== 'whatsapp') return { toast: 'Unknown action.' };
  const pending = await claimPendingBriefing(db, externalUserId);
  // Nothing parked: a stale tap on a prompt whose briefing already went out,
  // or one the user answered twice. Say so rather than sending nothing.
  if (!pending) {
    return { toast: "You're all caught up — nothing waiting right now." };
  }
  // The parked briefing is from an earlier day and none was posted today. Run
  // today's now; it posts to the personal chat and the outbound publisher
  // forwards it here (the tap just reopened the window), so this reply only
  // says it is coming. The scan is an LLM call, too slow to hold the webhook.
  if (pending.refreshForUserId) {
    runInBackground(
      runDailyScanForUserNow(db, pending.refreshForUserId),
      'whatsapp full briefing refresh',
    );
    return { toast: "Getting today's briefing — it'll be here in a moment." };
  }
  return { toast: pending.body, groupId: pending.groupId };
}

/**
 * ADR 0089 §5 — "No thanks". Channel-scoped: this mutes WhatsApp briefings for
 * this binding only. `users.nudge_enabled` is deliberately untouched, so the
 * briefing keeps arriving in-app and by push, and the reply says so — otherwise
 * a user who taps No has no way to know the feature still exists elsewhere.
 */
async function handleBriefingNo(
  db: Kysely<DB>,
  externalUserId: string,
  platform: ConnectorPlatform,
): Promise<CallbackResult> {
  if (platform !== 'whatsapp') return { toast: 'Unknown action.' };
  await optOutOfBriefing(db, externalUserId);
  // Deliberately does NOT promise that writing back re-enables it: the opt-out
  // is sticky (`recordInbound` clears only the ask marker), so saying otherwise
  // would be false. Re-enabling needs an affordance that does not exist yet.
  return {
    toast:
      "Done — no more briefings on WhatsApp. You'll still find it in the Chord app each morning.",
  };
}

async function handleProposalConfirm(
  db: Kysely<DB>,
  proposalId: string,
  externalUserId: string,
  platform: ConnectorPlatform,
): Promise<CallbackResult> {
  const proposal = await getProposal(db, proposalId);
  if (!proposal) return { toast: 'That proposal is gone.' };

  const auth = await resolveCaller(db, externalUserId, proposal.groupId, platform);
  if (!auth.ok) return { toast: auth.toast };

  const result = await confirmProposal(db, {
    id: proposalId,
    resolvedByUserId: auth.userId,
  });
  if (!result.ok) {
    switch (result.reason) {
      case 'already_resolved':
        return { toast: 'Already resolved.' };
      case 'expired':
        return { toast: 'That proposal expired.' };
      case 'not_found':
        return { toast: 'That proposal is gone.' };
      case 'invalid_args':
        return { toast: `Couldn't confirm — ${result.message ?? 'invalid'}.` };
      default:
        return { toast: "Couldn't confirm that. Try the app." };
    }
  }
  for (const affId of result.affected) {
    sseHub.broadcast(proposal.groupId, SSE.proposalResolved, {
      id: affId,
      status: 'confirmed',
    });
  }
  return { toast: '✓ Confirmed' };
}

async function handleProposalReject(
  db: Kysely<DB>,
  proposalId: string,
  externalUserId: string,
  platform: ConnectorPlatform,
): Promise<CallbackResult> {
  const proposal = await getProposal(db, proposalId);
  if (!proposal) return { toast: 'That proposal is gone.' };

  const auth = await resolveCaller(db, externalUserId, proposal.groupId, platform);
  if (!auth.ok) return { toast: auth.toast };

  const updated = await rejectProposal(db, {
    id: proposalId,
    resolvedByUserId: auth.userId,
  });
  if (!updated) return { toast: 'Already resolved.' };
  for (const affId of updated.affected) {
    sseHub.broadcast(proposal.groupId, SSE.proposalResolved, {
      id: affId,
      status: 'rejected',
    });
  }
  return { toast: '✗ Skipped' };
}

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; toast: string };

async function resolveCaller(
  db: Kysely<DB>,
  externalUserId: string,
  groupId: string,
  platform: ConnectorPlatform,
): Promise<AuthResult> {
  const identity = await lookupIdentity(db, platform, externalUserId);
  if (!identity) {
    return { ok: false, toast: "I don't recognize this account." };
  }
  const member = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .where('user_id', '=', identity.userId)
    .executeTakeFirst();
  if (!member) {
    return { ok: false, toast: "You're not a member of that Chord group." };
  }
  return { ok: true, userId: identity.userId };
}
