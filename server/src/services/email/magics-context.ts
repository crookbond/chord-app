/**
 * ADR 0088 — bounded calendar / tasks / trips snapshot injected into the
 * email-magics extractor so the model can resolve "the half marathon" against
 * the world instead of guessing a twin. Names and dates only; no group ids
 * (ADR 0032). Loaded once per `runEmailMagics` pass.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { mentionedDays } from '../../utils/date-mentions.js';
import {
  addDays,
  instantInZoneMs,
  isAllDayValue,
  svWall,
  zonedDayEndUtc,
  zonedDayStartUtc,
} from '../../utils/tz.js';
import { busyIntervalsInWindow } from '../conflicts.service.js';
import { userAwayDays } from '../whereabouts.service.js';

export const CONTEXT_EVENT_PAST_MS = 12 * 60 * 60 * 1000;
export const CONTEXT_EVENT_FUTURE_MS = 60 * 24 * 60 * 60 * 1000;
export const CONTEXT_EVENT_CAP = 12;
export const CONTEXT_TASK_CAP = 8;
export const CONTEXT_TRIP_CAP = 6;
export const CONTEXT_PENDING_CAP = 6;
/** Events added for one email: ones on the days it mentions or from its sender. */
export const CONTEXT_EXTRA_EVENT_CAP = 6;

/**
 * The row caps alone don't bound the prompt: titles come from ICS / Google,
 * where nothing enforces the 200-char tool-schema limit. Clip each name and
 * ceiling the whole block at the body's own budget, so world context can never
 * outweigh the email it's meant to help read.
 */
export const CONTEXT_NAME_CHARS = 80;
export const CONTEXT_BLOCK_CHARS = 2000;

/**
 * `starts_at` / `due_at` are ISO strings with MIXED offsets, so SQL compares and
 * orders them lexically — off by up to a day either way. Same technique as
 * `conflicts.service`: widen the SQL bounds, then window/order by real instant
 * in JS. Over-fetch so the JS sort, not the lexical one, decides the cap.
 */
const PAD_MS = 36 * 60 * 60 * 1000;
const OVERFETCH = 4;

export interface WorldEventLine {
  title: string;
  at: string;
  /** ADR 0248 — present on rows loaded from the database; a line with an id
   *  gets a label (e1, e2…) the extractor can name in a `change` item. */
  id?: string;
  seriesId?: string | null;
}
export interface WorldTaskLine {
  title: string;
  dueAt: string | null;
  id?: string;
}
/** ADR 0248 — an email suggestion still waiting for a yes (p1, p2…). */
export interface WorldPendingLine {
  id: string;
  tool: 'create_event' | 'create_task';
  title: string;
  at: string | null;
  args: Record<string, unknown>;
  provenance: string | null;
}
export interface WorldTripLine {
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
}

export interface OpenSlot {
  startMs: number;
  endMs: number;
}

export interface MagicsWorldContext {
  events: WorldEventLine[];
  tasks: WorldTaskLine[];
  trips: WorldTripLine[];
  /** ADR 0248 — pending email suggestions, newest first. */
  pending?: WorldPendingLine[];
  /** Bookable gaps for the next `AVAIL_WINDOW_DAYS`. Empty means "say nothing
   *  about availability" — either genuinely nothing bookable, or unknown
   *  because the busy scan truncated. The two must look the same to the model:
   *  a half-read calendar offering a slot is worse than offering none. */
  openSlots: OpenSlot[];
}

/** How far ahead to offer times. A meeting request is nearly always "this week"
 *  or "next week"; asked on a Friday, "next week" still lands inside this. */
export const AVAIL_WINDOW_DAYS = 12;
/** Bookable hours in the user's own zone. Deliberately not "any gap" — 3am is
 *  free on every calendar and is not an answer. */
export const AVAIL_DAY_START_HOUR = 9;
export const AVAIL_DAY_END_HOUR = 18;
/** Shorter gaps aren't worth proposing to someone asking for a meeting. */
export const AVAIL_MIN_SLOT_MS = 60 * 60 * 1000;
/** At most one slot per day, so a quiet fortnight can't crowd out the email. */
export const AVAIL_SLOT_CAP = 5;
/** Nothing today or tomorrow-morning — a reply proposing a time two hours from
 *  now reads as a mistake. */
