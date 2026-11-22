/**
 * "Send their future mail to Trash": the way out when a list cannot be left
 * from Chord - its unsubscribe failed, or it only offers a web page the user
 * did not finish.
 *
 * A rule is a sender address and the moment it was set. Only mail that arrives
 * AFTER that moment is moved (what the user asked for is "from now on"; mail
 * already there stays where they left it). Moving is the ordinary Trash write
 * (ADR 0215): Trash, never permanent delete, so a wrong rule costs a trip to
 * the Trash folder. No AI call, so it runs with the mailbox passes after each
 * sync, above the AI-consent and billing gates.
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { textInstant } from '@/db/text-instant.js';
import { defineUserDefault } from '../user-defaults.service.js';

export interface AutoTrashRule {
  sender: string;
  /** ISO time the rule was set; earlier mail is left alone. */
  since: string;
}

const MAX_RULES = 200;
/** Threads moved per pass: a sender that sent a burst is finished over a few syncs. */
const PER_PASS = 25;

const autoTrash = defineUserDefault(
  'email_auto_trash',
  z.array(z.object({ sender: z.string().min(3).max(320), since: z.string().min(10).max(40) })).max(MAX_RULES),
);

const normalize = (s: string): string => s.trim().toLowerCase();

export async function listAutoTrash(db: Kysely<DB>, userId: string): Promise<AutoTrashRule[]> {
  return (await autoTrash.get(db, userId)) ?? [];
}

/**
 * Turn the rule on or off for these senders. Turning on keeps an existing
 * rule's `since` (asking twice must not move the line forward and miss mail).
 * Returns the whole list after the change, and the senders that did not fit:
 * at the cap a new sender is refused, never made room for by silently
 * dropping the oldest rule (whose mail would start arriving again).
 */
export async function setAutoTrash(
  db: Kysely<DB>,
  userId: string,
  senders: string[],
  on: boolean,
): Promise<{ rules: AutoTrashRule[]; refused: string[] }> {
  const wanted = [...new Set(senders.map(normalize).filter((s) => s.includes('@')))];
  // Under a row lock: two senders turned on at once both land.
  return autoTrash.update(db, userId, (stored) => {
    const current = stored ?? [];
    let next: AutoTrashRule[];
    let refused: string[] = [];
    if (on) {
      const have = new Set(current.map((r) => r.sender));
      const now = new Date().toISOString();
      const fresh = wanted.filter((s) => !have.has(s));
      const room = Math.max(0, MAX_RULES - current.length);
      refused = fresh.slice(room);
      next = [...current, ...fresh.slice(0, room).map((sender) => ({ sender, since: now }))];
    } else {
      const drop = new Set(wanted);
      next = current.filter((r) => !drop.has(r.sender));
    }
    return { value: next.length ? next : null, result: { rules: next, refused } };
  });
}

/** Move mail that arrived after a rule was set to Trash. Returns how many threads moved. */
export async function applyAutoTrash(db: Kysely<DB>, userId: string): Promise<number> {
  const rules = await listAutoTrash(db, userId);
  if (rules.length === 0) return 0;
  const since = new Map(rules.map((r) => [r.sender, Date.parse(r.since)]));

  const rows = await db
    .selectFrom('email_threads as t')
    .select([
      sql<string>`lower(t.from_email)`.as('sender'),
      't.id',
      sql<string>`(extract(epoch from ${textInstant('t.last_message_at')}) * 1000)::bigint`.as('atMs'),
    ])
    .where('t.user_id', '=', userId)
    .where(sql<boolean>`lower(t.from_email) in (${sql.join(rules.map((r) => r.sender))})`)
    // Inbox mail only. An archived thread (IMAP cannot trash one: its stored
    // UIDs are INBOX UIDs) was re-selected every pass and, refused each time,
    // filled the per-pass budget so newer mail was never reached.
    .where('t.is_archived', '=', 0)
    .where(sql<boolean>`not (t.gmail_label_ids @> '["TRASH"]'::jsonb)`)
    .where(sql<boolean>`not (t.gmail_label_ids @> '["SPAM"]'::jsonb)`)
    .where(sql<boolean>`${textInstant('t.last_message_at')} >= ${new Date(Math.min(...since.values())).toISOString()}::timestamptz`)
    .orderBy(sql`${textInstant('t.last_message_at')}`, 'desc')
    .limit(PER_PASS * 4)
    .execute();

  const due = rows.filter((r) => Number(r.atMs) >= (since.get(r.sender) ?? Infinity)).slice(0, PER_PASS);
  if (due.length === 0) return 0;

  // Imported here: the trash write lives with the bot's email actions, which
  // import the Gmail service that calls this pass.
  const { trashEmailThread } = await import('../bot/email-actions.js');
  let moved = 0;
  for (const r of due) {
    try {
      const out = await trashEmailThread(db, userId, r.id);
      if (out.ok) moved += 1;
      else logger.warn('auto-trash skipped a thread', { userId, sender: r.sender, reason: out.reason });
    } catch (err) {
      logger.warn('auto-trash failed', { userId, sender: r.sender, err: (err as Error).message });
    }
  }
  if (moved) logger.info('auto-trash moved mail', { userId, moved });
  return moved;
}
