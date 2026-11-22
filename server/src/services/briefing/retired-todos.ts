/**
 * ADR 0285 — the to-dos Chord took off the list since the last briefing, by
 * name and with the reason, so a to-do never disappears without the user
 * being told. ADR 0092 only promised a count, and the short briefing's count
 * ("past-due retired") also took in to-dos retired because their email or
 * event went away, which were never past due.
 *
 * Told: what Chord did on its own — the overdue sweep (ADR 0092), a to-do
 * whose time ran out (`live_until`), one retired with its email (ADR 0143) or
 * its event (ADR 0192). Not told: a to-do the user dropped, or a finished one
 * being filed — they did that themselves.
 *
 * The full briefing lists them; the short one (WhatsApp, the teaser) has one
 * line and gives the count of the same set, so the two cannot disagree.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { env } from '../../config/env.js';
import { archivedReasonText, retiredByChord } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { instantMs, textInstant } from '../../db/text-instant.js';
import { firstOfEach, sameWordsKey } from './compose.js';

export interface RetiredTodo {
  title: string;
  reason: 'overdue' | 'expired' | 'email_gone' | 'email_spam' | 'event_gone';
}

/** How far back a briefing looks: since roughly the previous one. */
export const RETIRED_WINDOW_MS = 24 * 60 * 60_000;

/** Shown in the full briefing; past this the section ends "and N more". */
export const RETIRED_SHOWN = 8;

export async function retiredTodosSince(
  db: Kysely<DB>,
  userId: string,
  sinceIso: string,
): Promise<RetiredTodo[]> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
    .where('group_members.user_id', '=', userId)
    .where('tasks.status', '=', 'archived')
    .where('tasks.archived_at', 'is not', null)
    .where(sql<boolean>`${textInstant('tasks.archived_at')} > ${sinceIso}::timestamptz`)
    .select(['tasks.title', 'tasks.due_at', 'tasks.archived_at', 'tasks.archived_reason'])
    .orderBy(textInstant('tasks.archived_at'), 'asc')
    .execute();
  const overdueMs = env.TASK_OVERDUE_ARCHIVE_DAYS * 24 * 60 * 60_000;
  const out: RetiredTodo[] = [];
  for (const r of rows) {
    if (r.archived_reason) {
      if (retiredByChord(r.archived_reason)) out.push({ title: r.title, reason: r.archived_reason as RetiredTodo['reason'] });
      continue;
    }
    // Archived before the reason was recorded (migration 119): only the
    // overdue sweep's own rule can be recognised — due a week before it went.
    const due = instantMs(r.due_at);
    const at = instantMs(r.archived_at);
    if (Number.isFinite(due) && Number.isFinite(at) && due <= at - overdueMs) {
      out.push({ title: r.title, reason: 'overdue' });
    }
  }
  // A to-do copied into several groups goes from each; it is one to-do.
  return firstOfEach(out, (t) => sameWordsKey(t.title));
}

/** The full briefing's section, or null when nothing was retired. */
export function renderRetiredSection(items: RetiredTodo[]): string | null {
  if (items.length === 0) return null;
  const lines = items.slice(0, RETIRED_SHOWN).map((t) => `• ${t.title} — ${archivedReasonText(t.reason)}`);
  const more = items.length - RETIRED_SHOWN;
  if (more > 0) lines.push(`• …and ${more} more`);
  return [`🗂 Taken off your to-dos (in To Do's → Tasks → Archived, if you still need one):`, ...lines].join('\n');
}
