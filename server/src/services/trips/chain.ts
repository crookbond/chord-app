/**
 * ADR 0190 — the pure rules for "which legs make one trip", shared by the
 * live matcher (`findTripForTraveler`) and the one-time regroup script so the
 * two can never disagree about what a trip is.
 *
 * A trip is one traveler's chain of connected legs (each leg leaves from
 * where the last one arrived, by CITY, not exact airport) — plus anyone who
 * is on the same physical flight, since companions share one itinerary.
 * A chain ENDS when the traveler gets back to where it started (A→B→A is one
 * trip; the next A→C is a new one), and a long silence ends it too.
 */
import { sameMetro } from '@chord/kernel';

export interface ChainLeg {
  origin: string;
  destination: string;
  departAt: string;
  /** Not used for matching (only `departAt` orders the chain) — accepted so
   *  callers can pass their leg objects through as-is. */
  arriveAt?: string;
}

/** How long a chain may go quiet before the next leg, by what that leg is.
 *  A connection ONWARD (the next leg heads somewhere new) is a hop within a
 *  trip — weeks, not months, or it is a fresh journey that merely starts
 *  where the last one happened to end (someone who lands home in May and
 *  flies out again in August has not been in transit). A RETURN to where the
 *  chain started can follow a long stay — a semester away is a real trip —
 *  but not an unbounded one. A missed join costs one merge tap; a wrong one
 *  glues two journeys together (ADR 0190's asymmetry). */
export const MAX_ONWARD_GAP_DAYS = 30;
export const MAX_RETURN_GAP_DAYS = 90;
const MAX_ONWARD_GAP_MS = MAX_ONWARD_GAP_DAYS * 86_400_000;
const MAX_RETURN_GAP_MS = MAX_RETURN_GAP_DAYS * 86_400_000;

/** `departAt` as a real instant (epoch ms, UTC), not a string — two legs
 *  anchored to different zones can print different-looking ISO strings for
 *  the exact same moment ("...T20:20:00-06:00" vs "...T21:20:00-05:00"), so
 *  ordering or comparing them lexically is wrong. The string MUST carry an
 *  offset: a bare "...T01:50:00" is read in the SERVER's zone, which is
 *  wrong by hours for a ticket printed in another one — callers zone first
 *  (`zonedDatetime`). Falls back to 0 for a malformed string so a bad value
 *  sorts first rather than throwing. */
export function departAtMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Exact place-text equality (case/whitespace folded) — the fallback for a
 *  place `sameMetro` can't resolve either side of (a bush airstrip, a
 *  regional field with no table entry). */
export function samePlaceText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().trim();
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

/** Same place: the same metro, or — when the table knows neither — the very
 *  same words. Deliberately never fuzzy beyond that. */
export function placesMatch(a: string, b: string): boolean {
  return sameMetro(a, b) === true || samePlaceText(a, b);
}

/** The same physical flight: identical route and identical INSTANT of
 *  departure. Two different travelers on it are companions; the same
 *  traveler on it twice is a duplicate. */
export function sameFlight(a: ChainLeg, b: ChainLeg): boolean {
  const ma = departAtMs(a.departAt);
  return ma > 0
    && ma === departAtMs(b.departAt)
    && a.origin.trim().toLowerCase() === b.origin.trim().toLowerCase()
    && a.destination.trim().toLowerCase() === b.destination.trim().toLowerCase();
}

/**
 * For legs sorted by departure, whether each seam continues the chain:
 * `result[i]` is the seam between `sorted[i]` and `sorted[i + 1]`.
 *
 * A seam continues only when the chain is still OPEN (the previous leg did
 * not bring the traveler back to where the chain started), the gap is within
 * the limit for what the next leg is (`MAX_ONWARD_GAP_DAYS` for a connection,
 * `MAX_RETURN_GAP_DAYS` for the leg that closes the loop), and the next leg
 * leaves from where the last arrived. Whenever a seam does not continue, the
 * next leg starts a fresh chain.
 */
export function chainSeams(sorted: ChainLeg[]): boolean[] {
  const seams: boolean[] = [];
  if (sorted.length === 0) return seams;
  let chainStart = sorted[0]!.origin;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const closed = placesMatch(prev.destination, chainStart);
    const isReturn = placesMatch(cur.destination, chainStart);
    const gapOk =
      departAtMs(cur.departAt) - departAtMs(prev.departAt) <= (isReturn ? MAX_RETURN_GAP_MS : MAX_ONWARD_GAP_MS);
    const continues = !closed && gapOk && placesMatch(prev.destination, cur.origin);
    seams.push(continues);
    if (!continues) chainStart = cur.origin;
  }
  return seams;
}

/** True when inserting `incoming` into `existing`'s own timeline leaves every
 *  seam that touches a new leg continuing. A seam between two legs already
 *  on the trip is never re-judged. */
