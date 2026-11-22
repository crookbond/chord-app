/**
 * ADR 0033 — per-(user, Google calendar) busyness policy.
 *
 * On each sync we upsert one row per readable calendar with an
 * auto-picked `counts_for_busy_auto`. The user may set
 * `counts_for_busy_override` from the mobile settings UI; override
 * wins. NULL auto means "we don't know — ask the user" (surfaced as
 * a pending decision).
 */
import type { Kysely } from 'kysely';

import { assignCalendarColors, mailboxLocalPart, normalizeCalendarColor } from '@chord/kernel';

import type { CalendarProvider, DB } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { isSelfReference } from '../utils/self-reference.js';
import { hasCalendarWriteScope } from './google/calendar-write.service.js';
import { outlookCalendarAccounts, outlookDefaultCalendarKey } from './outlook-calendar/enabled.js';
import { isOutlookCalendarKey } from './outlook-calendar/ids.js';
import { parseGmailCalendarKey } from './gmail-calendar/ids.js';

export interface CalendarSourceInput {
  googleCalendarId: string;
  summary: string | null;
  accessRole: 'reader' | 'writer' | 'owner';
  isPrimary: boolean;
  selectedInGoogle: boolean;
  /** When set, the user's Chord-target calendar (ADR 0015). */
  isChordTarget: boolean;
  /** ADR 0057 — source provider. Defaults to 'google' for the existing callers. */
  provider?: CalendarProvider;
  /** ADR 0057 — display color (hex) from the source calendar, if known. */
  color?: string | null;
}

