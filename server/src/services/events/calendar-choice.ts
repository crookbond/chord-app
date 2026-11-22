/**
 * Which calendar a chat-made event goes on, decided by evidence in one order
 * rather than by phrasing (prod 2026-11-17: "From Rudderstack calendar - send
 * a calendar invite ... to arthur@optizent.com" went on the Outlook default).
 *
 *   1. a calendar the model passed by name;
 *   2. a calendar the user's own recent words name - every way of saying it
 *      is tried against the closed list of their calendars;
 *   3. the mailbox the user writes to these guests from, else the calendar
 *      their earlier meetings are on: a meeting with
 *      someone you email from your work address goes on that address's
 *      calendar (the same rule an email card follows, ADR 0312);
 *   4. a kind of call the user asked for that only one of their mailboxes
 *      can host (a Google Meet needs a Google calendar);
 *   5. with guests and more than one mailbox calendar left, ask - the guests
 *      see which address the invitation comes from;
 *   6. otherwise the user's default.
 *
 * Nothing is remembered: each event is decided from its own conversation.
 */
import type { Kysely } from 'kysely';

import { videoCallDefaultFor, type VideoCallKind } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { calendarNamesSaidIn } from '../../utils/calendar-mention.js';
import {
  calendarLabel,
  matchCalendarsByName,
  resolveTargetCalendarId,
  type CalendarPick,
} from '../calendar-sources.service.js';
import { mailboxCalendar, type SourceMailbox } from '../email/source-mailbox.js';
import { hasCalendarWriteScope } from '../google/calendar-write.service.js';

/** How far back the user's mail with the guests is looked at. */
const PEOPLE_MAIL_DAYS = 180;

export type CalendarChoiceWhy = 'requested' | 'named' | 'people' | 'call' | 'default';

export interface CalendarChoice extends CalendarPick {
  why: CalendarChoiceWhy;
  /** Set when the user must be asked: one entry per mailbox calendar. */
  ask?: { calendarId: string; label: string }[];
}

export interface CalendarChoiceInput {
  userId: string;
  /** What the model put in `calendar`, if anything. */
  requestedName?: string | null;
  /** The user's own recent messages, newest first. */
  said: readonly string[];
  /** Guest addresses (names are not used here). */
  invitees: readonly string[];
  /** A kind of call the user named ("google meet", "teams"), if any. */
  callKind?: VideoCallKind | null;
}

/** Each mailbox's own calendar: the Google primary and every attached mailbox that writes one. */
async function mailboxCalendars(
  db: Kysely<DB>,
  userId: string,
): Promise<{ mailbox: SourceMailbox; calendarId: string }[]> {
  const out: { mailbox: SourceMailbox; calendarId: string }[] = [];
  if (await hasCalendarWriteScope(db, userId)) {
    const c = await mailboxCalendar(db, userId, { kind: 'primary' });
    if (c.kind === 'auto') out.push({ mailbox: { kind: 'primary' }, calendarId: c.calendarId });
  }
  const accounts = await db
    .selectFrom('email_accounts')
    .select(['id', 'provider'])
    .where('user_id', '=', userId)
    .where('status', '=', 'ok')
    .where('calendar_enabled', '=', 1)
    .orderBy('created_at')
    .execute();
  for (const a of accounts) {
    if (a.provider !== 'gmail' && a.provider !== 'outlook') continue;
    const mailbox: SourceMailbox = { kind: 'account', accountId: a.id, provider: a.provider };
    const c = await mailboxCalendar(db, userId, mailbox);
    if (c.kind === 'auto' && !out.some((o) => o.calendarId === c.calendarId)) out.push({ mailbox, calendarId: c.calendarId });
  }
  return out;
}

