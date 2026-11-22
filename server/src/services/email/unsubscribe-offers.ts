/**
 * Offering to unsubscribe from a list the user never reads.
 *
 * A mailing list the user has had at least IGNORED_SENDER_MIN emails from,
 * opened none of and never written to (the same test the bulk gate uses) gets
 * one Unsubscribe card in Action Items, beside its newest email. Nothing is
 * sent until the user taps it (the card is the ordinary unsubscribe_from_sender
 * proposal, so its outcome is reported the ADR 0122 way).
 *
 * Asked ONCE per sender, ever: a card that expired or was dismissed is the
 * user's answer. At most one new card a day, so a mailbox with forty ignored
 * lists does not become forty cards on the first sync. Only senders that offer
 * one-click or mailto: a link-only list needs the user on a web page, which is
 * not a one-tap answer.
 *
 * No AI call, so it runs with the mailbox passes above the AI-consent and
 * billing gates.
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SSE } from '@chord/kernel';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { createProposal } from '../proposals.service.js';
import { sseHub } from '../sse.hub.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { senderIgnoredSql } from './bulk-gate.js';
import { isDangerousSender } from './sender-check/prompt.js';
import { listSubscriptions } from './unsubscribe.service.js';

/** Senders already offered (lowercased address → ISO date of the offer). */
const offered = defineUserDefault('unsubscribe_offered', z.record(z.string(), z.string()));
/** When the lists were last looked through (ISO). One look a day, card or not. */
const checkedAt = defineUserDefault('unsubscribe_offer_checked', z.string());

const DAY_MS = 86_400_000;
/** How long an offer card waits before it expires unanswered. */
const OFFER_TTL_MS = 14 * DAY_MS;

export async function offerUnsubscribes(db: Kysely<DB>, userId: string): Promise<number> {
  const asked = (await offered.get(db, userId)) ?? {};
  const latest = Object.values(asked).sort().at(-1);
  if (latest && Date.now() - Date.parse(latest) < DAY_MS) return 0;
  // Claimed under a row lock before the scan: a look that found nothing waits
  // a day too (the scan ran on nearly every sync), and two syncs at once
  // cannot both pass and stage two cards.
  const nowIso = new Date().toISOString();
  const claimed = await checkedAt.update(db, userId, (last) =>
    last && Date.now() - Date.parse(last) < DAY_MS
      ? { value: undefined, result: false }
      : { value: nowIso, result: true },
  );
  if (!claimed) return 0;

  const lists = await listSubscriptions(db, userId, { sinceDays: 90, limit: 60, left: 'drop' });
  for (const list of lists) {
    if (list.messages < 3 || list.requestedAt) continue;
    if (list.kind !== 'one_click' && list.kind !== 'mailto') continue;
    if (asked[list.senderEmail]) continue;

    const ignored = await db
      .selectNoFrom(senderIgnoredSql(userId, sql.val(list.senderEmail)).as('ignored'))
      .executeTakeFirst();
    if (!ignored?.ignored) continue;
    // ADR 0294 — nothing is suggested from a sender who is very likely not
    // who they say. Here that matters twice: the card would put a phisher's
    // name on a Chord suggestion, and a one-click unsubscribe POSTs to their
    // URL, which tells them the address is read. Skipped, not marked
    // offered: the mail stays out of every suggestion.
    if (await isDangerousSender(db, userId, list.threadId)) continue;

    const thread = await db
      .selectFrom('email_threads')
      .select('gmail_thread_id')
      .where('id', '=', list.threadId)
      .executeTakeFirst();
    if (!thread) continue;

    const personal = await ensurePersonalGroup(db, userId);
    const who = list.senderName ?? list.senderEmail;
    const proposal = await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'unsubscribe_from_sender',
      args: {
        sender: who,
        senderEmail: list.senderEmail,
        ...(list.senderName ? { senderName: list.senderName } : {}),
        why: `${list.messages} emails in the last 90 days, none opened`,
      },
      // Beside its newest email in the reader and in Action Items.
      provenance: `gmail:${thread.gmail_thread_id}`,
      ttlMs: OFFER_TTL_MS,
    });
    sseHub.broadcast(personal.id, SSE.proposalCreated, proposal);
    await offered.update(db, userId, (cur) => ({
      value: { ...(cur ?? {}), [list.senderEmail]: new Date().toISOString() },
      result: undefined,
    }));
    logger.info('unsubscribe offered', { userId, sender: list.senderEmail, messages: list.messages });
    return 1;
  }
  return 0;
}
