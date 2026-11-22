/**
 * ADR 0091 — the briefing reduced to fixed, single-line facts.
 *
 * A Meta template body variable cannot contain a newline and cannot be empty,
 * so an out-of-window briefing has to be assembled from slots rather than
 * prose. The briefing's own `🚨 Conflicts` / `⏰ This week` / `📋 Heads-up`
 * sections are LLM output shaped only by a prompt, so they cannot be parsed
 * back into slots reliably — this module is a deterministic SIBLING built from
 * the same underlying rows, the way `summarize_email` sits beside the email
 * digest (ADR 0072).
 *
 * Every field is one line or null. Callers decide what an absent fact renders
 * as: the teaser omits the line, the template substitutes a fallback because
 * Meta rejects an empty variable.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { byInstant, textInstant } from '../../db/text-instant.js';
import {
  dayOf,
  daysBetween,
  eventLocalDays,
  fmtTimeOnly,
  instantInZoneMs,
  isAllDayValue,
} from '../../utils/tz.js';
import { pendingSuggestionsForUser } from '../email/magics.service.js';
import { listEventsForUser } from '../events.service.js';
import { resolveWeatherLocation, type StoredLocation } from '../geo/location.js';
import { getWeatherProvider } from '../weather/index.js';
import { celebrationsOneLine, collectCelebrations } from './celebrations.js';
import { firstOfEach, sameWordsKey } from './compose.js';
import { RETIRED_WINDOW_MS, retiredTodosSince } from './retired-todos.js';

export interface BriefingFacts {
  /** "☀️ Clear · 72°/58°F" */
  weather: string | null;
  /** Events today. "2 events — first: Standup at 9:00 AM" */
  today: string | null;
  /** Events in the next 7 days, today excluded. */
  thisWeek: string | null;
  /** Birthdays/anniversaries and further-out events worth flagging. */
  headsUp: string | null;
  /** Open tasks, overdue first; carries the ADR 0092 retirement note. */
  tasks: string | null;
  /** "2 waiting on you · 14 unread" */
  email: string | null;
}

const WEEK_DAYS = 7;
const HEADS_UP_DAYS = 14;

/** Collapse anything that could carry a newline into a single safe line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Today's weather as one line, or null when weather is disabled, the location
 * is unknown, or the provider is unreachable. Never throws — also used to
 * prepend the line to the full LLM briefing.
 */
export async function weatherLineForUser(
  db: Kysely<DB>,
  userId: string,
  tz?: string | null,
  preloadedLocation?: StoredLocation,
): Promise<string | null> {
  const provider = getWeatherProvider();
  if (!provider) return null;
  try {
    const loc = await resolveWeatherLocation(db, userId, preloadedLocation);
    if (!loc) return null;
    // `undefined` means "look it up"; an explicit null means "no zone".
    let zone = tz ?? null;
    if (tz === undefined) {
      const row = await db
        .selectFrom('users')
        .select('last_tz')
        .where('id', '=', userId)
        .executeTakeFirst();
      zone = row?.last_tz ?? null;
    }
    const today = await provider.today({ lat: loc.lat, lon: loc.lon }, zone, loc.place);
    return today ? oneLine(today.line) : null;
  } catch (err) {
    logger.info('briefing facts: weather failed', { err, userId });
    return null;
  }
}

/**
 * Build every fact for one user. Individual sections fail to null rather than
 * throwing — a briefing missing its weather line is fine; a briefing that
 * throws is not.
 */