export function chainConnects(existing: ChainLeg[], incoming: ChainLeg[]): boolean {
  if (existing.length === 0) return false;
  // A leg already on the trip needs no fresh seam check — it's already
  // there. Without this, a byte-identical re-send (a resent itinerary, a
  // second passenger's copy of the same ticket) reads as a NEW leg sharing
  // its twin's departure instant, and the merge below breaks on the
  // artificial seam between two copies of the same leg.
  const newLegs = incoming.filter((inc) => !existing.some((ex) => sameFlight(ex, inc)));
  if (newLegs.length === 0) return true;

  const tagged = [
    ...existing.map((l) => ({ ...l, isNew: false })),
    ...newLegs.map((l) => ({ ...l, isNew: true })),
  ].sort((a, b) => departAtMs(a.departAt) - departAtMs(b.departAt));
  const seams = chainSeams(tagged);
  for (let i = 0; i < seams.length; i++) {
    if (!tagged[i]!.isNew && !tagged[i + 1]!.isNew) continue;
    if (!seams[i]) return false;
  }
  return true;
}

/** Honorifics real airline/booking documents prepend or append — dropped
 *  before comparing, so they never count as a "different" token. */
const NAME_TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mstr', 'master', 'dr']);

/** A name's significant words, lowercased, punctuation stripped, honorifics
 *  dropped, for order-independent and partial-name matching (a real prod
 *  pair: "SIMON STONE" vs "STONE SIMON MR"). */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NAME_TITLES.has(t));
}

/** Order-independent key for a token set — two names with the exact same
 *  words, any order, produce the same key. */
export function tokenSetKey(tokens: string[]): string {
  return [...new Set(tokens)].sort().join(' ');
}

/** True when the SHORTER token set is fully contained in the longer one —
 *  a bare first name restating a fuller name ("Ben" vs "Ben Doe"),
 *  never the reverse of two same-length names that merely share one word. */
export function isNameSubset(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0 || a.length === b.length) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  return shorter.every((t) => longerSet.has(t));
}

/** A traveler's name as a person would write it: a ticket's "DOE/JOHN MR"
 *  becomes "John Doe". Mixed-case names are left as typed. */
export function displayTravelerName(name: string): string {
  let s = name.trim();
  const slash = s.indexOf('/');
  if (slash > 0) s = `${s.slice(slash + 1)} ${s.slice(0, slash)}`;
  const shouting = !/[a-z]/.test(s);
  return s
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NAME_TITLES.has(w.toLowerCase().replace(/[^a-z]/g, '')))
    .map((w) => (shouting ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** The people on a trip, one entry per person: the first spelling wins, so a
 *  caller passes household names before ticket names, and "John" swallows a
 *  later "JOHN DOE". */
export function tripTravelerNames(names: Array<string | null | undefined>): string[] {
  const kept: { shown: string; tokens: string[] }[] = [];
  for (const raw of names) {
    if (!raw) continue;
    const shown = displayTravelerName(raw);
    const tokens = nameTokens(shown);
    if (tokens.length === 0) continue;
    const key = tokenSetKey(tokens);
    if (kept.some((k) => tokenSetKey(k.tokens) === key || isNameSubset(k.tokens, tokens))) continue;
    kept.push({ shown, tokens });
  }
  return kept.map((k) => k.shown);
}

/** A booking reference that can be trusted as an identity. Airlines and
 *  booking sites print six-ish alphanumerics; documents also carry
 *  placeholders ("N/A" — every safari stay in the real prod data has one), and
 *  matching two unrelated legs on a placeholder would glue them together. */
const PLACEHOLDER_BOOKING_IDS = new Set(['n/a', 'na', 'none', 'null', 'unknown', 'tbd', 'pending', 'confirmed', 'complete']);
export function bookingId(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.length < 5 || PLACEHOLDER_BOOKING_IDS.has(s)) return null;
  return s;
}

/** How far a booking's flight may move and still be "the same flight,
 *  rescheduled" rather than a second flight that happens to share the
 *  booking (an airline schedule change is hours or days; a rebook a few weeks
 *  at the outside). Judgement call, not measured. */
export const MAX_RESCHEDULE_DAYS = 30;
export const MAX_RESCHEDULE_MS = MAX_RESCHEDULE_DAYS * 86_400_000;

export interface Traveler {
  personaId?: string | null;
  name?: string | null;
}

/** Same person, for telling two rows apart (duplicate detection): personas by
 *  id, names by token set (word order and honorifics aside) or a bare name
 *  restating a fuller one, and "nobody named" only equals "nobody named". */
export function sameTravelerStrict(a: Traveler, b: Traveler): boolean {
  if (a.personaId || b.personaId) return !!a.personaId && a.personaId === b.personaId;
  const ta = nameTokens(a.name);
  const tb = nameTokens(b.name);
  if (ta.length === 0 && tb.length === 0) return true;
  if (ta.length === 0 || tb.length === 0) return false;
  return tokenSetKey(ta) === tokenSetKey(tb) || isNameSubset(ta, tb);
}

/** Compatible when there is no evidence they are DIFFERENT people: used where
 *  the booking id already vouches for the leg and a name is only a guard
 *  against attributing one traveler's change to another. A side with no name
 *  (or a persona vs a raw name, which cannot be compared) is compatible. */
export function sameTravelerLoose(a: Traveler, b: Traveler): boolean {
  if (a.personaId && b.personaId) return a.personaId === b.personaId;
  const ta = nameTokens(a.name);
  const tb = nameTokens(b.name);
  if (ta.length === 0 || tb.length === 0) return true;
  return tokenSetKey(ta) === tokenSetKey(tb) || isNameSubset(ta, tb);
}
