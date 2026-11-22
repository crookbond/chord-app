/**
 * ADR 0346 phase 3 - one meeting followed across its scheduling thread.
 *
 * Each scheduling block (phase 2) moves the record: times offered, the user
 * proposing back, a time agreed, the invitation arriving, a cancellation.
 * The user's own sent reply is read too, for the scheduling block only (never
 * for cards): that is how "Tuesday 10 works for me" becomes `agreed`.
 *
 * Nothing here sends, creates or removes anything on a calendar.
 */
import { sql, type Kysely, type Selectable } from 'kysely';

import {
  commonTimes,
  personSpans,
  nextMeetingState,
  slotIsTimed,
  type MeetingFacts,
  type MeetingState,
  type SchedulingFacts,
  type SlotFact,
} from '@chord/kernel';

import { logger } from '../../config/logging.js';
import { sealJsonField } from '../../db/crypto/index.js';
import type { DB, MeetingsTable } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { isAiRefusal } from '../llm/refusal.js';
import { newId } from '../../utils/ids.js';
import { mentionedClockTimes } from '../../utils/date-mentions.js';
import { offsetForLocalDatetime, svWall } from '../../utils/tz.js';
import { ownAddresses } from './sender-stats.service.js';

export type MeetingRow = Selectable<MeetingsTable>;

/** An hour when the email gave a start and no end. */
const DEFAULT_MINUTES = 60;
/** A meeting nobody has touched in this long is not followed any more. */
const STALE_DAYS = 30;

const lower = (a: string): string => a.trim().toLowerCase();

