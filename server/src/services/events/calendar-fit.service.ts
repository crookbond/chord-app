/**
 * ADR 0346 - how a pending email event sits on the user's calendar.
 *
 * Read across every calendar the user has (a work meeting can clash with a
 * family event), using the same busy rule as `find_conflicts` and the reply
 * drafter (`busyEventsInWindow`). Each busy event is compared with the
 * meeting by `meetingRelation`: only different people at the same time is a
 * conflict. Shown to the user only; nothing here writes anything except the
 * user's own answers to the questions it asks.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import {
  meetingRelation,
  workDayOf,
  formatClock,
  type CalendarSide,
  type FitEvent,
  type FitQuestion,
  type MeetingSide,
  type OverlapAnswer,
  type ProposalCalendarFit,
} from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { busyEventsInWindow, type BusyEvent } from '../conflicts.service.js';
import { ownAddresses } from '../email/sender-stats.service.js';
import { meetingAssistants, meetingThreadsForInvites } from '../email/meetings.service.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { getWorkHours } from '../work-hours.service.js';
import { activeHolds } from './holds.service.js';
import { DEFAULT_EVENT_DURATION_MS } from '../google/two-way-sync.js';
import { instantInZoneMs, svWall } from '../../utils/tz.js';

/**
 * The user's answers, so a question is asked once. `pair:<meetingKey>|<eventId>`
 * holds same / different; `block:<seriesId or eventId>` holds movable / fixed.
 */
export const overlapAnswers = defineUserDefault(
  'meeting_overlap_answers',
  z.record(z.enum(['same', 'different', 'movable', 'fixed'])),
);

const MAX_ANSWERS = 500;

export interface FitCandidate {
  id: string;
  tool_name: string;
  args_json: string;
  provenance: string | null;
  status?: string;
}

interface Wanted {
  id: string;
  meeting: MeetingSide;
  key: string;
  /** Someone else's invitation (ADR 0104). */
  invite: boolean;
}