export interface CalendarSourceRow {
  id: string;
  userId: string;
  provider: CalendarProvider;
  googleCalendarId: string;
  summary: string | null;
  color: string | null;
  /** ADR 0278 — the user's pick in Chord. */
  colorChoice: string | null;
  /** ADR 0278 — what Chord shows: pick, else `color`, else Chord's palette. */
  displayColor: string;
  accessRole: string;
  isPrimary: boolean;
  selectedInGoogle: boolean;
  countsForBusyAuto: boolean | null;
  countsForBusyOverride: boolean | null;
  /** Effective value used by conflict checks: override ?? auto ?? false. */
  countsForBusyEffective: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * ADR 0033 / 0072 — judge the Block default from the source API's own
 * signals. Google: `primary` + `accessRole` (owner/writer = your calendar =
 * blocks; reader-only shares, holidays, birthdays = informational). Device:
 * EventKit's `allowsModifications` arrives mapped to writer/reader, so a
 * writable phone calendar blocks and a subscribed/read-only one doesn't. The
 * unified Settings list exposes a per-calendar Block switch to override
 * either way; per-EVENT free/busy (Google transparency, EventKit
 * availability) is honored separately in conflict checks.
 */
export function pickCountsForBusyAuto(input: CalendarSourceInput): boolean {
  if (input.isPrimary) return true;
  if (input.isChordTarget) return true;
  if (input.accessRole === 'owner' || input.accessRole === 'writer') return true;
  return false;
}

function effective(row: {
  counts_for_busy_auto: number | null;
  counts_for_busy_override: number | null;
}): boolean {
  if (row.counts_for_busy_override !== null) return row.counts_for_busy_override === 1;
  if (row.counts_for_busy_auto !== null) return row.counts_for_busy_auto === 1;
  return false;
}

export async function upsertCalendarSource(
  db: Kysely<DB>,
  userId: string,
  input: CalendarSourceInput,
): Promise<void> {
  const now = new Date().toISOString();
  const auto = pickCountsForBusyAuto(input);
  const existing = await db
    .selectFrom('calendar_sources')
    .selectAll()
    .where('user_id', '=', userId)
    .where('google_calendar_id', '=', input.googleCalendarId)
    .executeTakeFirst();

  if (existing) {
    // Refresh metadata + auto (override is preserved untouched).
    await db
      .updateTable('calendar_sources')
      .set({
        provider: input.provider ?? 'google',
        summary: input.summary,
        access_role: input.accessRole,
        is_primary: input.isPrimary ? 1 : 0,
        selected_in_google: input.selectedInGoogle ? 1 : 0,
        counts_for_busy_auto: auto ? 1 : 0,
        last_seen_at: now,
        // Only refresh color when the caller supplied one, so a color-less sync
        // doesn't wipe a previously-captured swatch.
        ...(input.color !== undefined ? { color: input.color } : {}),
      })
      .where('id', '=', existing.id)
      .execute();
    return;
  }

  await db
    .insertInto('calendar_sources')
    .values({
      id: newId('cs'),
      user_id: userId,
      provider: input.provider ?? 'google',
      google_calendar_id: input.googleCalendarId,
      summary: input.summary,
      color: input.color ?? null,
      access_role: input.accessRole,
      is_primary: input.isPrimary ? 1 : 0,
      selected_in_google: input.selectedInGoogle ? 1 : 0,
      counts_for_busy_auto: auto ? 1 : 0,
      counts_for_busy_override: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
}

export async function listCalendarSources(
  db: Kysely<DB>,
  userId: string,
): Promise<CalendarSourceRow[]> {
  const rows = await db
    .selectFrom('calendar_sources')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('is_primary', 'desc')
    .orderBy('summary', 'asc')
    .execute();
  const display = calendarDisplayColors(rows);
  return rows.map((r) => toRow(r, display.get(r.id)!));
}

/**
 * ADR 0278 — every calendar's display color, keyed by row id. Calendars claim
 * colors oldest first (primary before all), so connecting a new calendar never
 * repaints the ones already there.
 */
export function calendarDisplayColors(
  rows: readonly {
    id: string;
    color?: string | null;
    color_choice?: string | null;
    is_primary: number;
    first_seen_at: string;
  }[],
): Map<string, string> {
  const ordered = [...rows].sort(
    (a, b) =>
      b.is_primary - a.is_primary ||
      a.first_seen_at.localeCompare(b.first_seen_at) ||
      a.id.localeCompare(b.id),
  );
  return assignCalendarColors(
    ordered.map((r) => ({ id: r.id, chosen: r.color_choice ?? null, sourceColor: r.color ?? null })),
  );
}

/** Map a DB row to the service-level shape (provider + color included). */
function toRow(
  r: {
    id: string;
    user_id: string;
    provider: CalendarProvider;
    google_calendar_id: string;
    summary: string | null;
    color?: string | null;
    color_choice?: string | null;
    access_role: string;
    is_primary: number;
    selected_in_google: number;
    counts_for_busy_auto: number | null;
    counts_for_busy_override: number | null;
    first_seen_at: string;
    last_seen_at: string;
  },
  displayColor: string,
): CalendarSourceRow {
  return {
    id: r.id,
    userId: r.user_id,
    provider: r.provider,
    googleCalendarId: r.google_calendar_id,
    summary: r.summary,
    color: r.color ?? null,
    colorChoice: r.color_choice ?? null,
    displayColor,
    accessRole: r.access_role,
    isPrimary: r.is_primary === 1,
    selectedInGoogle: r.selected_in_google === 1,
    countsForBusyAuto: r.counts_for_busy_auto === null ? null : r.counts_for_busy_auto === 1,
    countsForBusyOverride:
      r.counts_for_busy_override === null ? null : r.counts_for_busy_override === 1,
    countsForBusyEffective: effective(r),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

export async function setCalendarSourceOverride(
  db: Kysely<DB>,
  userId: string,
  id: string,
  override: boolean | null,
): Promise<CalendarSourceRow | null> {
  const updated = await db
    .updateTable('calendar_sources')
    .set({ counts_for_busy_override: override === null ? null : override ? 1 : 0 })
    .where('user_id', '=', userId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) === 0) return null;
  const all = await listCalendarSources(db, userId);
  return all.find((r) => r.id === id) ?? null;
}

export type SetCalendarColorResult =
  | { ok: true; calendar: CalendarSourceRow }
  | { ok: false; reason: 'not_found' | 'bad_color' | 'no_calendars' }
  | { ok: false; reason: 'ambiguous'; candidates: { id: string; summary: string }[] };

/**
 * ADR 0278 — the one writer of a calendar's color, for Settings (by row id)
 * and chat (by name). Any calendar of the user's can be colored, read-only
 * ones too. A null / empty color clears the pick, returning the calendar to
 * its provider's color or Chord's palette.
 */
export async function setCalendarColor(
  db: Kysely<DB>,
  userId: string,
  target: { id: string } | { name: string },
  color: string | null,
): Promise<SetCalendarColorResult> {
  let choice: string | null = null;
  if (color !== null && color.trim() !== '') {
    choice = normalizeCalendarColor(color);
    if (!choice) return { ok: false, reason: 'bad_color' };
  }
  const all = await listCalendarSources(db, userId);
  if (all.length === 0) return { ok: false, reason: 'no_calendars' };
  let row: CalendarSourceRow | undefined;
  if ('id' in target) {
    row = all.find((r) => r.id === target.id);
  } else {
    const picked = pickCalendarByName(all, target.name);
    if (picked && 'candidates' in picked) return { ok: false, reason: 'ambiguous', candidates: picked.candidates };
    row = picked?.row;
  }
  if (!row) return { ok: false, reason: 'not_found' };
  await db
    .updateTable('calendar_sources')
    .set({ color_choice: choice })
    .where('user_id', '=', userId)
    .where('id', '=', row.id)
    .execute();
  const after = (await listCalendarSources(db, userId)).find((r) => r.id === row!.id)!;
  return { ok: true, calendar: after };
}

/** How a calendar reads in a list: its name, plus the provider when not Google. */
export function calendarSourceLabel(r: Pick<CalendarSourceRow, 'summary' | 'provider'>): string {
  const name = r.summary?.trim() || 'Calendar';
  if (r.provider === 'outlook') return `${name} (Outlook)`;
  if (r.provider === 'device') return `${name} (phone)`;
  return name;
}

/**
 * A calendar by name among ALL the user's calendars (not only writable ones,
 * unlike `matchCalendarsByName`): exact name first, then one loose match;
 * several of either is a question (ADR 0137).
 */
function pickCalendarByName(
  all: CalendarSourceRow[],
  name: string,
): { row: CalendarSourceRow } | { candidates: { id: string; summary: string }[] } | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (PRIMARY_ALIASES.has(n)) {
    const primary = all.find((r) => r.provider === 'google' && r.isPrimary);
    return primary ? { row: primary } : null;
  }
  const names = (r: CalendarSourceRow) => [
    (r.summary ?? '').trim().toLowerCase(),
    calendarSourceLabel(r).toLowerCase(),
    `${(r.summary ?? '').trim().toLowerCase()} (${r.provider})`,
  ];
  const ask = (rows: CalendarSourceRow[]) => ({
    candidates: rows.map((r) => ({ id: r.id, summary: calendarSourceLabel(r) })),
  });
  const exact = all.filter((r) => names(r).includes(n));
  if (exact.length === 1) return { row: exact[0] };
  if (exact.length > 1) return ask(exact);
  const partial = all.filter((r) => names(r).some((x) => x.includes(n)));
  if (partial.length === 1) return { row: partial[0] };
  if (partial.length > 1) return ask(partial);
  return null;
}

/**
 * Return the set of google_calendar_id strings that count for busy
 * checks for this user — used to pre-filter event rows in
 * find_conflicts.
 */
export async function busyCalendarIds(
  db: Kysely<DB>,
  userId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom('calendar_sources')
    .select(['google_calendar_id', 'counts_for_busy_auto', 'counts_for_busy_override'])
    .where('user_id', '=', userId)
    .execute();
  const out = new Set<string>();
  for (const r of rows) if (effective(r)) out.add(r.google_calendar_id);
  return out;
}

/**
 * Everything needed to decide whether an event blocks the user's time:
 * the set of busy calendar ids plus the user's primary read calendar id
 * (primary-sourced events carry `gcal:<id>` with no embedded calendar id,
 * so we attribute them to the primary).
 */
export interface BusyContext {
  busy: Set<string>;
  primaryCalendarId: string | null;
}

export async function loadBusyContext(
  db: Kysely<DB>,
  userId: string,
): Promise<BusyContext> {
  const busy = await busyCalendarIds(db, userId);
  const primaryRow = await db
    .selectFrom('calendar_sources')
    .select('google_calendar_id')
    .where('user_id', '=', userId)
    .where('provider', '=', 'google')
    .where('is_primary', '=', 1)
    .executeTakeFirst();
  return { busy, primaryCalendarId: primaryRow?.google_calendar_id ?? null };
}

/**
 * Does this event count as a real (hard) conflict candidate? Chord-native
 * events (no Google linkage) always block; Google-sourced events block only
 * when their source calendar is on the user's busy set. Events on informational
 * ("info") calendars — shared read-only schedules the user does not treat as
 * busy — return false and must be excluded from conflict checks.
 *
 * ADR 0040 — a two-way-synced copy carries `google_calendar_id` (the new pull no
 * longer stamps `external_uid`), so prefer it; fall back to the legacy `gcal:`
 * external_uid; otherwise treat as Chord-native.
 */
const PRIMARY_ALIASES = new Set(['personal', 'primary', 'me', 'my', 'mine', 'my calendar', 'self']);
/** Names that mean "my Outlook calendar" rather than a calendar's own title. */
const OUTLOOK_ALIASES = new Set([
  'outlook',
  'outlook calendar',
  'my outlook',
  'my outlook calendar',
  'microsoft',
  'microsoft 365',
  'office',
  'office 365',
  'm365',
  'exchange',
]);

/**
 * Resolve a calendar NAME (from a prompt: "family", "personal", "work") to a
 * writable Google calendar id for this user. 'personal'/'primary'/etc → the
 * user's primary; otherwise an exact (then substring) case-insensitive match on
 * a calendar_sources summary the user can write to. Null when nothing matches.
 *
 * Never a DEVICE source (ADR 0136). `calendar_sources` holds device rows too,
 * and for those `google_calendar_id` is an EventKit identifier — a name match
 * that returned one would hand a provider an id it has never heard of, and the
 * push fails `events.insert 404` with the event reaching no calendar at all.
 * A phone that mirrors a Google calendar produces two rows with the SAME
 * summary, so this is the common case, not an edge one.
 *
 * Google and Outlook calendars both qualify (ADR 0228): each is a calendar the
 * server can write to. "Outlook" on its own means the Outlook default calendar.
 */
export async function matchCalendarByName(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<string | null> {
  return (await matchCalendarsByName(db, userId, name)).calendarId;
}

/**
 * One name resolved (ADR 0137): the id, or the candidates when a name fits
 * more than one calendar.
 */
export interface CalendarNameMatch {
  /** Null when nothing matched, or when the name was genuinely ambiguous. */
  calendarId: string | null;
  /** Set only for an ambiguous name, so the caller can ASK instead of guess. */
  candidates?: { calendarId: string; summary: string; accessRole: string }[];
}

/**
 * Rank writable calendars: a calendar you OWN beats one merely shared with
 * you, your primary beats the rest, and everything after that is ordered so
 * the answer cannot change between two identical calls. Row order out of
 * Postgres is arbitrary and shifts as rows move, so leaving it to `.find()`
 * makes the pick a coin flip that later gets cached as a group default.
 */
function rankSource<T extends { access_role: string; is_primary: number; google_calendar_id: string }>(
  a: T,
  b: T,
): number {
  const owned = (s: T) => (s.access_role === 'owner' ? 0 : 1);
  return (
    owned(a) - owned(b) ||
    b.is_primary - a.is_primary ||
    a.google_calendar_id.localeCompare(b.google_calendar_id)
  );
}

/**
 * A calendar asked for by name. "Neural Calendar" means the calendar called
 * "Neural": people say the word "calendar" (and "my"/"the") around the name,
 * so when the name as said matches nothing it is tried again without them.
 */
export async function matchCalendarsByName(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<CalendarNameMatch> {
  const first = await matchCalendarsByExactWords(db, userId, name);
  if (first.calendarId || first.candidates?.length) return first;
  const bare = bareCalendarName(name);
  if (!bare || bare === name.trim().toLowerCase()) return first;
  return matchCalendarsByExactWords(db, userId, bare);
}

/** The name without a leading "my"/"the"/"our" or a trailing "calendar". */
export function bareCalendarName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(?:my|the|our)\s+/, '')
    .replace(/\s+(?:calendar|cal)$/, '')
    .trim();
}

async function matchCalendarsByExactWords(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<CalendarNameMatch> {
  const n = name.trim().toLowerCase();
  if (!n) return { calendarId: null };
  if (PRIMARY_ALIASES.has(n)) {
    const primary = await db
      .selectFrom('calendar_sources')
      .select('google_calendar_id')
      .where('user_id', '=', userId)
      .where('provider', '=', 'google')
      .where('is_primary', '=', 1)
      .executeTakeFirst();
    return { calendarId: primary?.google_calendar_id ?? 'primary' };
  }
  // "Outlook", or the mailbox's own address: that mailbox's default calendar.
  const outlookAccounts = (await outlookCalendarAccounts(db, userId)).filter((a) => !!a.calendar_default_id);
  const byAddress = outlookAccounts.filter((a) => n.includes(a.email_address.toLowerCase()));
  if (byAddress.length === 1) return { calendarId: byAddress[0].calendar_default_id! };
  if (OUTLOOK_ALIASES.has(n)) {
    if (outlookAccounts.length === 1) return { calendarId: outlookAccounts[0].calendar_default_id! };
    if (outlookAccounts.length > 1) {
      return {
        calendarId: null,
        candidates: outlookAccounts.map((a) => ({
          calendarId: a.calendar_default_id!,
          summary: `Outlook ${a.email_address}`,
          accessRole: 'owner',
        })),
      };
    }
    return { calendarId: null };
  }
  const sources = await db
    .selectFrom('calendar_sources')
    .select(['google_calendar_id', 'summary', 'access_role', 'is_primary', 'provider'])
    .where('user_id', '=', userId)
    .where('provider', 'in', ['google', 'outlook'])
    .execute();
  const writable = sources
    .filter((s) => s.access_role === 'owner' || s.access_role === 'writer')
    .sort(rankSource);
  // A calendar also answers to its name as a candidate list shows it,
  // "Family (Outlook)" / "Family (Google)", so one read back verbatim resolves.
  const names = (s: { summary: string | null; provider: string }): string[] => {
    const base = (s.summary ?? '').trim().toLowerCase();
    return [base, `${base} (${s.provider})`];
  };
  const norm = (s: { summary: string | null; provider: string }) => names(s).join('\n');

  const exact = writable.filter((s) => names(s).includes(n));
  // Two calendars with the SAME name is a question, not a tie — the same
  // exact-name-or-ask posture ADR 0077 takes for email routing and ADR 0094
  // for list names. An owned calendar still wins outright: "my Family" and
  // "a Family someone shared with me" is not really a 50/50.
  if (exact.length > 1 && exact[0].access_role !== 'owner') return asAmbiguous(exact);
  // The same name owned on BOTH providers has no ranking that answers it.
  const owned = exact.filter((s) => s.access_role === 'owner');
  if (new Set(owned.map((s) => s.provider)).size > 1) return asAmbiguous(owned);
  if (exact.length >= 1) return { calendarId: exact[0].google_calendar_id };

  // A mailbox's calendar is often just "Calendar" (Settings shows "Outlook"),
  // so people name it by the MAILBOX: "Neural" for john@neural.ai, or the
  // nickname they gave it (ADR 0145). Exact keys only, and two mailboxes
  // answering to one name is a question.
  const byMailbox = (await calendarMailboxes(db, userId)).filter((a) => mailboxKeys(a).includes(n));
  if (byMailbox.length === 1) return { calendarId: byMailbox[0].calendar_default_id! };
  if (byMailbox.length > 1) {
    return {
      calendarId: null,
      candidates: byMailbox.map((a) => ({
        calendarId: a.calendar_default_id!,
        summary: `${a.provider === 'outlook' ? 'Outlook' : 'Google'} ${a.email_address}`,
        accessRole: 'owner',
      })),
    };
  }

  const partial = writable.filter((s) => norm(s).includes(n));
  // A loose match that fits several names is never worth guessing: "family"
  // over "Family" and "Family Trips" has no defensible winner.
  if (partial.length > 1) return asAmbiguous(partial);
  if (partial.length === 1) return { calendarId: partial[0].google_calendar_id };
  // No calendar carries the name, and the name is only a way of saying "mine"
  // ("/personal", "personal calendar", "my own calendar"): the primary. Checked
  // last so a calendar really called "Personal Projects" still wins.
  if (isSelfReference(n)) {
    const primary = writable.find((s) => s.provider === 'google' && s.is_primary === 1);
    return { calendarId: primary?.google_calendar_id ?? 'primary' };
  }
  return { calendarId: null };
}

/** Attached mailboxes that carry their own calendar (Outlook, ADR 0228; a
 *  second Gmail, ADR 0313), with the default calendar to file into. */
async function calendarMailboxes(
  db: Kysely<DB>,
  userId: string,
): Promise<{ provider: string; email_address: string; nickname?: string | null; calendar_default_id?: string | null }[]> {
  const gmail = await db
    .selectFrom('email_accounts')
    .select(['provider', 'email_address', 'nickname', 'calendar_default_id'])
    .where('user_id', '=', userId)
    .where('provider', '=', 'gmail')
    .where('status', '=', 'ok')
    .where('calendar_enabled', '=', 1)
    .orderBy('created_at', 'asc')
    .execute();
  return [...(await outlookCalendarAccounts(db, userId)), ...gmail].filter((a) => !!a.calendar_default_id);
}

/** What a person calls a mailbox: its nickname, the address, the address's
 *  local part, and the domain's first label ("neural" for john@neural.ai). */
export function mailboxKeys(a: { email_address: string; nickname?: string | null }): string[] {
  const keys: string[] = [];
  if (a.nickname?.trim()) keys.push(a.nickname.trim());
  const address = a.email_address.trim();
  keys.push(address, mailboxLocalPart(address));
  const domain = address.split('@')[1];
  if (domain) keys.push(domain.split('.')[0]);
  return [...new Set(keys.map((k) => k.toLowerCase()).filter(Boolean))];
}

function asAmbiguous(
  rows: { google_calendar_id: string; summary: string | null; access_role: string; provider: string }[],
): CalendarNameMatch {
  // The provider is named only when the list spans both: that is the one case
  // where two candidates could otherwise read the same.
  const mixed = new Set(rows.map((s) => s.provider)).size > 1;
  const label = (s: (typeof rows)[number]): string => {
    const name = s.summary ?? (s.provider === 'outlook' ? 'Calendar' : s.google_calendar_id);
    if (s.provider === 'outlook') return `${name} (Outlook)`;
    return mixed ? `${name} (Google)` : name;
  };
  return {
    calendarId: null,
    candidates: rows.map((s) => ({
      calendarId: s.google_calendar_id,
      summary: label(s),
      accessRole: s.access_role,
    })),
  };
}

/**
 * Is this id still a calendar we can actually push to?
 *
 * `users.default_calendar_id` is a CACHE of an earlier resolution, so a bad
 * value outlives the bug that produced one: four events in prod inherited a
 * device id from a default and failed silently for three days. A cached
 * default is therefore re-checked rather than trusted.
 */
async function isPushableCalendar(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
): Promise<boolean> {
  if (calendarId === 'primary') return true;
  const row = await db
    .selectFrom('calendar_sources')
    .select('google_calendar_id')
    .where('user_id', '=', userId)
    .where('provider', 'in', ['google', 'outlook'])
    .where('google_calendar_id', '=', calendarId)
    .executeTakeFirst();
  // Unknown to us is not the same as invalid: a calendar the sources list has
  // not caught up with still belongs to Google's namespace. Only a known
  // DEVICE id is rejected, which is the failure actually observed.
  if (row) return true;
  const device = await db
    .selectFrom('calendar_sources')
    .select('provider')
    .where('user_id', '=', userId)
    .where('google_calendar_id', '=', calendarId)
    .executeTakeFirst();
  return device?.provider !== 'device';
}

export type CalendarPickSource = 'requested' | 'user' | 'primary';

/**
 * Decide which calendar an event goes on (ADR 0040, amended by ADR 0233).
 * Resolution order:
 *   1. a name requested in the prompt/tool call - for THAT event only
 *   2. the user's own default (`users.default_calendar_id`)
 *   3. the user's primary
 * There is deliberately no group-level step: a calendar named once used to be
 * remembered for the whole group, which sent every later event in it - flights
 * included - to a calendar nobody had asked for. Personal is the default.
 *
 * An ambiguous requested name comes back with `candidates` and NO id, so the
 * caller can ask (ADR 0137). Falling through to the user's default instead
 * would quietly answer a different question than the one the user asked.
 */
export interface CalendarPick {
  calendarId: string;
  source: CalendarPickSource;
  candidates?: { calendarId: string; summary: string; accessRole: string }[];
  /** Set when a name was requested but matched NOTHING — not the ambiguous
   *  (2+) case above, and not "no name given" either. Carries the name so the
   *  caller can tell the user their request wasn't recognized. */
  requestedNotFound?: string;
}

/**
 * What `primary` stands for. It names the Google primary; a user with no
 * Google calendar but an Outlook one has none, and for them it is the Outlook
 * default calendar (ADR 0228) — the same reading the push applies, so what a
 * caller reports is where the event goes.
 */
export async function effectivePrimaryCalendar(db: Kysely<DB>, userId: string): Promise<string> {
  if (await hasCalendarWriteScope(db, userId)) return 'primary';
  return (await outlookDefaultCalendarKey(db, userId)) ?? 'primary';
}

export async function resolveTargetCalendarId(
  db: Kysely<DB>,
  opts: { userId: string; requestedName?: string | null },
): Promise<CalendarPick> {
  const pick = await pickTargetCalendar(db, opts);
  return pick.calendarId === 'primary'
    ? { ...pick, calendarId: await effectivePrimaryCalendar(db, opts.userId) }
    : pick;
}

async function pickTargetCalendar(
  db: Kysely<DB>,
  opts: { userId: string; requestedName?: string | null },
): Promise<CalendarPick> {
  if (opts.requestedName) {
    const match = await matchCalendarsByName(db, opts.userId, opts.requestedName);
    if (match.calendarId) return { calendarId: match.calendarId, source: 'requested' };
    if (match.candidates?.length) {
      // The id is still the sensible default so a caller that ignores
      // `candidates` writes somewhere real rather than failing.
      return { calendarId: 'primary', source: 'primary', candidates: match.candidates };
    }
    // A REQUESTED name matching zero calendars is not the same question as
    // no name at all. Falling through to the user default below would
    // silently answer with whatever calendar a PAST request cached - "add to
    // personal" landing on a remembered "Family" default because the model's
    // phrasing didn't hit an alias or an exact/substring match. Primary is
    // always a real, writable calendar; the user default might be exactly the
    // calendar the user was trying to avoid.
    return { calendarId: 'primary', source: 'primary', requestedNotFound: opts.requestedName };
  }
  const u = await db
    .selectFrom('users')
    .select('default_calendar_id')
    .where('id', '=', opts.userId)
    .executeTakeFirst();
  if (u?.default_calendar_id && (await isPushableCalendar(db, opts.userId, u.default_calendar_id))) {
    return { calendarId: u.default_calendar_id, source: 'user' };
  }
  return { calendarId: 'primary', source: 'primary' };
}

export interface DefaultCalendarView {
  /** The stored default, or null when events go to the primary. */
  calendarId: string | null;
  label: string;
}

export type SetDefaultCalendarResult =
  | ({ ok: true } & DefaultCalendarView)
  | { ok: false; reason: 'not_found' | 'not_writable' }
  | {
      ok: false;
      reason: 'ambiguous';
      candidates: { calendarId: string; summary: string; accessRole: string }[];
    };

/**
 * The calendar an event with no named calendar goes on, as the user should
 * see it. Read through `resolveTargetCalendarId`, so a stored default that is
 * no longer pushable reads as the primary here too.
 */
export async function getDefaultCalendar(db: Kysely<DB>, userId: string): Promise<DefaultCalendarView> {
  const pick = await resolveTargetCalendarId(db, { userId });
  return {
    calendarId: pick.source === 'user' ? pick.calendarId : null,
    label: await calendarLabel(db, userId, pick.calendarId),
  };
}

/**
 * Set `users.default_calendar_id` — the one writer for Settings and chat.
 * A NAME is resolved like a calendar named for one event (exact or ask, ADR
 * 0137); an ID must be a Google/Outlook calendar the user can write to, never
 * a device calendar (ADR 0136). The primary, an empty name and null all CLEAR
 * the default, since the primary is already what an unset default means.
 */
export async function setDefaultCalendar(
  db: Kysely<DB>,
  userId: string,
  target: { calendarId: string | null } | { name: string },
): Promise<SetDefaultCalendarResult> {
  let id: string | null;
  if ('name' in target) {
    const name = target.name.trim();
    if (!name) {
      id = null;
    } else {
      const match = await matchCalendarsByName(db, userId, name);
      if (match.candidates?.length) return { ok: false, reason: 'ambiguous', candidates: match.candidates };
      if (!match.calendarId) return { ok: false, reason: 'not_found' };
      id = match.calendarId;
    }
  } else {
    id = target.calendarId?.trim() || null;
  }
  if (id === 'primary') id = null;
  if (id !== null) {
    const row = await db
      .selectFrom('calendar_sources')
      .select(['provider', 'is_primary', 'access_role'])
      .where('user_id', '=', userId)
      .where('provider', 'in', ['google', 'outlook'])
      .where('google_calendar_id', '=', id)
      .executeTakeFirst();
    if (!row || (row.access_role !== 'owner' && row.access_role !== 'writer')) {
      return { ok: false, reason: 'not_writable' };
    }
    if (row.provider === 'google' && row.is_primary === 1) id = null;
  }
  await db.updateTable('users').set({ default_calendar_id: id }).where('id', '=', userId).execute();
  return { ok: true, ...(await getDefaultCalendar(db, userId)) };
}

/**
 * Human-readable name for a resolved calendar id — "primary" for the
 * literal sentinel, else the stored `calendar_sources.summary`. Used so a
 * tool result can tell the model exactly which calendar an event landed on,
 * rather than the model inferring (or worse, echoing the user's own request
 * regardless of what actually happened — the "told it personal, got family"
 * failure).
 */
export async function calendarLabel(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
): Promise<string> {
  if (calendarId === 'primary') return 'primary';
  const row = await db
    .selectFrom('calendar_sources')
    .select('summary')
    .where('user_id', '=', userId)
    .where('google_calendar_id', '=', calendarId)
    .executeTakeFirst();
  if (isOutlookCalendarKey(calendarId)) return `${row?.summary?.trim() || 'Calendar'} (Outlook)`;
  const gmailAccount = parseGmailCalendarKey(calendarId);
  if (gmailAccount) {
    // ADR 0313 — an attached Gmail's calendar names its mailbox, so it never
    // reads as the login account's.
    const acct = await db
      .selectFrom('email_accounts')
      .select('email_address')
      .where('id', '=', gmailAccount.accountId)
      .executeTakeFirst();
    const name = row?.summary?.trim() || 'Calendar';
    const address = acct?.email_address ?? '';
    return !address || name.toLowerCase() === address.toLowerCase() ? name : `${name} (${address})`;
  }
  return row?.summary?.trim() || 'primary';
}

export function eventBlocksTime(
  event: { external_uid: string | null; google_calendar_id?: string | null },
  ctx: BusyContext,
): boolean {
  if (event.google_calendar_id) return ctx.busy.has(event.google_calendar_id);
  const uid = event.external_uid;
  if (!uid) return true;
  // A device-calendar copy (ADR 0057) carries `device:<calId>:<eventId>`.
  // Resolve the calendar id and honour its Block setting, exactly like a
  // `gcal:` source — otherwise a read-only subscribed phone calendar counts
  // as busy (`ctx.busy` already holds device calendar ids).
  for (const prefix of ['gcal:', 'device:'] as const) {
    if (!uid.startsWith(prefix)) continue;
    const rest = uid.slice(prefix.length);
    const sep = rest.indexOf(':');
    const calId =
      sep === -1
        ? prefix === 'gcal:'
          ? ctx.primaryCalendarId
          : rest || null
        : rest.slice(0, sep);
    return calId !== null && ctx.busy.has(calId);
  }
  // Anything else is a Chord-native event — always blocks.
  return true;
}