/** The mailboxes the user has mail with any of these people in. */
async function mailboxesWith(db: Kysely<DB>, userId: string, people: readonly string[]): Promise<Set<string>> {
  const emails = [...new Set(people.map((p) => p.trim().toLowerCase()).filter((p) => p.includes('@')))];
  const found = new Set<string>();
  if (emails.length === 0) return found;
  const since = new Date(Date.now() - PEOPLE_MAIL_DAYS * 86_400_000).toISOString();
  const rows = await db
    .selectFrom('email_messages as m')
    .innerJoin('email_threads as t', 't.id', 'm.thread_id')
    .select('t.account_id')
    .distinct()
    .where('m.user_id', '=', userId)
    .where('m.internal_date', '>=', since)
    .where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['m.from_email']), 'in', emails),
        ...emails.flatMap((e) => [
          eb(eb.cast('m.to_emails', 'text'), 'ilike', `%"${e}"%`),
          eb(eb.cast('m.cc_emails', 'text'), 'ilike', `%"${e}"%`),
        ]),
      ]),
    )
    .execute();
  for (const r of rows) found.add(r.account_id ?? 'primary');
  return found;
}

/** The calendars the user's earlier meetings with any of these people are on. */
async function calendarsMetOn(db: Kysely<DB>, userId: string, people: readonly string[]): Promise<Set<string>> {
  const emails = [...new Set(people.map((p) => p.trim().toLowerCase()).filter((p) => p.includes('@')))];
  const found = new Set<string>();
  if (emails.length === 0) return found;
  const since = new Date(Date.now() - PEOPLE_MAIL_DAYS * 86_400_000).toISOString();
  const rows = await db
    .selectFrom('events')
    .select('google_calendar_id')
    .distinct()
    .where('owner_user_id', '=', userId)
    .where('google_calendar_id', 'is not', null)
    .where('created_at', '>=', since)
    .where((eb) => eb.or(emails.map((e) => eb(eb.cast('guest_emails', 'text'), 'ilike', `%"${e}"%`))))
    .execute();
  for (const r of rows) if (r.google_calendar_id) found.add(r.google_calendar_id);
  return found;
}

const keyOf = (m: SourceMailbox): string => (m.kind === 'primary' ? 'primary' : m.accountId);

function callKindOf(calendarId: string): VideoCallKind | null {
  const provider = calendarId.startsWith('outlook:') ? 'outlook' : 'google';
  return videoCallDefaultFor({ calendarId, provider });
}

export async function chooseEventCalendar(db: Kysely<DB>, input: CalendarChoiceInput): Promise<CalendarChoice> {
  const { userId } = input;
  if (input.requestedName) {
    return { ...(await resolveTargetCalendarId(db, { userId, requestedName: input.requestedName })), why: 'requested' };
  }
  for (const text of input.said) {
    for (const name of calendarNamesSaidIn(text)) {
      const match = await matchCalendarsByName(db, userId, name);
      if (match.calendarId) {
        return { ...(await resolveTargetCalendarId(db, { userId, requestedName: name })), why: 'named' };
      }
    }
  }

  const fallback = await resolveTargetCalendarId(db, { userId });
  const guests = input.invitees.filter((p) => p.includes('@'));
  if (guests.length === 0 && !input.callKind) return { ...fallback, why: 'default' };

  const all = await mailboxCalendars(db, userId);
  if (all.length < 2) return { ...fallback, why: 'default' };
  let left = all;
  let why: CalendarChoiceWhy = 'default';
  if (guests.length > 0) {
    const withThem = await mailboxesWith(db, userId, guests);
    let theirs = all.filter((c) => withThem.has(keyOf(c.mailbox)));
    // No mail with them, or mail in several mailboxes: the calendar the
    // earlier meetings with them are on.
    if (theirs.length !== 1) {
      const met = await calendarsMetOn(db, userId, guests);
      const onCalendar = (theirs.length > 0 ? theirs : all).filter((c) => met.has(c.calendarId));
      if (onCalendar.length > 0) theirs = onCalendar;
    }
    if (theirs.length > 0) {
      left = theirs;
      why = 'people';
    }
  }
  if (input.callKind) {
    const fits = left.filter((c) => callKindOf(c.calendarId) === input.callKind);
    if (fits.length > 0 && fits.length < left.length) {
      left = fits;
      why = why === 'people' ? 'people' : 'call';
    }
  }
  if (left.length === 1) return { calendarId: left[0]!.calendarId, source: 'requested', why };
  if (guests.length === 0) return { ...fallback, why: 'default' };
  const ask = await Promise.all(
    left.map(async (c) => ({ calendarId: c.calendarId, label: await calendarLabel(db, userId, c.calendarId) })),
  );
  return { ...fallback, why: 'default', ask };
}