function parseArgs(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** What identifies a meeting across reads: its invite UID, else the proposal. */
export function meetingKeyOf(args: Record<string, unknown>, proposalId: string): string {
  return typeof args.externalUid === 'string' && args.externalUid ? `uid:${args.externalUid}` : `p:${proposalId}`;
}

const blockKey = (row: BusyEvent['row']): string => `block:${row.series_id ?? row.id}`;
const pairKey = (meetingKey: string, eventId: string): string => `pair:${meetingKey}|${eventId}`;

/** Everyone on each email thread, by `gmail:<id>` key. */
async function threadPeople(db: Kysely<DB>, userId: string, keys: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(keys.filter((k) => k.startsWith('gmail:')).map((k) => k.slice('gmail:'.length)))];
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom('email_messages')
    .select(['gmail_thread_id', 'from_email', 'to_emails', 'cc_emails'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', 'in', ids)
    .execute();
  for (const r of rows) {
    const key = `gmail:${r.gmail_thread_id}`;
    const list = out.get(key) ?? [];
    if (r.from_email) list.push(r.from_email);
    list.push(...(r.to_emails ?? []), ...(r.cc_emails ?? []));
    out.set(key, list);
  }
  return out;
}

function fitEvent(b: BusyEvent): FitEvent {
  return { eventId: b.row.id, title: b.row.title, startsAt: b.row.starts_at, endsAt: b.row.ends_at };
}

function outsideWorkHours(
  startMs: number,
  endMs: number,
  tz: string,
  hours: Awaited<ReturnType<typeof getWorkHours>>['hours'],
): string | undefined {
  const wall = svWall(new Date(startMs), tz);
  const day = wall.slice(0, 10);
  const wd = workDayOf(day, tz, hours);
  if (!wd.work) return wd.reason.replace(/^holiday: /, '');
  const startMin = Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
  const endMin = startMin + Math.round((endMs - startMs) / 60_000);
  if (startMin < wd.startMinutes) return `before ${formatClock(wd.startMinutes)}`;
  if (endMin > wd.endMinutes) return `after ${formatClock(wd.endMinutes)}`;
  return undefined;
}

/**
 * The calendar verdict for each pending email `create_event`, keyed by
 * proposal id. Invitations and plain email events alike; never a repeat.
 */
export async function calendarFitFor(
  db: Kysely<DB>,
  userId: string,
  proposals: FitCandidate[],
): Promise<Map<string, ProposalCalendarFit>> {
  const out = new Map<string, ProposalCalendarFit>();
  const user = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  const tz = user?.last_tz ?? null;

  const raw: Array<{ id: string; args: Record<string, unknown>; provenance: string }> = [];
  for (const p of proposals) {
    if (p.tool_name !== 'create_event' || (p.status && p.status !== 'pending')) continue;
    if (!p.provenance?.startsWith('gmail:')) continue;
    const args = parseArgs(p.args_json);
    if (!args || args.repeat || args.allDay === true) continue;
    if (typeof args.startsAt !== 'string') continue;
    raw.push({ id: p.id, args, provenance: p.provenance });
  }
  if (raw.length === 0) return out;

  const [people, self, answers, hours, meetingThreads, notCore] = await Promise.all([
    threadPeople(db, userId, raw.map((r) => r.provenance)),
    ownAddresses(db, userId),
    overlapAnswers.get(db, userId),
    getWorkHours(db, userId),
    // ADR 0346 phase 3 - an invitation linked to the meeting agreed in
    // another thread is that meeting.
    meetingThreadsForInvites(
      db,
      userId,
      raw.map((r) => (typeof r.args.externalUid === 'string' ? r.args.externalUid : '')),
    ),
    // Assistants the user's meetings have met are never who a meeting is
    // with: Ana on both events does not make them the same meeting.
    meetingAssistants(db, userId),
  ]);
  const wanted: Wanted[] = [];
  for (const r of raw) {
    const startMs = instantInZoneMs(r.args.startsAt as string, tz);
    if (!Number.isFinite(startMs)) continue;
    const endRaw = typeof r.args.endsAt === 'string' ? instantInZoneMs(r.args.endsAt, tz) : NaN;
    const endMs = Number.isFinite(endRaw) && endRaw > startMs ? endRaw : startMs + DEFAULT_EVENT_DURATION_MS;
    const organizer = typeof r.args.organizerEmail === 'string' ? [r.args.organizerEmail] : [];
    wanted.push({
      id: r.id,
      key: meetingKeyOf(r.args, r.id),
      invite: r.args.alreadyInGoogle === true,
      meeting: {
        startMs,
        endMs,
        title: typeof r.args.title === 'string' ? r.args.title : '',
        people: [...strings(r.args.invitees), ...organizer, ...(people.get(r.provenance) ?? [])],
        uids: [typeof r.args.externalUid === 'string' ? r.args.externalUid : null],
        threadKey: r.provenance,
        relatedThreadKeys:
          typeof r.args.externalUid === 'string' && meetingThreads.get(r.args.externalUid.toLowerCase())
            ? [meetingThreads.get(r.args.externalUid.toLowerCase())!]
            : [],
      },
    });
  }
  if (wanted.length === 0) return out;

  const lo = Math.min(...wanted.map((w) => w.meeting.startMs));
  const hi = Math.max(...wanted.map((w) => w.meeting.endMs));
  const { events, truncated } = await busyEventsInWindow(db, {
    userId,
    startIso: new Date(lo).toISOString(),
    endIso: new Date(hi).toISOString(),
  });
  if (truncated) return out;
  const [eventPeople, holds] = await Promise.all([
    threadPeople(
      db,
      userId,
      events.map((e) => e.row.source_raw_context ?? '').filter(Boolean),
    ),
    activeHolds(db, userId, { fromMs: lo, toMs: hi }),
  ]);

  for (const w of wanted) {
    const fit: ProposalCalendarFit = { verdict: 'free', conflicts: [], related: [], questions: [] };
    const ownUid = w.invite ? (w.meeting.uids?.[0] ?? null)?.toLowerCase() : null;
    for (const b of events) {
      // Outlook puts an unanswered invitation on the calendar: that row is
      // the invitation itself, neither "already there" nor its own conflict.
      if (ownUid && [b.row.invite_uid, b.row.ical_uid, b.row.external_uid].some((u) => u?.toLowerCase() === ownUid)) {
        continue;
      }
      const side: CalendarSide = {
        id: b.row.id,
        startMs: b.startMs,
        endMs: b.endMs,
        title: b.row.title,
        people: [...(b.row.guest_emails ?? []), ...(eventPeople.get(b.row.source_raw_context ?? '') ?? [])],
        uids: [b.row.invite_uid, b.row.ical_uid, b.row.external_uid],
        threadKey: b.row.source_raw_context?.startsWith('gmail:') ? b.row.source_raw_context : null,
      };
      let rel = meetingRelation(w.meeting, side, { self, notCore });
      const said: OverlapAnswer | undefined =
        answers?.[pairKey(w.key, b.row.id)] ?? answers?.[blockKey(b.row)];
      if (rel === 'unsure' && said) rel = said === 'same' ? 'same' : 'conflict';
      if (rel === 'personal_block' && said) rel = said === 'movable' ? 'none' : 'conflict';
      if (rel === 'same') {
        fit.already ??= fitEvent(b);
      } else if (rel === 'related') fit.related.push(fitEvent(b));
      else if (rel === 'conflict') fit.conflicts.push(fitEvent(b));
      else if (rel === 'unsure') fit.questions.push({ ...fitEvent(b), ask: 'same' } satisfies FitQuestion);
      else if (rel === 'personal_block') fit.questions.push({ ...fitEvent(b), ask: 'movable' } satisfies FitQuestion);
    }
    // ADR 0346 phase 4 - a slot held for another meeting's invitation: a
    // soft conflict, shown and still bookable. The hold for THIS meeting
    // (its invitation arriving) is not a conflict with itself.
    for (const h of holds) {
      const side: CalendarSide = {
        id: `hold:${h.meetingId}`,
        startMs: Date.parse(h.startsAt),
        endMs: Date.parse(h.endsAt),
        title: h.title,
        people: h.people,
        threadKey: h.threadKey,
      };
      const rel = meetingRelation(w.meeting, side, { self, notCore });
      if (rel === 'none' || rel === 'same' || rel === 'related') continue;
      (fit.held ??= []).push({ eventId: side.id, title: h.title, startsAt: h.startsAt, endsAt: h.endsAt });
    }
    fit.verdict = fit.already
      ? 'already'
      : fit.conflicts.length > 0
        ? 'conflict'
        : fit.questions.length > 0
          ? 'ask'
          : 'free';
    if (tz) {
      const note = outsideWorkHours(w.meeting.startMs, w.meeting.endMs, tz, hours.hours);
      if (note) fit.outsideWorkHours = note;
    }
    out.set(w.id, fit);
  }
  return out;
}

/**
 * ADR 0348 - the meeting an email card would add is already on the user's
 * calendar (ADR 0346's rule: the same people and time, assistants left out),
 * usually because someone on the thread sent the invitation. Only meeting
 * cards: an invitation's own Yes/Maybe/No card answers that invitation.
 */
export async function meetingAlreadyOnCalendar(
  db: Kysely<DB>,
  userId: string,
  card: { args: Record<string, unknown>; provenance: string | null },
): Promise<FitEvent | null> {
  const invitees = Array.isArray(card.args.invitees) ? card.args.invitees : [];
  if (invitees.length === 0 || card.args.alreadyInGoogle === true || card.args.externalUid) return null;
  if (!card.provenance?.startsWith('gmail:')) return null;
  const id = '__card';
  const fit = await calendarFitFor(db, userId, [
    { id, tool_name: 'create_event', args_json: JSON.stringify(card.args), provenance: card.provenance, status: 'pending' },
  ]);
  return fit.get(id)?.already ?? null;
}

export type RecordOverlapResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_asked' | 'wrong_answer' };

/**
 * Remember the user's answer to one of the card's questions. Checked against
 * the questions the card actually asks now, so an answer cannot be stored
 * for an event the meeting never overlapped.
 */
export async function recordOverlapAnswer(
  db: Kysely<DB>,
  userId: string,
  proposalId: string,
  eventId: string,
  answer: OverlapAnswer,
): Promise<RecordOverlapResult> {
  const p = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'provenance', 'status'])
    .where('id', '=', proposalId)
    .where('proposed_by_user_id', '=', userId)
    .executeTakeFirst();
  if (!p) return { ok: false, reason: 'not_found' };
  const fit = (await calendarFitFor(db, userId, [p])).get(p.id);
  const q = fit?.questions.find((x) => x.eventId === eventId);
  if (!q) return { ok: false, reason: 'not_asked' };
  if (q.ask === 'same' ? answer !== 'same' && answer !== 'different' : answer !== 'movable' && answer !== 'fixed') {
    return { ok: false, reason: 'wrong_answer' };
  }
  const args = parseArgs(p.args_json) ?? {};
  let key = pairKey(meetingKeyOf(args, p.id), eventId);
  if (q.ask === 'movable') {
    const row = await db.selectFrom('events').select(['id', 'series_id']).where('id', '=', eventId).executeTakeFirst();
    key = `block:${row?.series_id ?? eventId}`;
  }
  await overlapAnswers.update(db, userId, (cur) => {
    const next = { ...(cur ?? {}), [key]: answer };
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ANSWERS))) delete next[k];
    return { value: next, result: undefined };
  });
  return { ok: true };
}

export interface OpenOverlapQuestion {
  proposalId: string;
  meetingTitle: string;
  eventId: string;
  eventTitle: string;
  ask: FitQuestion['ask'];
}

/** Every question the user's pending email event cards are asking now. */
export async function openOverlapQuestions(db: Kysely<DB>, userId: string): Promise<OpenOverlapQuestion[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'provenance', 'status'])
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('tool_name', '=', 'create_event')
    .where('expires_at', '>', new Date().toISOString())
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const fits = await calendarFitFor(db, userId, rows);
  const out: OpenOverlapQuestion[] = [];
  for (const r of rows) {
    const title = String(parseArgs(r.args_json)?.title ?? '');
    for (const q of fits.get(r.id)?.questions ?? []) {
      out.push({ proposalId: r.id, meetingTitle: title, eventId: q.eventId, eventTitle: q.title, ask: q.ask });
    }
  }
  return out;
}