export const AVAIL_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Subtract busy intervals from each day's bookable band and keep the first
 * long-enough gap per day. Pure: the caller supplies both the busy list and
 * `nowMs`, so this is testable without a clock or a database.
 */
export function openSlotsFrom(
  busy: Array<{ startMs: number; endMs: number }>,
  opts: {
    nowMs: number;
    tz: string | null;
    days?: number;
    cap?: number;
    /** Local days never to offer: the user is away on a trip (ADR 0245). */
    skipDays?: ReadonlySet<string>;
  },
): OpenSlot[] {
  const days = opts.days ?? AVAIL_WINDOW_DAYS;
  const cap = opts.cap ?? AVAIL_SLOT_CAP;
  const earliest = opts.nowMs + AVAIL_LEAD_MS;
  const sorted = [...busy].sort((a, b) => a.startMs - b.startMs);
  const out: OpenSlot[] = [];

  const today = dayStringAt(opts.nowMs, opts.tz);
  for (let d = 0; d < days && out.length < cap; d += 1) {
    const day = addDays(today, d);
    if (opts.skipDays?.has(day)) continue;
    const dayStart = zonedDayStartUtc(day, opts.tz).getTime();
    if (!Number.isFinite(dayStart)) continue;
    let cursor = Math.max(dayStart + AVAIL_DAY_START_HOUR * 3600000, earliest);
    const dayEnd = dayStart + AVAIL_DAY_END_HOUR * 3600000;

    for (const b of sorted) {
      if (b.endMs <= cursor) continue;
      if (b.startMs >= dayEnd) break;
      if (b.startMs - cursor >= AVAIL_MIN_SLOT_MS) break;
      cursor = Math.max(cursor, b.endMs);
    }
    const end = Math.min(cursor + AVAIL_MIN_SLOT_MS, dayEnd);
    if (end - cursor >= AVAIL_MIN_SLOT_MS) out.push({ startMs: cursor, endMs: end });
  }
  return out;
}

