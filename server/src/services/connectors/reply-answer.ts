/**
 * A typed YES / NO answers the proposal cards just shown on that chat app.
 *
 * WhatsApp sends at most three buttons per message, so a turn that proposes
 * two things arrives as text ending "Reply YES to confirm all of these, or NO
 * to cancel them." (`renderers/proposal-answer.ts`). This is what makes that
 * sentence true. It also covers someone who types "yes" instead of pressing a
 * button that was there.
 *
 * Narrow on purpose, because a bare "yes" is also how people answer the bot's
 * questions: only the sender's OWN pending proposals in this chat, staged
 * after their previous message on this same app (what that message set off —
 * a request, or a photo whose contents were turned into cards) and within the
 * last `WINDOW_MS`, and only cards actually SENT to this chat (each connector
 * send is recorded in `outbound_connector_messages`). A card shown only in the
 * Chord app, or staged in the background by an email pass, is not what a
 * WhatsApp "yes" is about. Nothing matching = not handled, and the message goes to the
 * bot as usual. Each
 * answer goes through the same handler as a button press, so membership and
 * the per-tool rules (only the asker may confirm, ADR 0242) are unchanged.
 */
import type { Kysely } from 'kysely';

import type { BotCard } from '@chord/kernel';

import type { DB } from '../../db/schema';
import { proposalIdsIn } from './renderers/proposal-answer';
import { handleCallback } from './telegram/callback-handler';
import type { ConnectorPlatform } from './types';

const WINDOW_MS = 30 * 60_000;

const YES_RE =
  /^(?:yes|y|yep|yeah|yup|ok|okay|confirm|send|send it|do it|go ahead)(?:\s+please)?[\s.!👍]*$/iu;
const NO_RE = /^(?:no|n|nope|cancel|skip|don'?t)(?:\s+thanks)?[\s.!]*$/i;

export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = text.trim();
  if (YES_RE.test(t)) return 'yes';
  if (NO_RE.test(t)) return 'no';
  return null;
}

/**
 * Resolve the sender's recent proposals from a YES / NO. Returns the reply to
 * send back, or null when this message is not an answer to any card.
 */
export async function answerProposalsByReply(
  db: Kysely<DB>,
  m: {
    platform: ConnectorPlatform;
    externalUserId: string;
    /** The chat the YES / NO arrived in — only cards sent there count. */
    externalChannelId: string;
    groupId: string;
    userId: string;
    /** The YES / NO message itself, already stored. */
    messageId: string;
    text: string;
  },
  now: number = Date.now(),
): Promise<string | null> {
  const answer = parseYesNo(m.text);
  if (!answer) return null;

  const previous = await db
    .selectFrom('messages')
    .select('created_at')
    .where('group_id', '=', m.groupId)
    .where('sender_id', '=', m.userId)
    .where('source', '=', m.platform)
    .where('id', '!=', m.messageId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!previous) return null;
  // Every created_at here is our own toISOString(), but parse rather than
  // compare text — the rule for every time column.
  const since = Math.max(Date.parse(previous.created_at), now - WINDOW_MS);

  // Only cards actually SENT to this chat count. The proposer and the time
  // alone do not say that: background email passes stage cards with the user
  // as proposer (a cancellation email's "remove this event"), and those were
  // never shown here — a "yes" meant for something else must not confirm one.
  const shown = await proposalsShownOn(db, m.platform, m.externalChannelId, m.groupId);
  if (shown.size === 0) return null;

  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'bundle_id', 'created_at'])
    .where('group_id', '=', m.groupId)
    .where('status', '=', 'pending')
    .where('proposed_by_user_id', '=', m.userId)
    .orderBy('created_at', 'asc')
    .execute();
  // A bundle shown as one card may carry one member's callback; the rest of
  // that bundle was shown with it.
  const shownBundles = new Set(
    rows.filter((r) => shown.has(r.id) && r.bundle_id).map((r) => r.bundle_id!),
  );
  const recent = rows.filter(
    (r) =>
      Date.parse(r.created_at) >= since &&
      (shown.has(r.id) || (r.bundle_id !== null && shownBundles.has(r.bundle_id))),
  );
  if (recent.length === 0) return null;

  // One answer per bundle: resolving any member resolves the rest.
  const seen = new Set<string>();
  const targets = recent.filter((r) => {
    if (!r.bundle_id) return true;
    if (seen.has(r.bundle_id)) return false;
    seen.add(r.bundle_id);
    return true;
  });

  const verb = answer === 'yes' ? 'p+' : 'p-';
  const toasts: string[] = [];
  for (const t of targets) {
    const r = await handleCallback(db, {
      platform: m.platform,
      externalUserId: m.externalUserId,
      receivedByBotUserId: null,
      data: `${verb}:${t.id}`,
    });
    toasts.push(r.toast);
  }
  return summarize(toasts);
}

/**
 * Proposal ids whose cards were delivered to this external chat: the cards of
 * every Chord message a connector send recorded for this platform + channel
 * (`outbound_connector_messages`, ADR 0029).
 */
async function proposalsShownOn(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalChannelId: string,
  groupId: string,
): Promise<Set<string>> {
  const sent = await db
    .selectFrom('outbound_connector_messages as o')
    .innerJoin('messages as msg', 'msg.id', 'o.chord_message_id')
    .innerJoin('message_cards as c', 'c.message_id', 'o.chord_message_id')
    .select('c.cards_json')
    .where('o.platform', '=', platform)
    .where('o.external_channel_id', '=', externalChannelId)
    .where('msg.group_id', '=', groupId)
    .execute();
  const ids = new Set<string>();
  for (const row of sent) {
    let cards: unknown;
    try {
      cards = JSON.parse(row.cards_json);
    } catch {
      continue;
    }
    if (!Array.isArray(cards)) continue;
    for (const id of proposalIdsIn(cards as BotCard[])) ids.add(id);
  }
  return ids;
}

function summarize(toasts: string[]): string {
  if (toasts.length === 1) return toasts[0]!;
  const isDone = (t: string) => t.startsWith('✓') || t.startsWith('✗');
  const done = toasts.filter(isDone);
  const rest = [...new Set(toasts.filter((t) => !isDone(t)))];
  if (done.length === 0) return rest.join(' ');
  const head = done[0]!.startsWith('✗') ? `✗ Skipped ${done.length}` : `✓ Confirmed ${done.length}`;
  return rest.length === 0 ? `${head}.` : `${head}. ${rest.join(' ')}`;
}
