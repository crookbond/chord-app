/**
 * Is the event about to be created one that is already on the calendar?
 *
 * Several emails describe one flight (the booking, the e-ticket, the change
 * notice, one copy per passenger), and each used to become its own calendar
 * event. This is the deterministic test for "the same event again", used at
 * the moment of creation so the existing event is updated instead. No model
 * is asked: the answer has to be the same every time.
 *
 * Deliberately strict on time and loose on wording. The times must be the
 * SAME instants - a moved flight is a reschedule, handled elsewhere - while
 * the titles only have to be about the same thing, because the title is the
 * part each email words differently.
 */

/** Calendar events that mirror a travel leg carry this `external_uid` prefix. */
export const TRAVEL_LEG_EXTERNAL_UID_PREFIX = 'chord:travel_leg:';

export interface EventLike {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
  description?: string | null;
  googleCalendarId?: string | null;
  /** A travel leg's own calendar copy: a flight whatever its wording. */
  isTravelLeg?: boolean;
  /** Who is on it besides the user: a pulled event's guests and organizer,
   *  or the addresses a new event will invite. Any case. */
  guestEmails?: readonly string[] | null;
}

/**
 * The same people: every address on one side is on the other. The smaller
 * side is usually the new event's invitees (the user is not among them),
 * the larger a pulled event's full list (the user and organizer included).
 */
export function samePeople(a?: readonly string[] | null, b?: readonly string[] | null): boolean {
  const norm = (l?: readonly string[] | null) =>
    new Set((l ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')));
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size === 0 || sb.size === 0) return false;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const e of small) if (!large.has(e)) return false;
  return true;
}

const FLIGHT_WORD = /\b(flight|flying|fly|airlines?|airways|boarding)\b|✈/i;
/** "UA 512", "AI101", "B6 1234" - an airline code then up to four digits. */
const DESIGNATOR = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/;
/** "EWR→DEN", "EWR -> DEN", "EWR to DEN". */
const ROUTE = /\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/;
/** "Maya — UA512…": a managed persona's event carries the name up front. */
const PERSONA_PREFIX = /^[^—]{1,40} — /;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'at', 'with', 'for', 'to', 'of', 'and', 'in', 'on', 'from', 'your', 'my',
]);

function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function stripPersona(title: string): string {
  return title.replace(PERSONA_PREFIX, '');
}

interface FlightFacts {
  isFlight: boolean;
  designator: string | null;
  route: string | null;
}

export function flightFacts(e: EventLike): FlightFacts {
  const title = stripPersona(e.title);
  const d = DESIGNATOR.exec(title);
  const r = ROUTE.exec(title) ?? ROUTE.exec(e.location ?? '');
  return {
    isFlight: !!e.isTravelLeg || !!d || FLIGHT_WORD.test(title),
    designator: d ? `${d[1]}${d[2]}` : null,
    route: r ? `${r[1]}>${r[2]}` : null,
  };
}

