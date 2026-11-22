/**
 * On-demand email summary over a time window ("summarize my emails from
 * yesterday by sections"). Distinct from digest.service, which builds the fixed
 * attention-first section appended to the morning briefing (ADR 0072): this one
 * takes an arbitrary window and sections by the ADR 0086 action axis, so the
 * answer leads with what actually wants something from the user.
 *
 * Deterministic - no LLM. The bot narrates the structure it gets back, so a
 * summary can never invent mail that isn't there.
 */
import type { Kysely } from 'kysely';

import { EMAIL_ACTIONS, type EmailAction } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { zonedDayStartUtc } from '../../utils/tz.js';

export interface EmailSummaryItem {
  id: string;
  subject: string;
  from: string | null;
  receivedAt: string;
  category: string | null;
  unread: boolean;
}

export interface EmailSummarySection {
  /** `unclassified` covers mail the classifier hasn't reached yet - a real
   *  state, distinct from an explicit 'other'. */
  key: EmailAction | 'unclassified';
  label: string;
  count: number;
  items: EmailSummaryItem[];
}

export interface EmailWindowSummary {
  /** Inclusive YYYY-MM-DD bounds, in the user's zone. */
  since: string;
  until: string;
  timezone: string | null;
  total: number;
  unread: number;
  sections: EmailSummarySection[];
  /** Volume per top-level category, largest first. */
  byCategory: { title: string; count: number }[];
}

const SECTION_LABEL: Record<EmailAction | 'unclassified', string> = {
  to_do: 'Needs doing',
  reply_needed: 'Needs a reply',
  informational: 'FYI',
  other: 'Other',
  unclassified: 'Not sorted yet',
};

/** Order the sections by how much they want from the user, not alphabetically. */
const SECTION_ORDER: (EmailAction | 'unclassified')[] = [
  'to_do',
  'reply_needed',
  'other',
  'unclassified',
  'informational',
];

/** Re-exported: the helper moved to `utils/tz` once a second caller needed it. */
export { zonedDayStartUtc };

/** Today's YYYY-MM-DD in `tz` - "yesterday" has to mean the user's yesterday. */
export function todayInTz(tz: string | null, now = new Date()): string {
  if (!tz) return now.toISOString().slice(0, 10);
  try {
    return now.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export interface SummarizeEmailInput {
  /** Inclusive YYYY-MM-DD in the user's zone. Defaults to `until`. */
  since?: string;
  /** Inclusive YYYY-MM-DD in the user's zone. Defaults to yesterday. */
  until?: string;
  /** Max threads listed per section (counts are always complete). */
  perSection?: number;
}

const DEFAULT_PER_SECTION = 5;
const MAX_PER_SECTION = 20;

export async function summarizeEmailWindow(
  db: Kysely<DB>,
  userId: string,
  input: SummarizeEmailInput = {},
): Promise<EmailWindowSummary> {
  const user = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  const tz = user?.last_tz ?? null;

  // Default window is the user's yesterday - the literal ask, and the useful
  // default for "what did I miss".
  const until = input.until ?? addDays(todayInTz(tz), -1);
  const since = input.since ?? until;
  const perSection = Math.min(Math.max(input.perSection ?? DEFAULT_PER_SECTION, 1), MAX_PER_SECTION);

  const startUtc = zonedDayStartUtc(since, tz).toISOString();
  // Exclusive upper bound at the start of the day AFTER `until`, so the window
  // is inclusive of `until` without depending on end-of-day precision.
  const endUtc = zonedDayStartUtc(addDays(until, 1), tz).toISOString();

  const rows = await db
    .selectFrom('email_threads as e')
    .leftJoin('email_categories as c', 'c.id', 'e.category_id')
    .select([
      'e.id as id',
      'e.subject as subject',
      'e.from_name as fromName',
      'e.from_email as fromEmail',
      'e.last_message_at as receivedAt',
      'e.action as action',
      'e.is_unread as isUnread',
      'c.title as categoryTitle',
    ])
    .where('e.user_id', '=', userId)
    .where('e.is_archived', '=', 0)
    .where('e.last_message_at', '>=', startUtc)
    .where('e.last_message_at', '<', endUtc)
    .orderBy('e.last_message_at', 'desc')
    .execute();

  const buckets = new Map<EmailAction | 'unclassified', EmailSummaryItem[]>();
  const categoryCounts = new Map<string, number>();
  let unread = 0;

  for (const r of rows) {
    const key: EmailAction | 'unclassified' =
      r.action && (EMAIL_ACTIONS as readonly string[]).includes(r.action)
        ? (r.action as EmailAction)
        : 'unclassified';
    const list = buckets.get(key) ?? [];
    list.push({
      id: r.id,
      subject: r.subject || '(no subject)',
      from: r.fromName ?? r.fromEmail,
      receivedAt: r.receivedAt,
      category: r.categoryTitle ?? null,
      unread: Number(r.isUnread) === 1,
    });
    buckets.set(key, list);
    if (Number(r.isUnread) === 1) unread += 1;
    const cat = r.categoryTitle ?? null;
    if (cat) categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  }

  const sections: EmailSummarySection[] = [];
  for (const key of SECTION_ORDER) {
    const items = buckets.get(key);
    if (!items?.length) continue;
    sections.push({
      key,
      label: SECTION_LABEL[key],
      count: items.length,
      items: items.slice(0, perSection),
    });
  }

  const byCategory = [...categoryCounts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

  return {
    since,
    until,
    timezone: tz,
    total: rows.length,
    unread,
    sections,
    byCategory,
  };
}
