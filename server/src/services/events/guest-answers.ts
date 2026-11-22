/**
 * ADR 0328 — who is coming, as the guests answered.
 *
 * Kept on the ORGANIZER's row (`events.guest_answers`), not on each member's:
 * a member who declines in Google has their own row removed (Chord does not
 * show a meeting someone said no to), and that "no" is exactly what the
 * organizer needs to see. Three writers, all reporting what a calendar or a
 * reply actually said:
 *
 * - the organizer's calendar sync, from the provider event's `attendees`;
 * - the guest change itself, so a just-invited guest shows at once;
 * - a mailed iTIP reply, for an organizer whose invitations went by mail.
 */
import { sql, type Kysely, type Selectable } from 'kysely';

import type { GuestAnswer, GuestResponse } from '@chord/kernel';
import type { DB, EventsTable } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';

type Stored = { email: string; response: GuestResponse };

const RESPONSES: ReadonlySet<string> = new Set(['accepted', 'tentative', 'declined', 'needsAction']);

/** iTIP PARTSTAT (RFC 5545 §3.2.12) in the calendar's words. */
export function responseFromPartstat(partstat: string): GuestResponse | null {
  switch (partstat.toUpperCase()) {
    case 'ACCEPTED':
      return 'accepted';
    case 'TENTATIVE':
      return 'tentative';
    case 'DECLINED':
      return 'declined';
    case 'NEEDS-ACTION':
      return 'needsAction';
    default:
      return null;
  }
}

function parse(json: string | null | undefined): Stored[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is Stored =>
        !!x && typeof x.email === 'string' && typeof x.response === 'string' && RESPONSES.has(x.response),
    );
  } catch {
    return [];
  }
}

/**
 * Replace the organizer row's list with what the calendar holds. The
 * organizer's own entry is not a guest.
 */
export async function recordGuestAnswers(
  db: Kysely<DB>,
  organizerRowId: string,
  attendees: ReadonlyArray<{ email?: string; responseStatus?: string; self?: boolean; organizer?: boolean }>,
): Promise<void> {
  const list: Stored[] = [];
  const seen = new Set<string>();
  for (const a of attendees) {
    const email = a.email?.trim().toLowerCase();
    if (!email || a.self || a.organizer || seen.has(email)) continue;
    seen.add(email);
    const response = a.responseStatus && RESPONSES.has(a.responseStatus) ? (a.responseStatus as GuestResponse) : 'needsAction';
    list.push({ email, response });
  }
  await db
    .updateTable('events')
    .set({ guest_answers: list.length > 0 ? JSON.stringify(list) : null })
    .where('id', '=', organizerRowId)
    .execute();
}

/**
 * One guest's answer from a mailed reply, on the event `organizerId`
 * organizes under that UID. Returns false when no such event is theirs, so
 * the caller can treat the mail as something else.
 */
export async function setGuestAnswer(
  db: Kysely<DB>,
  args: { organizerId: string; icalUid: string; email: string; response: GuestResponse },
): Promise<boolean> {
  const row = await db
    .selectFrom('events')
    .select(['id', 'guest_answers'])
    .where('owner_user_id', '=', args.organizerId)
    .where('role', '=', 'organizer')
    .where('ical_uid', '=', args.icalUid)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) return false;
  const email = args.email.trim().toLowerCase();
  const list = parse(row.guest_answers).filter((a) => a.email !== email);
  list.push({ email, response: args.response });
  await db.updateTable('events').set({ guest_answers: JSON.stringify(list) }).where('id', '=', row.id).execute();
  return true;
}

