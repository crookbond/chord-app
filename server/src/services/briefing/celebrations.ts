/**
 * ADR 0272 — birthdays and anniversaries lead the briefing.
 *
 * They used to reach it only through IMPORTANT_DAYS (saved People rows) and
 * whatever the model chose to say about them, so a birthday that lived only on
 * the calendar ("Ben's birthday" from Google's Birthdays calendar), in a
 * to-do ("buy Ella's birthday gift") or in an email ("Ella's 7th birthday
 * party!") could be buried under This week or dropped. This collects all four
 * sources and renders one deterministic section that is placed at the very top
 * of the morning message, so it cannot be left out by the model.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { dayOf, daysBetween } from '../../utils/tz.js';
import type { GroupEvent } from '@chord/kernel';
import { listEventsForUser } from '../events.service.js';
import { listImportantDayOccurrences } from '../people.service.js';

export type CelebrationKind = 'birthday' | 'anniversary';
export type CelebrationSource = 'people' | 'calendar' | 'reminder' | 'email';

export interface Celebration {
  kind: CelebrationKind;
  /** YYYY-MM-DD in the user's zone, or null when the source carries no date
   *  (an undated to-do, an email). */
  on: string | null;
  /** What to print, e.g. "Ben's birthday". */
  label: string;
  /** Lowercased first word of whose day it is, for de-duplication. */
  who: string | null;
  source: CelebrationSource;
  /** Extra notes attached when other sources mention the same day. */
  notes: string[];
}

/** How far ahead a dated birthday or anniversary is worth leading with. */
export const CELEBRATION_DAYS = 14;
/** How far back an email about one is still worth surfacing. */
const EMAIL_LOOKBACK_DAYS = 14;
const MAX_EMAILS = 3;
const MAX_LINES = 8;

