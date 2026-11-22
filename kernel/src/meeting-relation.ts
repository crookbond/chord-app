/**
 * ADR 0346 - how a meeting being scheduled relates to an event already on the
 * calendar: the same meeting, a prep or debrief next to it, a real conflict,
 * a block of the user's own that may move, or not clear enough to decide.
 *
 * A conflict is being busy with DIFFERENT people at the same time. Time
 * alone never makes one, and neither does an assistant who dropped off the
 * invite or a colleague the organizer added: only the core people count.
 */

export type MeetingRelation = 'same' | 'related' | 'conflict' | 'unsure' | 'personal_block' | 'none';

export interface MeetingSide {
  startMs: number;
  endMs: number;
  title: string;
  /** Everyone on it, any case. The user's own addresses are removed here. */
  people: readonly string[];
  /** Invite / calendar UIDs that identify it. */
  uids?: readonly (string | null | undefined)[];
  /** The email thread it came from, as `gmail:<id>`. */
  threadKey?: string | null;
  /** Other threads arranging the same meeting (an invitation arrives in its
   *  own thread; the meeting record links it to the one that agreed it). */
  relatedThreadKeys?: readonly string[];
  /** The event this meeting already points at, when there is one. */
  eventId?: string | null;
}

export interface CalendarSide extends MeetingSide {
  id: string;
}

export interface RelationOptions {
  /** The user's own addresses. */
  self: Iterable<string>;
  /** Addresses that never decide anything: assistants, rooms, lists. */
  notCore?: Iterable<string>;
}

/** Times "largely" overlap when the overlap covers this much of the shorter one. */
export const LARGE_OVERLAP = 0.75;
/** At most this much of the shorter one may overlap for a prep or debrief. */
export const EDGE_OVERLAP = 0.5;
/** Sharing this share of the smaller list's core people makes it one meeting. */
export const SAME_PEOPLE_SHARE = 0.5;

const PREP_TITLE =
  /\b(prep|preparation|pre[- ]?(?:meet(?:ing)?|call|brief|read|wire|sync)|debrief|dry[- ]run|sync before|before the)\b/i;
/** Robot and resource addresses: never a person to meet. */
const NOT_A_PERSON =
  /^(?:no-?reply|do-?not-?reply|notifications?|calendar|mailer-daemon|postmaster)@|@(?:resource\.calendar\.google\.com|group\.calendar\.google\.com)$/i;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'at', 'with', 'for', 'to', 'of', 'and', 'in', 'on', 'from', 'your', 'my', 'me', 're',
  'fw', 'fwd', 'meeting', 'call', 'invitation', 'invite', 'updated', 'accepted',
]);

const lower = (s: string): string => s.trim().toLowerCase();

function addresses(list: readonly string[]): Set<string> {
  return new Set(list.map(lower).filter((e) => e.includes('@') && !NOT_A_PERSON.test(e)));
}

/** The people who decide whether two events are the same meeting. */
export function corePeople(people: readonly string[], opts: RelationOptions): Set<string> {
  const skip = new Set([...opts.self, ...(opts.notCore ?? [])].map(lower));
  const out = addresses(people);
  for (const e of skip) out.delete(e);
  return out;
}

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .replace(/^(?:(?:re|fw|fwd|updated invitation|invitation|accepted|declined)\s*:\s*)+/gi, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** The same subject worded differently: one title's words inside the other,
 *  or most of them shared. */
export function titlesAlike(a: string, b: string): boolean {
  const ta = titleWords(a);
  const tb = titleWords(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  if (shared === 0) return false;
  if (shared === Math.min(ta.size, tb.size)) return true;
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

/** A title that names a person on the other side, by the local part of their
 *  address ("Call with Rob" and rob@x.com). */
function titleNamesSomeone(title: string, people: Set<string>): boolean {
  const words = titleWords(title);
  for (const p of people) {
    const local = p.split('@')[0]!.split(/[._+-]/)[0]!;
    if (local.length >= 3 && words.has(local)) return true;
  }
  return false;
}

function sameIdentity(a: MeetingSide, b: CalendarSide): boolean {
  if (a.eventId && a.eventId === b.id) return true;
  if (b.threadKey && (a.threadKey === b.threadKey || a.relatedThreadKeys?.includes(b.threadKey))) return true;
  const ua = new Set((a.uids ?? []).filter((u): u is string => !!u).map(lower));
  return (b.uids ?? []).some((u) => !!u && ua.has(lower(u)));
}

export function meetingRelation(meeting: MeetingSide, event: CalendarSide, opts: RelationOptions): MeetingRelation {
  if (sameIdentity(meeting, event)) return 'same';

  const overlap = Math.min(meeting.endMs, event.endMs) - Math.max(meeting.startMs, event.startMs);
  if (!(overlap > 0)) return 'none';
  const shorter = Math.min(meeting.endMs - meeting.startMs, event.endMs - event.startMs);
  const share = shorter > 0 ? overlap / shorter : 1;

  const mp = corePeople(meeting.people, opts);
  const ep = corePeople(event.people, opts);
  let shared = 0;
  for (const e of mp) if (ep.has(e)) shared += 1;
  const titleAlike =
    titlesAlike(meeting.title, event.title) ||
    titleNamesSomeone(event.title, mp) ||
    titleNamesSomeone(meeting.title, ep);
  const peopleDisagree = mp.size > 0 && ep.size > 0 && shared === 0;
  const large = share >= LARGE_OVERLAP;

  if (large) {
    const smaller = Math.min(mp.size, ep.size);
    // More than half: with two on each side, one shared colleague is two
    // different meetings; with one person on a side, that person is enough.
    if (smaller > 0 && (shared === smaller || shared / smaller > SAME_PEOPLE_SHARE)) return 'same';
    if (titleAlike && !peopleDisagree) return 'same';
  }

  // Touches one edge only: a prep before it, a debrief after.
  const contains =
    (event.startMs >= meeting.startMs && event.endMs <= meeting.endMs) ||
    (meeting.startMs >= event.startMs && meeting.endMs <= event.endMs);
  if (!contains && share <= EDGE_OVERLAP && (shared > 0 || PREP_TITLE.test(event.title))) return 'related';

  if (ep.size === 0) return titleAlike ? 'unsure' : 'personal_block';
  if (shared === 0 && !titleAlike) return 'conflict';
  return 'unsure';
}