/** The row that carries the answers: the organizer's own copy of this event. */
async function organizerRowOf(db: Kysely<DB>, eventId: string): Promise<Selectable<EventsTable> | undefined> {
  const row = await db.selectFrom('events').selectAll().where('id', '=', eventId).executeTakeFirst();
  if (!row) return undefined;
  if (!row.organizer_user_id || row.organizer_user_id === row.owner_user_id || !row.ical_uid) return row;
  return db
    .selectFrom('events')
    .selectAll()
    .where('ical_uid', '=', row.ical_uid)
    .where('owner_user_id', '=', row.organizer_user_id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/**
 * The answers for an event, read from whichever copy is asked about, with a
 * name for each address Chord knows: a member invited at it, a Chord account
 * signed in with it, or a person `viewerId` saved with it.
 */
export async function eventGuestAnswers(
  db: Kysely<DB>,
  eventId: string,
  viewerId: string,
): Promise<GuestAnswer[]> {
  const org = await organizerRowOf(db, eventId);
  const stored = parse(org?.guest_answers);
  if (!org || stored.length === 0) return [];
  const emails = stored.map((s) => s.email);
  const names = new Map<string, string>();

  if (org.ical_uid) {
    const invited = await db
      .selectFrom('events')
      .innerJoin('users', 'users.id', 'events.owner_user_id')
      .select(['events.invite_email', 'users.display_name'])
      .where('events.ical_uid', '=', org.ical_uid)
      .where('events.invite_email', 'in', emails)
      .execute();
    for (const r of invited) if (r.invite_email && r.display_name) names.set(r.invite_email, r.display_name);
  }
  const users = await db
    .selectFrom('users')
    .select(['email', 'display_name'])
    .where('email', 'in', emails)
    .where('shadow', '=', 0)
    .execute();
  for (const u of users) {
    const e = u.email?.toLowerCase();
    if (e && u.display_name && !names.has(e)) names.set(e, u.display_name);
  }
  const people = await db
    .selectFrom('people')
    .select(['email', 'display_name'])
    .where('owner_user_id', '=', viewerId)
    .where('email', 'in', emails)
    .execute();
  for (const p of people) {
    const e = p.email?.toLowerCase();
    if (e && p.display_name && !names.has(e)) names.set(e, p.display_name);
  }
  return stored.map((s) => ({ email: s.email, name: names.get(s.email) ?? null, response: s.response }));
}

export interface WaitingInvitation {
  /** The user's own row for the event. */
  id: string;
  groupId: string;
  title: string;
  startsAt: string;
  response: GuestResponse;
}

/**
 * The invitations to family members' group events `userId` has, from now on
 * (an event under way still counts), soonest first, with their answer so far.
 */
export async function waitingInvitations(db: Kysely<DB>, userId: string, limit = 20): Promise<WaitingInvitation[]> {
  const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const rows = await db
    .selectFrom('events')
    .select(['id', 'group_id', 'title', 'starts_at', 'invite_email'])
    .where('owner_user_id', '=', userId)
    .where('invite_email', 'is not', null)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`${textInstant('starts_at')} >= ${since}::timestamptz`)
    .orderBy(sql`${textInstant('starts_at')}`)
    .limit(limit)
    .execute();
  const out: WaitingInvitation[] = [];
  for (const r of rows) {
    const answers = await eventGuestAnswers(db, r.id, userId);
    const mine = answers.find((a) => a.email === r.invite_email!.toLowerCase());
    out.push({ id: r.id, groupId: r.group_id, title: r.title, startsAt: r.starts_at, response: mine?.response ?? 'needsAction' });
  }
  return out;
}

/** Of these event ids, the ones whose event has recorded answers (on the id's
 *  own row or the organizer's copy sharing its key). */
export async function eventsWithGuestAnswers(db: Kysely<DB>, eventIds: string[]): Promise<string[]> {
  if (eventIds.length === 0) return [];
  const rows = await db
    .selectFrom('events as e')
    .innerJoin('events as o', 'o.ical_uid', 'e.ical_uid')
    .select('e.id')
    .where('e.id', 'in', eventIds)
    .where('o.guest_answers', 'is not', null)
    .where('o.deleted_at', 'is', null)
    .distinct()
    .execute();
  return rows.map((r) => r.id);
}

/** "Priya: yes, Kevin: no, Ben: not answered" for the bot's context. */
export function describeAnswers(answers: GuestAnswer[]): string {
  const word: Record<GuestResponse, string> = {
    accepted: 'yes',
    tentative: 'maybe',
    declined: 'no',
    needsAction: 'not answered',
  };
  return answers.map((a) => `${a.name ?? a.email}: ${word[a.response]}`).join(', ');
}