const BIRTHDAY = /\b(?:birthdays?|b-?days?|b'days?|bdays?)\b/i;
const ANNIVERSARY = /\b(?:anniversar(?:y|ies)|anniv)\b/i;

export function celebrationKind(text: string | null | undefined): CelebrationKind | null {
  if (!text) return null;
  if (ANNIVERSARY.test(text)) return 'anniversary';
  if (BIRTHDAY.test(text)) return 'birthday';
  return null;
}

const FILLER = new Set([
  'happy', 'birthday', 'birthdays', 'bday', 'bdays', 'b-day', "b'day", 'anniversary',
  'anniv', 'wedding', 'party', 'celebration', 'dinner', 'lunch', 'the', 'a', 'an', 'for',
  'of', 'to', 'buy', 'get', 'gift', 'gifts', 'card', 'present', 'plan', 'order', 'cake',
  'invite', 'invitation', 'rsvp', 're', 'fwd', 'fw', 'and', 'our', 'your', 'my', 'is',
  'on', 'at', 'from', 'with', 'reminder', 'call', 'wish', 'send', 'book',
]);

/** Best guess at whose day a title is about: "Ben's birthday" → "ben".
 *  Only used to tell two mentions of the same day apart, never printed. */
export function celebrationWho(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9'-]+/)
    .filter((w) => w && !FILLER.has(w) && !/^\d+(?:st|nd|rd|th)?$/.test(w));
  return words[0] ?? null;
}

function sameDay(a: Celebration, b: Celebration): boolean {
  if (a.kind !== b.kind) return false;
  if (a.who && b.who && a.who !== b.who) return false;
  if (a.on && b.on) return a.on === b.on && (a.who === b.who || !a.who || !b.who);
  // One side undated (a to-do, an email): only attach when the person matches.
  return !!a.who && a.who === b.who;
}

/**
 * Merge mentions of the same birthday/anniversary into one line. People rows
 * and calendar events are the day itself; to-dos and emails attach to a
 * matching day as a note, and only stand alone when nothing matches.
 */
export function mergeCelebrations(items: Celebration[]): Celebration[] {
  const days: Celebration[] = [];
  for (const it of items.filter((i) => i.source === 'people' || i.source === 'calendar')) {
    const hit = days.find((d) => sameDay(d, it));
    if (!hit) days.push({ ...it, notes: [...it.notes] });
  }
  for (const it of items.filter((i) => i.source === 'reminder' || i.source === 'email')) {
    const hit = days.find((d) => sameDay(d, it));
    const note = it.source === 'reminder' ? `to-do: ${it.label}` : `email: ${it.label}`;
    if (hit) {
      if (!hit.notes.includes(note)) hit.notes.push(note);
    } else {
      days.push({ ...it, notes: [...it.notes] });
    }
  }
  const order = (c: Celebration) => (c.on ? Date.parse(`${c.on}T00:00:00Z`) : Number.MAX_SAFE_INTEGER);
  return days.sort((a, b) => order(a) - order(b));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function whenLabel(on: string | null, todayStr: string): string | null {
  if (!on) return null;
  const out = daysBetween(on, todayStr);
  if (out === 0) return 'Today';
  if (out === 1) return 'Tomorrow';
  const d = new Date(`${on}T00:00:00Z`);
  const base = `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return out > 7 ? `${base} (in ${out} days)` : base;
}

/** The section printed at the top of the morning message, or null. */
export function renderCelebrationsSection(items: Celebration[], todayStr: string): string | null {
  if (items.length === 0) return null;
  const lines = items.slice(0, MAX_LINES).map((c) => {
    const when = whenLabel(c.on, todayStr);
    const head =
      c.source === 'email'
        ? `In your email — ${c.label}`
        : c.source === 'reminder' && !when
          ? `To-do — ${c.label}`
          : `${when ?? ''} — ${c.label}`;
    return `• ${head}${c.notes.length ? ` (${c.notes.join('; ')})` : ''}`;
  });
  return ['🎂 Birthdays & anniversaries:', ...lines].join('\n');
}

/** The same list as one line, for the WhatsApp template's heads-up slot. */
export function celebrationsOneLine(items: Celebration[], todayStr: string, max = 2): string | null {
  const dated = items.filter((c) => c.on);
  if (dated.length === 0) return null;
  return dated
    .slice(0, max)
    .map((c) => {
      const out = daysBetween(c.on!, todayStr);
      const when = out === 0 ? 'today' : out === 1 ? 'tomorrow' : `in ${out}d`;
      return `${c.label} ${when}`;
    })
    .join(' · ');
}

function peopleLabel(kind: string, name: string): string {
  if (kind === 'birthday') return `${name}'s birthday`;
  if (kind === 'anniversary') return `${name} — anniversary`;
  return `${name} — ${kind}`;
}

function quoted(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return `"${t.length > 80 ? `${t.slice(0, 77)}…` : t}"`;
}

/**
 * Every upcoming birthday/anniversary the user can see, from saved People,
 * calendar events, open to-dos and recent email. `events` may be passed when
 * the caller already read them.
 */
export async function collectCelebrations(
  db: Kysely<DB>,
  userId: string,
  tz: string | null,
  opts: { now?: Date; events?: GroupEvent[] } = {},
): Promise<Celebration[]> {
  const now = opts.now ?? new Date();
  const todayStr = dayOf(now.toISOString(), tz);
  const inWindow = (on: string) => {
    const out = daysBetween(on, todayStr);
    return out >= 0 && out <= CELEBRATION_DAYS;
  };
  const emailSince = new Date(now.getTime() - EMAIL_LOOKBACK_DAYS * 86_400_000).toISOString();

  const [important, events, tasks, threads] = await Promise.all([
    listImportantDayOccurrences(db, userId, CELEBRATION_DAYS + 1).catch(() => []),
    opts.events
      ? Promise.resolve(opts.events)
      : listEventsForUser(db, userId, { tz }).catch(() => [] as GroupEvent[]),
    db
      .selectFrom('tasks')
      .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
      .where('group_members.user_id', '=', userId)
      .where('tasks.status', 'in', ['open', 'active'])
      .select(['tasks.title', 'tasks.due_at'])
      .orderBy(sql`${textInstant('tasks.due_at', tz)} asc nulls last`)
      .limit(200)
      .execute()
      .catch(() => [] as Array<{ title: string; due_at: string | null }>),
    // Subjects are sealed at rest (ADR 0201), so match them here, not in SQL.
    db
      .selectFrom('email_threads')
      .where('user_id', '=', userId)
      .where('is_archived', '=', 0)
      .where('bulk', '=', 0)
      .where('bulk_inferred', '=', 0)
      .where('last_message_at', '>=', emailSince)
      .select(['subject', 'from_name', 'from_email', 'gmail_label_ids'])
      .orderBy('last_message_at', 'desc')
      .limit(300)
      .execute()
      .catch(() => [] as Array<{ subject: string; from_name: string | null; from_email: string | null; gmail_label_ids: string[] }>),
  ]);

  const out: Celebration[] = [];
  for (const d of important) {
    if (d.kind !== 'birthday' && d.kind !== 'anniversary') continue;
    if (!inWindow(d.on)) continue;
    out.push({
      kind: d.kind,
      on: d.on,
      label: peopleLabel(d.kind, d.personName),
      who: celebrationWho(d.personName),
      source: 'people',
      notes: [],
    });
  }
  for (const e of events) {
    const kind = celebrationKind(e.title);
    if (!kind || !e.startsAt) continue;
    const on = dayOf(e.startsAt, tz);
    if (!inWindow(on)) continue;
    out.push({ kind, on, label: e.title.trim(), who: celebrationWho(e.title), source: 'calendar', notes: [] });
  }
  for (const t of tasks) {
    const kind = celebrationKind(t.title);
    if (!kind) continue;
    const on = t.due_at ? dayOf(t.due_at, tz) : null;
    // A dated to-do is shown only near its date; an undated one always is.
    if (on && daysBetween(on, todayStr) > CELEBRATION_DAYS) continue;
    out.push({ kind, on, label: t.title.trim(), who: celebrationWho(t.title), source: 'reminder', notes: [] });
  }
  let emails = 0;
  for (const th of threads) {
    if (emails >= MAX_EMAILS) break;
    const labels = Array.isArray(th.gmail_label_ids) ? th.gmail_label_ids : [];
    if (labels.includes('TRASH') || labels.includes('SPAM')) continue;
    const kind = celebrationKind(th.subject);
    if (!kind) continue;
    const from = th.from_name?.trim() || th.from_email?.trim();
    out.push({
      kind,
      on: null,
      label: `${quoted(th.subject)}${from ? ` from ${from}` : ''}`,
      who: celebrationWho(th.subject),
      source: 'email',
      notes: [],
    });
    emails += 1;
  }

  return mergeCelebrations(out);
}