/** ISO start/end for a slot read in code, on the zone the email wrote it in. */
export function slotInstants(s: SlotFact, tz: string | null): { start: string; end: string } | null {
  if (!slotIsTimed(s)) return null;
  const zone = s.timeZone ?? tz ?? 'UTC';
  const at = (min: number): string => {
    const dayMs = Date.parse(`${s.day}T00:00:00Z`) + Math.floor(min / 1440) * 86_400_000;
    const day = new Date(dayMs).toISOString().slice(0, 10);
    const m = ((min % 1440) + 1440) % 1440;
    const local = `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    return `${local}${offsetForLocalDatetime(zone, local)}`;
  };
  return { start: at(s.minutes), end: at(s.endMinutes ?? s.minutes + DEFAULT_MINUTES) };
}

/**
 * The offered time a dateless acceptance picks: "2:00 works, I am in Seattle
 * so 11:00 PST" against "noon est tomorrow, or 2-4p est" is tomorrow 2:00 PM
 * Eastern. Each clock time is tried in both halves of the day and on its own
 * zone (else the offer's, else the user's); a reading that lands inside an
 * offered window counts. Exactly one moment, or nothing.
 */
export function acceptedOffer(text: string, offered: readonly SlotFact[], tz: string | null): SlotFact | null {
  const hits = new Map<number, SlotFact>();
  for (const offer of offered) {
    const window = slotInstants(offer, tz);
    if (!window) continue;
    const startMs = Date.parse(window.start);
    const endMs = offer.endMinutes !== undefined ? Date.parse(window.end) : startMs + 60_000;
    const zone = (c: { timeZone?: string }) => c.timeZone ?? offer.timeZone ?? tz ?? 'UTC';
    for (const c of mentionedClockTimes(text)) {
      for (const minutes of c.readings) {
        const slot: SlotFact = { text, day: offer.day!, minutes, timeZone: zone(c) };
        const at = slotInstants(slot, tz);
        const ms = at ? Date.parse(at.start) : NaN;
        if (ms >= startMs && ms < endMs) hits.set(ms, slot);
      }
    }
  }
  return hits.size === 1 ? [...hits.values()][0]! : null;
}

function mergeFacts(prev: MeetingFacts | null, f: SchedulingFacts, side: 'them' | 'me'): MeetingFacts {
  const out: MeetingFacts = { ...(prev ?? { format: 'unknown', offered: [] }) };
  if (f.title) out.title = f.title;
  if (f.format !== 'unknown') out.format = f.format;
  if (f.place) out.place = f.place;
  if (f.link) out.link = f.link;
  if (f.phone) out.phone = f.phone;
  if (f.offered.length > 0) {
    out.offered = f.offered;
    out.offeredBy = side;
  }
  if (f.agreed) out.agreed = f.agreed;
  if (f.onBehalfOf) out.onBehalfOf = f.onBehalfOf;
  if (f.inviteEvidence) out.inviteEvidence = f.inviteEvidence;
  return out;
}

/**
 * Who sends the invite, seen from the user. The block reads it from the
 * recipient's side, so on the user's own message the two answers swap
 * ("I'll send an invite" read by Rob is "them").
 */
function inviteByFor(f: SchedulingFacts, side: 'them' | 'me'): 'them' | 'me' | 'unknown' {
  if (f.inviteBy === 'unknown' || side === 'them') return f.inviteBy;
  return f.inviteBy === 'me' ? 'them' : 'me';
}

export interface MeetingMessagePeople {
  fromEmail: string | null;
  toEmails: readonly string[];
  ccEmails: readonly string[];
}

/** Record one message's scheduling block on its thread's meeting. */
export async function recordMeetingFromEmail(
  db: Kysely<DB>,
  userId: string,
  threadKey: string,
  facts: SchedulingFacts,
  side: 'them' | 'me',
  opts: { tz: string | null; people: MeetingMessagePeople; own?: readonly string[] },
): Promise<MeetingRow | null> {
  const prev = await db
    .selectFrom('meetings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('thread_key', '=', threadKey)
    .executeTakeFirst();
  // "2:00 works" names no day: it accepts one of the times the other side
  // offered, which decide the day and the half of the day.
  if (facts.agreed && !slotInstants(facts.agreed, opts.tz) && prev?.facts_json) {
    const p = prev.facts_json;
    const offeredByOther = p.offeredBy && p.offeredBy !== side ? p.offered : [];
    const picked = acceptedOffer(facts.agreed.text, offeredByOther, opts.tz);
    if (picked) facts = { ...facts, agreed: picked };
  }
  const agreed = facts.agreed ? slotInstants(facts.agreed, opts.tz) : null;
  let next = nextMeetingState(prev?.state ?? null, facts.act, side, !!agreed);
  if (!prev && !next) return null;

  const own = new Set((opts.own ?? (await ownAddresses(db, userId))).map(lower));
  const notCore = new Set([...(prev?.not_core ?? []), ...facts.notCore].map(lower));
  const core = new Set((prev?.core_people ?? []).map(lower));
  // Cc'd people are onlookers until they speak: the writer is core whatever
  // line they were on before, and someone on Cc whose times are passed on
  // becomes core below.
  for (const a of [opts.people.fromEmail, ...opts.people.toEmails]) {
    if (!a) continue;
    const e = lower(a);
    if (e.includes('@') && !own.has(e) && !notCore.has(e)) core.add(e);
  }
  for (const e of notCore) core.delete(e);

  const merged = mergeFacts(prev?.facts_json ?? null, facts, side);
  // ADR 0346 phase 7 - each person's own offers. The user's own message adds
  // none: their calendar is checked directly.
  let groupAgreed = true;
  if (side === 'them') {
    const writer = opts.people.fromEmail ? lower(opts.people.fromEmail) : null;
    const forWhom = writer ? principalFor(writer, facts, core, notCore) : null;
    const offers = new Map((merged.offers ?? []).map((o) => [o.person, o]));
    const put = (person: string, offered: SlotFact[], unavailable: SlotFact[]) => {
      if (offered.length === 0 && unavailable.length === 0) return;
      offers.set(person, { person, offered, unavailable, ...(facts.sentAt ? { at: facts.sentAt } : {}) });
    };
    if (forWhom) {
      put(forWhom, facts.agreed && agreed ? [facts.agreed] : facts.offered, facts.unavailable);
    }
    for (const o of facts.others) {
      const p = lower(o.person);
      if (p.includes('@') && !own.has(p) && !notCore.has(p)) core.add(p);
      put(p, o.offered, o.unavailable);
    }
    merged.offers = [...offers.values()];
    // In a group, one person agreeing is not everyone agreeing: the time is
    // agreed once every core person has said it works for them.
    if (next === 'agreed' && agreed && core.size >= 2) {
      const tz = opts.tz ?? 'UTC';
      const s = Date.parse(agreed.start);
      const e = Date.parse(agreed.end);
      groupAgreed = [...core].every((p) => {
        const o = offers.get(p);
        return !!o && personSpans(o, tz, (e - s) / 60_000).some((sp) => sp.startMs <= s && sp.endMs >= e);
      });
      if (!groupAgreed) next = prev?.state && prev.state !== 'agreed' ? prev.state : 'offered';
    }
  }
  const inviteBy = inviteByFor(facts, side);
  const now = new Date().toISOString();
  const values = {
    state: next ?? prev!.state,
    core_people: JSON.stringify([...core]),
    not_core: JSON.stringify([...notCore]),
    invite_by: inviteBy === 'unknown' ? (prev?.invite_by ?? 'unknown') : inviteBy,
    ...(agreed && groupAgreed ? { agreed_start: agreed.start, agreed_end: agreed.end } : {}),
    facts_json: await sealJsonField(userId, 'meetings:facts_json', JSON.stringify(merged)),
    updated_at: now,
  };
  if (prev) {
    return db
      .updateTable('meetings')
      .set(values)
      .where('id', '=', prev.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return db
    .insertInto('meetings')
    .values({ id: newId('mtg'), user_id: userId, thread_key: threadKey, created_at: now, ...values })
    .onConflict((oc) => oc.columns(['user_id', 'thread_key']).doUpdateSet(values))
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Whose availability a message gives: the writer's own, or, for an
 * assistant, their principal's (the one core person their name or domain
 * points to). Null for an assistant whose principal cannot be told.
 */
function principalFor(
  writer: string,
  facts: SchedulingFacts,
  core: Set<string>,
  notCore: Set<string>,
): string | null {
  if (!notCore.has(writer) && facts.writer !== 'assistant') return writer;
  const name = facts.onBehalfOf?.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3) ?? [];
  const byName = [...core].filter((c) => name.some((w) => c.split('@')[0]!.includes(w)));
  if (byName.length === 1) return byName[0]!;
  const domain = writer.split('@')[1];
  const byDomain = [...core].filter((c) => c.split('@')[1] === domain);
  if (byDomain.length === 1) return byDomain[0]!;
  return core.has(writer) ? writer : null;
}

/**
 * ADR 0346 phase 7 - a group meeting the USER is arranging (they send the
 * invite, or they put times to everyone) is agreed once every core person
 * has answered and exactly one time suits them all: that time, for the
 * meeting's length. Two or more common times stay a choice for the user;
 * anyone still to answer keeps it open.
 */
export async function promoteGroupAgreements(
  db: Kysely<DB>,
  userId: string,
  tz: string | null,
  nowMs = Date.now(),
): Promise<number> {
  const rows = await db
    .selectFrom('meetings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('state', 'in', ['offered', 'proposed'])
    .where('updated_at', '>', new Date(nowMs - STALE_DAYS * 86_400_000).toISOString())
    .execute();
  let promoted = 0;
  for (const m of rows) {
    if (m.invite_by !== 'me' && m.state !== 'proposed') continue;
    if (m.core_people.length < 2) continue;
    const offers = m.facts_json?.offers ?? [];
    const ct = commonTimes(offers, { userZone: tz ?? 'UTC', durationMin: DEFAULT_MINUTES, corePeople: m.core_people, nowMs });
    if (ct.waiting.length > 0 || ct.windows.length !== 1) continue;
    const w = ct.windows[0]!;
    const end = Math.min(w.endMs, w.startMs + DEFAULT_MINUTES * 60_000);
    const zone = tz ?? 'UTC';
    const iso = (ms: number) => {
      const local = svWall(new Date(ms), zone).replace(' ', 'T').slice(0, 19);
      return `${local}${offsetForLocalDatetime(zone, local)}`;
    };
    await db
      .updateTable('meetings')
      .set({ state: 'agreed', agreed_start: iso(w.startMs), agreed_end: iso(end), updated_at: new Date(nowMs).toISOString() })
      .where('id', '=', m.id)
      .execute();
    promoted += 1;
  }
  return promoted;
}

/** People a group meeting the user is arranging is still waiting to hear from. */
export async function waitingOnAnswers(
  db: Kysely<DB>,
  userId: string,
  nowMs = Date.now(),
): Promise<Array<{ title: string; waiting: string[] }>> {
  const rows = await db
    .selectFrom('meetings')
    .select(['core_people', 'facts_json', 'invite_by', 'state'])
    .where('user_id', '=', userId)
    .where('state', 'in', ['offered', 'proposed'])
    .where('updated_at', '>', new Date(nowMs - 14 * 86_400_000).toISOString())
    .execute();
  const out: Array<{ title: string; waiting: string[] }> = [];
  for (const m of rows) {
    if (m.invite_by !== 'me' && m.state !== 'proposed') continue;
    if (m.core_people.length < 2) continue;
    const answered = new Set((m.facts_json?.offers ?? []).map((o) => o.person));
    if (answered.size === 0) continue;
    const waiting = m.core_people.filter((p) => !answered.has(lower(p)));
    if (waiting.length > 0) out.push({ title: m.facts_json?.title ?? 'a meeting', waiting });
  }
  return out;
}

/** Meetings still being arranged or waiting on an invite. */
export async function openMeetings(db: Kysely<DB>, userId: string): Promise<MeetingRow[]> {
  return db
    .selectFrom('meetings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('state', 'in', ['offered', 'proposed', 'agreed'])
    .where('updated_at', '>', new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString())
    .execute();
}

/** Every assistant the user's recent meetings have met: never core anywhere. */
export async function meetingAssistants(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('meetings')
    .select('not_core')
    .where('user_id', '=', userId)
    .where('updated_at', '>', new Date(Date.now() - 2 * STALE_DAYS * 86_400_000).toISOString())
    .execute();
  return [...new Set(rows.flatMap((r) => r.not_core.map(lower)))];
}

export interface InviteForMeeting {
  uid: string | null;
  organizer: string | null;
  /** Everyone on the invitation and its email. */
  people: readonly string[];
  startsAt: string;
}

/**
 * The meeting an invitation is for, if exactly one fits: its organizer is on
 * the other side (the person, their assistant), every core person is on it
 * (extras and a dropped assistant change nothing), and it falls on the agreed
 * day, or the day of a time on offer. Two that fit = none (never a guess).
 */
export async function linkInviteToMeeting(
  db: Kysely<DB>,
  userId: string,
  invite: InviteForMeeting,
  tz: string | null,
): Promise<MeetingRow | null> {
  const meetings = await openMeetings(db, userId);
  if (meetings.length === 0) return null;
  const people = new Set(invite.people.map(lower));
  const organizer = invite.organizer ? lower(invite.organizer) : null;
  if (organizer) people.add(organizer);
  const zone = tz ?? 'UTC';
  const inviteDay = svWall(new Date(Date.parse(invite.startsAt)), zone).slice(0, 10);
  const fits = meetings.filter((m) => {
    const other = new Set([...m.core_people, ...m.not_core].map(lower));
    if (organizer && !other.has(organizer)) return false;
    if (m.core_people.length === 0 || !m.core_people.every((p) => people.has(lower(p)))) return false;
    const days = new Set<string>();
    if (m.agreed_start) days.add(svWall(new Date(Date.parse(m.agreed_start)), zone).slice(0, 10));
    else for (const s of m.facts_json?.offered ?? []) if (s.day) days.add(s.day);
    return days.size === 0 || days.has(inviteDay);
  });
  if (fits.length !== 1) return null;
  const m = fits[0]!;
  return db
    .updateTable('meetings')
    .set({ state: 'invited', invite_uid: invite.uid, updated_at: new Date().toISOString() })
    .where('id', '=', m.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** An invitation's cancellation cancels the meeting it was for. */
export async function cancelMeetingByInviteUid(db: Kysely<DB>, userId: string, uid: string): Promise<void> {
  await db
    .updateTable('meetings')
    .set({ state: 'cancelled', updated_at: new Date().toISOString() })
    .where('user_id', '=', userId)
    .where(sql<boolean>`lower(invite_uid) = ${uid.toLowerCase()}`)
    .execute();
}

/** Thread keys of meetings an invitation was linked to, by invite UID. */
export async function meetingThreadsForInvites(
  db: Kysely<DB>,
  userId: string,
  uids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(uids.filter(Boolean).map(lower))];
  if (wanted.length === 0) return out;
  const rows = await db
    .selectFrom('meetings')
    .select(['invite_uid', 'thread_key'])
    .where('user_id', '=', userId)
    .where(sql<boolean>`lower(invite_uid) in (${sql.join(wanted)})`)
    .execute();
  for (const r of rows) if (r.invite_uid) out.set(lower(r.invite_uid), r.thread_key);
  return out;
}

export interface OwnReplyReader {
  /** Reads one of the user's own messages for its scheduling block only. */
  read(input: {
    subject: string;
    bodyText: string;
    participants: string | null;
    sentAt: string | null;
    tz: string | null;
  }): Promise<import('@chord/kernel').SchedulingBlock | null>;
}

/**
 * Read the user's own sent replies on threads whose meeting is still being
 * arranged, newest first, at most `limit` per pass. A reply already read is
 * not read again (`read_through`). Stops quietly when the model is refused
 * (no consent, no allowance), leaving the reply for a later pass.
 */
export async function readOwnRepliesForMeetings(
  db: Kysely<DB>,
  userId: string,
  reader: OwnReplyReader,
  helpers: {
    finish: (
      block: import('@chord/kernel').SchedulingBlock,
      msg: import('./scheduling-block.js').SchedulingMessage,
      own: readonly string[],
    ) => SchedulingFacts;
    bodyOf: (row: { body_text: string | null; body_html: string | null; body_excerpt: string | null }) => string;
    participantsOf: (row: {
      from_email: string | null;
      from_name: string | null;
      to_emails: string[];
      cc_emails: string[];
    }) => string | null;
  },
  opts: { limit?: number } = {},
): Promise<number> {
  const meetings = await db
    .selectFrom('meetings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('state', 'in', ['offered', 'proposed', 'agreed'])
    .where('updated_at', '>', new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString())
    .execute();
  if (meetings.length === 0) return 0;
  const [own, user] = await Promise.all([
    ownAddresses(db, userId),
    db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst(),
  ]);
  const tz = user?.last_tz ?? null;
  let read = 0;
  for (const m of meetings) {
    if (read >= (opts.limit ?? 5)) break;
    const gid = m.thread_key.startsWith('gmail:') ? m.thread_key.slice('gmail:'.length) : null;
    if (!gid) continue;
    let q = db
      .selectFrom('email_messages')
      .select([
        'id',
        'internal_date',
        'subject',
        'body_text',
        'body_html',
        'body_excerpt',
        'from_email',
        'from_name',
        'to_emails',
        'cc_emails',
      ])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .where(sql<boolean>`gmail_label_ids @> '["SENT"]'::jsonb`)
      .where(sql<boolean>`not (gmail_label_ids @> '["DRAFT"]'::jsonb)`);
    if (m.read_through) q = q.where(textInstant('internal_date'), '>', sql<string>`${m.read_through}::timestamptz`);
    const mine = await q.orderBy(textInstant('internal_date'), 'desc').limit(1).executeTakeFirst();
    if (!mine) continue;
    const body = helpers.bodyOf(mine);
    if (!body) continue;
    let block;
    try {
      block = await reader.read({
        subject: mine.subject ?? '',
        bodyText: body,
        participants: helpers.participantsOf(mine),
        sentAt: mine.internal_date,
        tz,
      });
    } catch (err) {
      if (isAiRefusal(err)) return read;
      logger.warn('meeting: own reply read failed', { userId, err: (err as Error).message });
      continue;
    }
    read += 1;
    if (block) {
      const facts = helpers.finish(
        block,
        {
          bodyText: body,
          fromEmail: mine.from_email,
          fromName: mine.from_name,
          toEmails: mine.to_emails ?? [],
          ccEmails: mine.cc_emails ?? [],
          sentDay: svWall(new Date(Date.parse(mine.internal_date)), tz ?? 'UTC').slice(0, 10),
          sentAt: mine.internal_date,
        },
        own,
      );
      await recordMeetingFromEmail(db, userId, m.thread_key, facts, 'me', {
        tz,
        own,
        people: { fromEmail: mine.from_email, toEmails: mine.to_emails ?? [], ccEmails: mine.cc_emails ?? [] },
      });
    }
    await db
      .updateTable('meetings')
      .set({ read_through: new Date(Date.parse(mine.internal_date)).toISOString() })
      .where('id', '=', m.id)
      .execute();
  }
  return read;
}

export type { MeetingState };