function titleTokens(title: string): Set<string> {
  const words = stripPersona(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
  return new Set(words);
}

/** The same subject, worded differently: one title inside the other, or most
 *  of the meaningful words shared. */
function titlesSimilar(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  if (shared === Math.min(ta.size, tb.size)) return true;
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

const normPlace = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function locationsDisagree(a?: string | null, b?: string | null): boolean {
  const na = normPlace(a ?? '');
  const nb = normPlace(b ?? '');
  if (!na || !nb) return false;
  return !(na === nb || na.includes(nb) || nb.includes(na));
}

/** A calendar the caller did not really choose says nothing about a mismatch. */
const namedCalendar = (id?: string | null): string | null => (id && id !== 'primary' ? id : null);

export function isSameEvent(a: EventLike, b: EventLike): boolean {
  const sa = instant(a.startsAt);
  const sb = instant(b.startsAt);
  if (sa === null || sb === null || sa !== sb) return false;
  const ea = instant(a.endsAt);
  const eb = instant(b.endsAt);
  if (ea !== null && eb !== null && ea !== eb) return false;

  // Same instants with the same people is one meeting, whatever each side
  // calls it and whichever calendar it is on (owner rule 2026-11-10: "Follow
  // up: Neural Ads/ Post Oak Group" and "Introductory Meeting with Mark
  // Clark" were one call with Mark).
  if (samePeople(a.guestEmails, b.guestEmails)) return true;

  const ca = namedCalendar(a.googleCalendarId);
  const cb = namedCalendar(b.googleCalendarId);
  if (ca && cb && ca !== cb) return false;

  const fa = flightFacts(a);
  const fb = flightFacts(b);
  if (fa.isFlight && fb.isFlight) {
    // Two flights leaving and landing at the same instants on one person's
    // calendar are one flight - unless they name different ones.
    if (fa.designator && fb.designator && fa.designator !== fb.designator) return false;
    if (fa.route && fb.route && fa.route !== fb.route) return false;
    return true;
  }

  if (!titlesSimilar(a.title, b.title)) return false;
  return !locationsDisagree(a.location, b.location);
}

interface Passenger {
  name: string;
  confirmation: string | null;
  /** Their own itinerary number, link back to their email, and the like. */
  details: string[];
}

interface DescriptionParts {
  passengers: Passenger[];
  /** Lines that belong to the event as a whole. */
  lines: string[];
}

const PASSENGER_LINE = /^passenger(s)?:\s*(.+)$/i;
const CONFIRMATION_LINE = /^confirmation:\s*(.+)$/i;
/** "John Doe · Confirmation: 6XK2PQ" - the name, then their own booking. */
const PASSENGER_CONFIRMATION = /^(.*?)\s*·\s*confirmation:?\s*(.+)$/i;
/** A line under a passenger that is that passenger's own. */
const DETAIL_BULLET = '• ';

/** One line per person, their confirmation beside their name. */
export function passengerLine(name: string, confirmation?: string | null): string {
  const pnr = confirmation?.trim();
  return pnr ? `Passenger: ${name.trim()} · Confirmation: ${pnr}` : `Passenger: ${name.trim()}`;
}

/**
 * A passenger's block: their line, then each of their own details under it.
 * Two bookings on one flight would otherwise read as a pile of itinerary
 * numbers and links with nothing to say whose each one is.
 */
export function passengerBlock(
  name: string,
  confirmation: string | null | undefined,
  details: Array<string | null | undefined>,
): string {
  const own = details.map((d) => d?.trim()).filter((d): d is string => !!d);
  return [passengerLine(name, confirmation), ...own.map((d) => `${DETAIL_BULLET}${d}`)].join('\n');
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function addUnique(list: string[], line: string): void {
  if (!list.some((l) => sameText(l, line))) list.push(line);
}

function parseDescription(text: string | null | undefined): DescriptionParts {
  const parts: DescriptionParts = { passengers: [], lines: [] };
  let current: Passenger | null = null;
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(DETAIL_BULLET.trim()) && current) {
      addUnique(current.details, line.slice(DETAIL_BULLET.trim().length).trim());
      continue;
    }
    const m = PASSENGER_LINE.exec(line);
    if (!m) {
      current = null;
      addUnique(parts.lines, line);
      continue;
    }
    // The plural form is the older comma list, which carried nothing per person.
    if (m[1]) {
      current = null;
      for (const n of m[2]!.split(',')) {
        if (n.trim()) parts.passengers.push({ name: n.trim(), confirmation: null, details: [] });
      }
      continue;
    }
    const withPnr = PASSENGER_CONFIRMATION.exec(m[2]!);
    const name = (withPnr ? withPnr[1]! : m[2]!).trim();
    if (!name) continue;
    current = { name, confirmation: withPnr ? withPnr[2]!.trim() : null, details: [] };
    parts.passengers.push(current);
  }
  return parts;
}

function renderDescription(parts: DescriptionParts): string | null {
  // A confirmation already shown beside its passenger is not repeated bare.
  const owned = parts.passengers.map((p) => p.confirmation).filter((c): c is string => !!c);
  const rest = parts.lines.filter((l) => {
    const c = CONFIRMATION_LINE.exec(l);
    return !(c && owned.some((o) => sameText(o, c[1]!)));
  });
  const blocks = parts.passengers.map((p) => passengerBlock(p.name, p.confirmation, p.details));
  return [...blocks, ...rest].join('\n') || null;
}

/**
 * Both descriptions, each fact once. Every passenger keeps one block: their
 * line with their own confirmation, and their own details under it. Lines that
 * belong to no passenger are kept in the order they first appeared.
 */
export function mergeDescriptions(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const out: DescriptionParts = { passengers: [], lines: [] };
  for (const parts of [parseDescription(existing), parseDescription(incoming)]) {
    for (const p of parts.passengers) {
      const known = out.passengers.find((k) => sameText(k.name, p.name));
      if (!known) {
        out.passengers.push({ ...p, details: [...p.details] });
        continue;
      }
      if (!known.confirmation && p.confirmation) known.confirmation = p.confirmation;
      for (const d of p.details) addUnique(known.details, d);
    }
    for (const l of parts.lines) addUnique(out.lines, l);
  }
  return renderDescription(out);
}

/** The description with one passenger, and everything that was theirs, taken off. */
export function removePassenger(
  description: string | null | undefined,
  name: string | null | undefined,
): string | null {
  const who = name?.trim();
  if (!description || !who) return description ?? null;
  const parts = parseDescription(description);
  return renderDescription({
    passengers: parts.passengers.filter((p) => !sameText(p.name, who)),
    lines: parts.lines,
  });
}

/**
 * The description with what one block put there taken off: its passengers by
 * name, and its lines that belong to no passenger (what a leg wrote before it
 * had a passenger).
 */
export function removeBlock(
  description: string | null | undefined,
  block: string | null | undefined,
): string | null {
  if (!description || !block?.trim()) return description ?? null;
  const parts = parseDescription(description);
  const gone = parseDescription(block);
  return renderDescription({
    passengers: parts.passengers.filter((p) => !gone.passengers.some((g) => sameText(g.name, p.name))),
    lines: parts.lines.filter((l) => !gone.lines.some((g) => sameText(g, l))),
  });
}

export interface EventMergePatch {
  title?: string;
  endsAt?: string;
  location?: string;
  description?: string;
}

/**
 * What the existing event gains from the incoming one. Fills what is missing
 * and never overwrites what is there, with one exception: a title that names
 * the flight replaces one that does not ("Flight to Denver" -> "UA 512
 * EWR→DEN"). Returns null when there is nothing to change.
 */
export function mergeEventDetails(existing: EventLike, incoming: EventLike): EventMergePatch | null {
  const patch: EventMergePatch = {};
  const fe = flightFacts(existing);
  const fi = flightFacts(incoming);
  if (fe.isFlight && fi.isFlight && !fe.designator && fi.designator) {
    patch.title = stripPersona(incoming.title);
  }
  if (!existing.endsAt && incoming.endsAt) patch.endsAt = incoming.endsAt;
  if (!existing.location?.trim() && incoming.location?.trim()) patch.location = incoming.location;
  const description = mergeDescriptions(existing.description, incoming.description);
  if (description && description !== (existing.description ?? '').trim()) {
    patch.description = description;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
