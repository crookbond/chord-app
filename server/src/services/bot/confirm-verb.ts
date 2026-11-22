/**
 * @Chord confirm / drop / approve / reject natural-language verbs (ADR 0009,
 * phase 5). These are a cheap fast-path: when the user's message matches the
 * pattern, we dispatch straight to `proposals.service` and post a short bot
 * reply — no LLM call, no token streaming.
 *
 * Grammar (case-insensitive, `@Chord` prefix required):
 *   @Chord confirm                 — most-recent pending proposal in this group
 *   @Chord confirm all             — every pending proposal in this group
 *   @Chord confirm <prefix>        — proposal id starts with <prefix> (with or without 'p_')
 *   @Chord approve [ref]           — alias for confirm
 *   @Chord drop [ref]              — reject (same matchers)
 *   @Chord reject [ref]            — alias for drop
 *
 * Falls through to the normal LLM turn when nothing matches.
 */
import type { Kysely } from 'kysely';

import { SSE, buildConfirmRegex, type Message } from '@chord/kernel';

import type { DB, MessagesTable } from '../../db/schema.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { rowToMessage } from '../messages.service.js';
import {
  confirmProposal,
  listProposalsForGroup,
  rejectProposal,
} from '../proposals.service.js';
import { sseHub } from '../sse.hub.js';
import { newId } from '../../utils/ids.js';

export type ConfirmVerb = 'confirm' | 'reject';

export interface ConfirmCommand {
  verb: ConfirmVerb;
  /**
   * `null`           — target the most-recent pending proposal
   * `'all'`          — target every pending proposal
   * any other string — case-insensitive id prefix (with or without 'p_' prefix)
   */
  ref: string | null | 'all';
}

export function parseConfirmCommand(body: string): ConfirmCommand | null {
  const m = buildConfirmRegex(getDefaultPersona().mentionAliases).exec(body);
  if (!m) return null;
  const verb: ConfirmVerb =
    m[1]!.toLowerCase() === 'drop' || m[1]!.toLowerCase() === 'reject'
      ? 'reject'
      : 'confirm';
  const rawRef = m[2]?.trim().toLowerCase() ?? null;
  if (!rawRef) return { verb, ref: null };
  if (rawRef === 'all') return { verb, ref: 'all' };
  return { verb, ref: rawRef };
}

function matchesPrefix(id: string, prefix: string): boolean {
  const a = id.toLowerCase();
  const b = prefix.toLowerCase();
  return a.startsWith(b) || a.startsWith(`p_${b}`) || a.replace(/^p_/, '').startsWith(b);
}

async function postBotReply(
  db: Kysely<DB>,
  groupId: string,
  body: string,
  replyToId: string,
): Promise<void> {
  const id = newId('m');
  const row: MessagesTable = {
    id,
    group_id: groupId,
    sender_id: null,
    kind: 'bot',
    body,
    attachment_id: null,
    reply_to_id: replyToId,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 0,
  };
  await db.insertInto('messages').values(row).execute();
  sseHub.broadcast(groupId, SSE.botDone, { messageId: id });
  sseHub.broadcast(groupId, SSE.message, rowToMessage(row));
}

/**
 * Returns `true` if the message was a confirm/reject verb and has been
 * handled (bot reply posted, proposal(s) resolved). Returns `false` if the
 * message isn't a verb at all — caller should proceed with the normal LLM
 * turn.
 */
export async function maybeHandleConfirmCommand(
  db: Kysely<DB>,
  triggerMsg: Message,
  group: { id: string; kind: 'group' | 'personal' },
): Promise<boolean> {
  const cmd = parseConfirmCommand(triggerMsg.body);
  if (!cmd) return false;
  if (!triggerMsg.senderId) return false;

  const pending = await listProposalsForGroup(db, group.id, { status: 'pending' });

  let targets = pending;
  if (cmd.ref === null) {
    // Most recent (listProposalsForGroup already orders by created_at desc)
    targets = pending.slice(0, 1);
  } else if (cmd.ref !== 'all') {
    targets = pending.filter((p) => matchesPrefix(p.id, cmd.ref as string));
  }

  if (targets.length === 0) {
    const reply =
      cmd.ref && cmd.ref !== 'all'
        ? `I couldn't find a pending proposal matching "${cmd.ref}".`
        : 'Nothing pending to act on.';
    await postBotReply(db, group.id, reply, triggerMsg.id);
    return true;
  }

  // Guard against ambiguous prefix hitting multiple proposals.
  if (
    cmd.ref &&
    cmd.ref !== 'all' &&
    targets.length > 1
  ) {
    const hints = targets
      .slice(0, 5)
      .map((p) => p.id.replace(/^p_/, '').slice(0, 6))
      .join(', ');
    await postBotReply(
      db,
      group.id,
      `Multiple pending proposals match "${cmd.ref}": ${hints}. Be more specific, or say "all".`,
      triggerMsg.id,
    );
    return true;
  }

  // Dispatch. Bundle-aware logic in proposals.service handles the cascade
  // automatically when any bundled proposal id is passed.
  let okCount = 0;
  let failCount = 0;
  const seenBundles = new Set<string>();
  for (const t of targets) {
    // If we've already acted on a proposal in this bundle, skip — the
    // service already flipped its siblings.
    if (t.bundleId && seenBundles.has(t.bundleId)) continue;
    if (t.bundleId) seenBundles.add(t.bundleId);

    if (cmd.verb === 'confirm') {
      const r = await confirmProposal(db, {
        id: t.id,
        resolvedByUserId: triggerMsg.senderId,
        resolvedByMessageId: triggerMsg.id,
      });
      if (r.ok) {
        okCount += r.affected.length;
        for (const id of r.affected) {
          sseHub.broadcast(group.id, SSE.proposalResolved, { id, status: 'confirmed' });
        }
      } else {
        failCount++;
      }
    } else {
      const r = await rejectProposal(db, {
        id: t.id,
        resolvedByUserId: triggerMsg.senderId,
        resolvedByMessageId: triggerMsg.id,
      });
      if (r) {
        okCount += r.affected.length;
        for (const id of r.affected) {
          sseHub.broadcast(group.id, SSE.proposalResolved, { id, status: 'rejected' });
        }
      } else {
        failCount++;
      }
    }
  }

  const verbPast = cmd.verb === 'confirm' ? 'confirmed' : 'dropped';
  const parts: string[] = [];
  if (okCount > 0) parts.push(`${verbPast} ${okCount}`);
  if (failCount > 0) parts.push(`${failCount} failed`);
  await postBotReply(
    db,
    group.id,
    parts.length > 0 ? `OK — ${parts.join(', ')}.` : 'Nothing happened.',
    triggerMsg.id,
  );
  return true;
}
