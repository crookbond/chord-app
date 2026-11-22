/**
 * ADR 0314 — an email to-do that IS a reply to its sender is done once the
 * user replies in that thread, from Chord or from any other mail app.
 *
 * Only reply to-dos: marked `closesOnReply` when the suggestion pass staged
 * them, or titled the way staging marks them (cards and to-dos made before the
 * mark existed). A reply does not return a permission slip or pay a bill, so
 * the thread's other to-dos stay open.
 */
import { sql, type Kysely } from 'kysely';

import { SSE } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { instantMs, textInstant } from '../../db/text-instant.js';
import { logger } from '../../config/logging.js';
import { sseHub } from '../sse.hub.js';
import { updateTask } from '../tasks.service.js';

/** A to-do written as a reply to the sender ("Reply to Sarah with times…").
 *  Staging marks these when the model leaves out its `reply` flag, and closing
 *  reads the same rule for rows that carry no mark. */
export const REPLY_TITLE = /^(reply|respond|write back)\b/i;

export interface ReplyThreadMessage {
  internalDate: string;
  labelIds: string[];
  /** An automatic message (the vacation responder, ADR 0124, or anything
   *  sent with `Auto-Submitted`): neither the user answering nor an ask. */
  autoReply?: boolean;
  /** Who it came from and went to. A sent message answers an ask only when it
   *  went back to the asker; a forward goes to someone new. Absent (older
   *  callers, rows with no addresses) = not known, read as a reply. */
  from?: string | null;
  replyTo?: string | null;
  to?: string[];
  cc?: string[];
}

function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle ? angle[1]! : raw).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

/** Did this sent message go back to whoever wrote `ask`? */
function wentBackTo(sent: ReplyThreadMessage, ask: ReplyThreadMessage): boolean {
  const recipients = [...(sent.to ?? []), ...(sent.cc ?? [])]
    .map(addressOf)
    .filter((a): a is string => !!a);
  const asker = [addressOf(ask.from), addressOf(ask.replyTo)].filter((a): a is string => !!a);
  if (recipients.length === 0 || asker.length === 0) return true;
  return recipients.some((r) => asker.includes(r));
}

function live(messages: ReplyThreadMessage[]): ReplyThreadMessage[] {
  return messages.filter(
    (m) => !m.autoReply && !m.labelIds.includes('TRASH') && !m.labelIds.includes('DRAFT'),
  );
}

/**
 * Did the user reply to what they were asked as of `asOfMs`? The ask is the
 * newest message from someone else on or before that moment; a reply is a
 * sent message after it. A reply to an earlier message that was then followed
 * by a new question does not answer the new one, and a forward to someone
 * else does not answer it at all.
 */
export function answeredSince(messages: ReplyThreadMessage[], asOfMs: number): boolean {
  const msgs = live(messages);
  let ask: ReplyThreadMessage | undefined;
  let askedMs = Number.NEGATIVE_INFINITY;
  for (const m of msgs) {
    if (m.labelIds.includes('SENT')) continue;
    const ms = instantMs(m.internalDate);
    if (Number.isFinite(ms) && ms <= asOfMs && ms > askedMs) {
      askedMs = ms;
      ask = m;
    }
  }
  if (!ask) return false;
  return msgs.some((m) => {
    if (!m.labelIds.includes('SENT')) return false;
    const ms = instantMs(m.internalDate);
    return Number.isFinite(ms) && ms > askedMs && wentBackTo(m, ask!);
  });
}

/** The newest live message is the user's own reply: the thread waits on them
 *  no longer. A forward to someone else leaves it waiting. */
export function newestIsSent(messages: ReplyThreadMessage[]): boolean {
  const msgs = live(messages);
  let newest: ReplyThreadMessage | undefined;
  for (const m of msgs) {
    if (!newest || instantMs(m.internalDate) >= instantMs(newest.internalDate)) newest = m;
  }
  if (!newest?.labelIds.includes('SENT')) return false;
  const newestMs = instantMs(newest.internalDate);
  let ask: ReplyThreadMessage | undefined;
  for (const m of msgs) {
    if (m.labelIds.includes('SENT')) continue;
    const ms = instantMs(m.internalDate);
    if (ms <= newestMs && (!ask || ms > instantMs(ask.internalDate))) ask = m;
  }
  return !ask || wentBackTo(newest, ask);
}

/** The same test in SQL, over `email_threads` in the enclosing query. */
export function newestIsSentSql() {
  const liveMsg = (alias: string) => sql.raw(`${alias}.user_id = email_threads.user_id
      and ${alias}.gmail_thread_id = email_threads.gmail_thread_id
      and not (${alias}.gmail_label_ids @> '["TRASH"]'::jsonb)
      and not (${alias}.gmail_label_ids @> '["DRAFT"]'::jsonb)
      and ${alias}.auto_reply = 0`);
  return sql<boolean>`coalesce((
    select case
      when not (m.gmail_label_ids @> '["SENT"]'::jsonb) then false
      when jsonb_array_length(coalesce(m.to_emails, '[]'::jsonb) || coalesce(m.cc_emails, '[]'::jsonb)) = 0 then true
      else coalesce((
        select (a.from_email is null and a.reply_to is null) or exists (
          select 1
          from jsonb_array_elements_text(coalesce(m.to_emails, '[]'::jsonb) || coalesce(m.cc_emails, '[]'::jsonb)) r(addr)
          where lower(trim(coalesce(substring(r.addr from '<([^>]+)>'), r.addr)))
                in (lower(trim(coalesce(a.from_email, ''))), lower(trim(coalesce(a.reply_to, ''))))
        )
        from email_messages a
        where ${liveMsg('a')}
          and not (a.gmail_label_ids @> '["SENT"]'::jsonb)
          and ${textInstant('a.internal_date')} <= ${textInstant('m.internal_date')}
        order by ${textInstant('a.internal_date')} desc nulls last
        limit 1
      ), true)
    end
    from email_messages m
    where ${liveMsg('m')}
    order by ${textInstant('m.internal_date')} desc nulls last
    limit 1
  ), false)`;
}