function dayStringAt(ms: number, tz: string | null): string {
  try {
    return svWall(new Date(ms), tz ?? 'UTC').slice(0, 10);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Real window + soonest-first order + cap, by instant rather than by string. */
export function windowEvents(
  rows: WorldEventLine[],
  fromMs: number,
  untilMs: number,
  cap = CONTEXT_EVENT_CAP,
  tz: string | null = null,
): WorldEventLine[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return rows
    .map((r) => ({ row: r, at: instantInZoneMs(r.at, tz), allDay: isAllDayValue(r.at) }))
    // An all-day event counts until its day is over, not from its midnight.
    .filter((r) => Number.isFinite(r.at) && (r.allDay ? r.at + DAY_MS : r.at) >= fromMs && r.at <= untilMs)
    .sort((a, b) => a.at - b.at || a.row.title.localeCompare(b.row.title))
    .slice(0, cap)
    .map((r) => r.row);
}

/** Soonest due first, undated last. */
export function sortTasks(rows: WorldTaskLine[], cap = CONTEXT_TASK_CAP): WorldTaskLine[] {
  const due = (t: WorldTaskLine): number => {
    const p = t.dueAt ? Date.parse(t.dueAt) : NaN;
    return Number.isFinite(p) ? p : Infinity;
  };
  return [...rows]
    .sort((a, b) => due(a) - due(b) || a.title.localeCompare(b.title))
    .slice(0, cap);
}

function todayInTz(tz: string | null): string {
  try {
    return svWall(new Date(), tz ?? 'UTC').slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function whenInTz(iso: string, tz: string | null): string {
  if (isAllDayValue(iso)) return `${iso.slice(0, 10)} (all day)`;
  const t = instantInZoneMs(iso, tz);
  if (!Number.isFinite(t)) return iso;
  try {
    return svWall(new Date(t), tz ?? 'UTC').slice(0, 16);
  } catch {
    return iso;
  }
}

export async function loadWorldContext(
  db: Kysely<DB>,
  userId: string,
  opts?: { tz?: string | null; nowMs?: number },
): Promise<MagicsWorldContext> {
  const nowMs = opts?.nowMs ?? Date.now();
  const tz = opts?.tz ?? null;
  const fromMs = nowMs - CONTEXT_EVENT_PAST_MS;
  const untilMs = nowMs + CONTEXT_EVENT_FUTURE_MS;
  const today = todayInTz(tz);

  const [eventRows, taskRows, tripRows] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'title', 'starts_at', 'series_id'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .where('status', '!=', 'cancelled')
      .where(textInstant('events.starts_at', tz), '>=', new Date(fromMs - PAD_MS).toISOString())
      .where(textInstant('events.starts_at', tz), '<=', new Date(untilMs + PAD_MS).toISOString())
      .orderBy(textInstant('events.starts_at', tz), 'asc')
      .limit(CONTEXT_EVENT_CAP * OVERFETCH)
      .execute(),
    db
      .selectFrom('tasks')
      .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
      .select(['tasks.id as id', 'tasks.title as title', 'tasks.due_at as due_at'])
      .where('group_members.user_id', '=', userId)
      .where('tasks.status', 'in', ['open', 'active'])
      .where('tasks.archived_at', 'is', null)
      .orderBy(sql`${textInstant('tasks.due_at', tz)} asc nulls last`)
      .limit(CONTEXT_TASK_CAP * OVERFETCH)
      .execute(),
    // Trip dates are date-only strings, so lexical IS the real order here.
    db
      .selectFrom('trips')
      .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
      .select([
        'trips.name as name',
        'trips.destination as destination',
        'trips.start_date as start_date',
        'trips.end_date as end_date',
      ])
      .where('group_members.user_id', '=', userId)
      .where('trips.end_date', '>=', today)
      // ADR 0168 — a cancelled trip is not "already on the calendar" for the
      // world-context de-dup this snapshot exists to serve.
      .where('trips.cancelled_at', 'is', null)
      // ADR 0171 — nor is a trip in the bin.
      .where('trips.deleted_at', 'is', null)
      .orderBy('trips.start_date', 'asc')
      .limit(CONTEXT_TRIP_CAP)
      .execute(),
  ]);

  // The last day the slot walk lists ends at its own local midnight.
  const slotToday = dayStringAt(nowMs, tz);
  const lastDay = addDays(slotToday, AVAIL_WINDOW_DAYS - 1);
  const busy = await busyIntervalsInWindow(db, {
    userId,
    startIso: new Date(nowMs).toISOString(),
    endIso: zonedDayEndUtc(lastDay, tz).toISOString(),
  });

  // ADR 0245 — a time to suggest in a "reply with times" to-do is an
  // in-person time as far as anyone can tell, so a day a trip puts the user
  // elsewhere is not offered.
  const away = await userAwayDays(db, userId, {
    fromDay: slotToday,
    toDay: addDays(slotToday, AVAIL_WINDOW_DAYS),
  });

  return {
    // A truncated scan yields NO slots, never partial ones (see `openSlots`).
    openSlots: busy.truncated
      ? []
      : openSlotsFrom(busy.intervals, { nowMs, tz, skipDays: new Set(away.keys()) }),
    events: windowEvents(
      eventRows.map((r) => ({ id: r.id, seriesId: r.series_id, title: r.title, at: r.starts_at })),
      fromMs,
      untilMs,
      CONTEXT_EVENT_CAP,
      tz,
    ),
    tasks: sortTasks(taskRows.map((r) => ({ id: r.id, title: r.title, dueAt: r.due_at }))),
    pending: await loadPendingSuggestions(db, userId, nowMs),
    trips: tripRows.map((r) => ({
      name: r.name,
      destination: r.destination,
      startDate: r.start_date,
      endDate: r.end_date,
    })),
  };
}

function clip(value: string, max = CONTEXT_NAME_CHARS): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** ADR 0248 — pending email suggestions to add an event or a to-do. */
async function loadPendingSuggestions(
  db: Kysely<DB>,
  userId: string,
  nowMs: number,
): Promise<WorldPendingLine[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'provenance'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', 'in', ['create_event', 'create_task'])
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .where('expires_at', '>', new Date(nowMs).toISOString())
    .orderBy('created_at', 'desc')
    .limit(CONTEXT_PENDING_CAP * 2)
    .execute();
  const out: WorldPendingLine[] = [];
  for (const r of rows) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(r.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof args.title !== 'string' || !args.title.trim()) continue;
    // An invite's card answers by UID (ADR 0074/0104), never by this path.
    if (args.externalUid) continue;
    const tool = r.tool_name as WorldPendingLine['tool'];
    const at = tool === 'create_event' ? args.startsAt : args.dueAt;
    out.push({
      id: r.id,
      tool,
      title: args.title,
      at: typeof at === 'string' ? at : null,
      args,
      provenance: r.provenance,
    });
    if (out.length >= CONTEXT_PENDING_CAP) break;
  }
  return out;
}

function domainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  if (!email || at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

/**
 * ADR 0248 — events the batch list may have missed for ONE email: the
 * user's events on any day the email names, and upcoming events that came
 * from an email by the same sender domain. Bounded; ids already listed are
 * left out.
 */
export async function loadThreadEvents(
  db: Kysely<DB>,
  userId: string,
  opts: {
    text: string;
    fromEmail: string | null;
    tz: string | null;
    exclude: Set<string>;
    nowMs?: number;
  },
): Promise<WorldEventLine[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const tz = opts.tz;
  const days = mentionedDays(opts.text, dayStringAt(nowMs, tz))
    .filter((d) => d >= dayStringAt(nowMs - 86400000, tz))
    .slice(0, 5);
  const out: WorldEventLine[] = [];
  const seen = new Set(opts.exclude);
  const add = (r: { id: string; title: string; starts_at: string; series_id: string | null }) => {
    if (seen.has(r.id) || out.length >= CONTEXT_EXTRA_EVENT_CAP) return;
    seen.add(r.id);
    out.push({ id: r.id, seriesId: r.series_id, title: r.title, at: r.starts_at });
  };
  const base = () =>
    db
      .selectFrom('events')
      .select(['events.id as id', 'events.title as title', 'events.starts_at as starts_at', 'events.series_id as series_id'])
      .where('events.owner_user_id', '=', userId)
      .where('events.deleted_at', 'is', null)
      .where('events.status', '!=', 'cancelled');

  for (const day of days) {
    const loMs = zonedDayStartUtc(day, tz).getTime();
    const lo = new Date(loMs).toISOString();
    const hi = zonedDayEndUtc(day, tz).toISOString();
    const rows = await base()
      .where(textInstant('events.starts_at', tz), '>=', lo)
      .where(textInstant('events.starts_at', tz), '<', hi)
      .orderBy(textInstant('events.starts_at', tz), 'asc')
      .limit(CONTEXT_EXTRA_EVENT_CAP)
      .execute();
    rows.forEach(add);
  }

  const domain = domainOf(opts.fromEmail);
  if (domain && out.length < CONTEXT_EXTRA_EVENT_CAP) {
    const rows = await base()
      .innerJoin('email_threads', (j) =>
        j
          .on('email_threads.user_id', '=', userId)
          .on(sql<boolean>`events.source_raw_context = 'gmail:' || email_threads.gmail_thread_id`),
      )
      .where(sql<boolean>`lower(email_threads.from_email) like ${'%@' + domain}`)
      // From the start of the user's day: today's all-day event and one already
      // under way are what a "today's ... is cancelled" email is about.
      .where(
        textInstant('events.starts_at', tz),
        '>=',
        zonedDayStartUtc(dayStringAt(nowMs, tz), tz).toISOString(),
      )
      .orderBy(textInstant('events.starts_at', tz), 'asc')
      .limit(CONTEXT_EXTRA_EVENT_CAP)
      .execute();
    rows.forEach(add);
  }
  return out;
}

/** A labelled item the extractor may name in a `change`. */
export type ChangeTarget =
  | { kind: 'event'; id: string; seriesId: string | null; title: string; at: string }
  | { kind: 'task'; id: string; title: string; dueAt: string | null }
  | {
      kind: 'pending';
      id: string;
      tool: 'create_event' | 'create_task';
      title: string;
      at: string | null;
      args: Record<string, unknown>;
    };

export interface LabelledWorld {
  block: string | null;
  /** Only labels whose line made it into `block`. */
  targets: Map<string, ChangeTarget>;
}

/**
 * Prompt block plus the labels it shows. Lines loaded from the database get
 * a label (`e1` calendar, `t1` to-do, `p1` suggestion) the model can point
 * at; the label maps back to the row here, so no id reaches the prompt.
 * `extraEvents` (per email) continue the event numbering; `excludeProvenance`
 * hides this email's own pending suggestions.
 */
export function formatLabelledWorld(
  ctx: MagicsWorldContext,
  tz: string | null,
  opts: { extraEvents?: WorldEventLine[]; excludeProvenance?: string } = {},
): LabelledWorld {
  const lines: Array<{ text: string; label?: string; target?: ChangeTarget }> = [];
  let e = 0;
  let t = 0;
  let p = 0;
  const events = [...ctx.events, ...(opts.extraEvents ?? [])];
  for (const ev of events) {
    const tail = `calendar: ${clip(ev.title)} - ${whenInTz(ev.at, tz)}`;
    if (ev.id) {
      const label = `e${++e}`;
      lines.push({
        text: `- ${label} ${tail}`,
        label,
        target: { kind: 'event', id: ev.id, seriesId: ev.seriesId ?? null, title: ev.title, at: ev.at },
      });
    } else {
      lines.push({ text: `- ${tail}` });
    }
  }
  for (const tk of ctx.tasks) {
    const due = tk.dueAt ? ` - due ${whenInTz(tk.dueAt, tz)}` : '';
    const tail = `to-do: ${clip(tk.title)}${due}`;
    if (tk.id) {
      const label = `t${++t}`;
      lines.push({
        text: `- ${label} ${tail}`,
        label,
        target: { kind: 'task', id: tk.id, title: tk.title, dueAt: tk.dueAt },
      });
    } else {
      lines.push({ text: `- ${tail}` });
    }
  }
  for (const pd of ctx.pending ?? []) {
    if (opts.excludeProvenance && pd.provenance === opts.excludeProvenance) continue;
    const label = `p${++p}`;
    const noun = pd.tool === 'create_event' ? 'event' : 'to-do';
    const when = pd.at ? ` - ${pd.tool === 'create_task' ? 'due ' : ''}${whenInTz(pd.at, tz)}` : '';
    lines.push({
      text: `- ${label} suggested ${noun} (not yet accepted): ${clip(pd.title)}${when}`,
      label,
      target: { kind: 'pending', id: pd.id, tool: pd.tool, title: pd.title, at: pd.at, args: pd.args },
    });
  }
  for (const tr of ctx.trips) {
    lines.push({
      text: `- trip: ${clip(tr.name)} (${clip(tr.destination)}) ${tr.startDate}..${tr.endDate}`,
    });
  }
  const slotLine =
    ctx.openSlots.length > 0
      ? `Times the user appears FREE (their zone, ${AVAIL_DAY_START_HOUR}:00-${AVAIL_DAY_END_HOUR}:00): ` +
        ctx.openSlots.map((s) => whenInTz(new Date(s.startMs).toISOString(), tz)).join(', ')
      : null;

  const targets = new Map<string, ChangeTarget>();
  if (lines.length === 0) return { block: slotLine, targets };

  // Events are soonest-first and carry the twin-suppression weight, so a
  // pathological world loses its tail rather than growing the prompt.
  const header = "Already on the user's calendar / to-dos / trips (names and dates only):";
  const kept: string[] = [];
  let total = header.length;
  for (const line of lines) {
    total += line.text.length + 1;
    if (total > CONTEXT_BLOCK_CHARS) break;
    kept.push(line.text);
    if (line.label && line.target) targets.set(line.label, line.target);
  }
  if (kept.length === 0) return { block: slotLine, targets };
  return { block: [header, ...kept, ...(slotLine ? [slotLine] : [])].join('\n'), targets };
}