export async function buildBriefingFacts(
  db: Kysely<DB>,
  userId: string,
): Promise<BriefingFacts> {
  // Pulls the weather columns too so `weatherLineForUser` → `resolveWeatherLocation`
  // doesn't have to re-select the same `users` row a moment later.
  const user = await db
    .selectFrom('users')
    .select(['last_tz', 'weather_lat', 'weather_lon', 'weather_place', 'weather_place_source'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const tz = user?.last_tz ?? null;
  const todayStr = dayOf(new Date().toISOString(), tz);

  const [weather, events, taskRows, suggestions, unreadRow] = await Promise.all([
    weatherLineForUser(db, userId, tz, user),
    listEventsForUser(db, userId, { tz }).catch(() => []),
    db
      .selectFrom('tasks')
      .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
      .where('group_members.user_id', '=', userId)
      .where('tasks.status', 'in', ['open', 'active'])
      .select(['tasks.title', 'tasks.due_at'])
      .orderBy(sql`${textInstant('tasks.due_at', tz)} asc nulls last`)
      .limit(50)
      .execute()
      .catch(() => []),
    pendingSuggestionsForUser(db, userId, 20).catch(() => []),
    db
      .selectFrom('email_threads')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('is_unread', '=', 1)
      .where('is_archived', '=', 0)
      .executeTakeFirst()
      .catch(() => undefined),
  ]);

  // Copies of one event or to-do (group copies, a Google and a phone copy)
  // are one thing; counted twice they inflated "3 events" and "5 to-dos".
  const dated = firstOfEach(
    events.filter((e) => e.startsAt),
    (e) => `${sameWordsKey(e.title)}|${instantInZoneMs(e.startsAt, tz)}`,
  )
    .map((e) => {
      const { first, last } = eventLocalDays(e.startsAt, e.endsAt, tz);
      return { ...e, day: first, lastDay: last };
    })
    .sort(byInstant((e) => e.startsAt));
  const tasks = firstOfEach(taskRows, (t) => sameWordsKey(t.title));

  // A multi-day event that began before today is on today's calendar too.
  const todays = dated.filter((e) => e.day <= todayStr && e.lastDay >= todayStr);
  const week = dated.filter((e) => {
    const out = daysBetween(e.day, todayStr);
    return out > 0 && out <= WEEK_DAYS;
  });
  const later = dated.filter((e) => {
    const out = daysBetween(e.day, todayStr);
    return out > WEEK_DAYS && out <= HEADS_UP_DAYS;
  });

  const todayFact =
    todays.length > 0
      ? oneLine(
          `${plural(todays.length, 'event')} — first: ${todays[0].title} ${
            todays[0].day < todayStr || isAllDayValue(todays[0].startsAt)
              ? 'all day'
              : `at ${fmtTimeOnly(todays[0].startsAt, tz)}`
          }`,
        )
      : null;

  const weekFact =
    week.length > 0
      ? oneLine(`${plural(week.length, 'event')} — next: ${week[0].title} on ${week[0].day}`)
      : null;

  // Birthdays and anniversaries lead the heads-up line (ADR 0272): from
  // People, the calendar, to-dos and email, not People alone.
  const headsUpBits: string[] = [];
  const celebrations = await collectCelebrations(db, userId, tz, { events }).catch(() => []);
  const celebrationLine = celebrationsOneLine(celebrations, todayStr);
  if (celebrationLine) headsUpBits.push(celebrationLine);
  if (headsUpBits.length === 0 && later.length > 0) {
    headsUpBits.push(`${later[0].title} on ${later[0].day}`);
  }
  const headsUpFact = headsUpBits.length > 0 ? oneLine(headsUpBits.join(' · ')) : null;

  // ADR 0092 / 0285 — the to-dos Chord took off the list since the last
  // briefing. Without this a gated (ADR 0079) or WhatsApp-only (ADR 0091) user
  // would watch their list shrink with no explanation. The same set the full
  // briefing lists by name; here it is folded into the tasks line, naming the
  // first, because the approved Meta template has exactly five body variables
  // and a sixth would need re-approval.
  const retired = await retiredTodosSince(
    db,
    userId,
    new Date(Date.now() - RETIRED_WINDOW_MS).toISOString(),
  ).catch(() => []);
  const retiredBit =
    retired.length > 0
      ? `${retired.length} taken off your list (${retired[0].title}${retired.length > 1 ? ` +${retired.length - 1} more` : ''}) — see Archived`
      : null;

  const nowMs = Date.now();
  const overdue = tasks.filter((t) => t.due_at && Date.parse(t.due_at) < nowMs);
  const tasksFact =
    tasks.length > 0
      ? oneLine(
          [
            overdue.length > 0
              ? `${plural(tasks.length, 'open task')}, ${overdue.length} overdue — next: ${tasks[0].title}`
              : `${plural(tasks.length, 'open task')} — next: ${tasks[0].title}`,
            retiredBit,
          ]
            .filter(Boolean)
            .join(' · '),
        )
      : // Still say it when the sweep emptied the list entirely — that is
        // exactly the case where silence looks like data loss.
        retiredBit && oneLine(retiredBit);

  const unread = Number(unreadRow?.n ?? 0);
  const emailBits: string[] = [];
  if (suggestions.length > 0) emailBits.push(`${suggestions.length} waiting on you`);
  if (unread > 0) emailBits.push(`${unread} unread`);
  const emailFact = emailBits.length > 0 ? emailBits.join(' · ') : null;

  return {
    weather,
    today: todayFact,
    thisWeek: weekFact,
    headsUp: headsUpFact,
    tasks: tasksFact,
    email: emailFact,
  };
}