export async function loadReplyThreadMessages(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
): Promise<ReplyThreadMessage[]> {
  const rows = await db
    .selectFrom('email_messages')
    .select(['internal_date', 'gmail_label_ids', 'auto_reply', 'from_email', 'reply_to', 'to_emails', 'cc_emails'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .execute();
  return rows.map(toReplyThreadMessage);
}

export function toReplyThreadMessage(r: {
  internal_date: string;
  gmail_label_ids: unknown;
  auto_reply: number;
  from_email: string | null;
  reply_to?: string | null;
  to_emails: unknown;
  cc_emails: unknown;
}): ReplyThreadMessage {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    internalDate: r.internal_date,
    labelIds: list(r.gmail_label_ids),
    autoReply: r.auto_reply === 1,
    from: r.from_email,
    replyTo: r.reply_to ?? null,
    to: list(r.to_emails),
    cc: list(r.cc_emails),
  };
}

/** Staging: the user has already answered this thread's latest ask. */
export async function threadAlreadyAnswered(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
): Promise<boolean> {
  return answeredSince(await loadReplyThreadMessages(db, userId, gmailThreadId), Date.now());
}

function closesOnReplyArgs(argsJson: string): boolean {
  try {
    const args = JSON.parse(argsJson) as { closesOnReply?: unknown; title?: unknown };
    return args.closesOnReply === true || (typeof args.title === 'string' && REPLY_TITLE.test(args.title));
  } catch {
    return false;
  }
}

/**
 * Withdraw the thread's pending reply cards and mark its open reply to-dos
 * done. Called from `recomputeThread`, which every provider's sync and every
 * Chord send passes through.
 */
export async function closeAnsweredReplyTodos(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
  messages: ReplyThreadMessage[],
): Promise<{ proposals: number; tasks: number }> {
  const none = { proposals: 0, tasks: 0 };
  // Cheap gate, since this runs on every recompute: a reply needs a sent
  // message later than at least one message from someone else.
  if (!anyAnswer(messages)) return none;
  const key = `gmail:${gmailThreadId}`;

  const pending = await db
    .selectFrom('proposals')
    .select(['id', 'group_id', 'args_json', 'created_at'])
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('tool_name', '=', 'create_task')
    .where('provenance', '=', key)
    .execute();
  const withdraw = pending.filter(
    (p) => closesOnReplyArgs(p.args_json) && answeredSince(messages, instantMs(p.created_at)),
  );
  if (withdraw.length > 0) {
    await db
      .updateTable('proposals')
      .set({ status: 'expired', resolved_at: new Date().toISOString() })
      .where('id', 'in', withdraw.map((p) => p.id))
      .where('status', '=', 'pending')
      .execute();
    for (const p of withdraw) {
      sseHub.broadcast(p.group_id, SSE.proposalResolved, { id: p.id, status: 'expired' });
    }
    sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });
  }

  const open = await db
    .selectFrom('tasks')
    .select(['id', 'title', 'created_at', 'closes_on_reply'])
    .where('created_by', '=', userId)
    .where('source_raw_context', '=', key)
    .where('status', 'in', ['open', 'active'])
    .execute();
  let tasks = 0;
  for (const t of open) {
    if (t.closes_on_reply !== 1 && !REPLY_TITLE.test(t.title)) continue;
    if (!answeredSince(messages, instantMs(t.created_at))) continue;
    // Done, not archived (ADR 0092): the user did exactly what it asked.
    const task = await updateTask(db, t.id, { status: 'done' });
    if (!task) continue;
    tasks += 1;
    sseHub.broadcast(task.groupId, SSE.taskUpdated, task);
  }

  if (withdraw.length > 0 || tasks > 0) {
    logger.info('email reply closed to-do', {
      userId,
      gmailThreadId,
      proposals: withdraw.length,
      tasks,
    });
  }
  return { proposals: withdraw.length, tasks };
}

/** Some sent message comes after some message from someone else. */
function anyAnswer(messages: ReplyThreadMessage[]): boolean {
  const msgs = live(messages);
  let firstIncoming = Number.POSITIVE_INFINITY;
  let lastSent = Number.NEGATIVE_INFINITY;
  for (const m of msgs) {
    const ms = instantMs(m.internalDate);
    if (!Number.isFinite(ms)) continue;
    if (m.labelIds.includes('SENT')) lastSent = Math.max(lastSent, ms);
    else firstIncoming = Math.min(firstIncoming, ms);
  }
  return lastSent > firstIncoming;
}
