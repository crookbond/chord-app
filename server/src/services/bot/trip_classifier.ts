import type { Kysely } from 'kysely';
import { z } from 'zod';

import { SSE, airportTimeZone, placeTimeZone } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { debugSnippet } from '../../utils/prompt-log.js';
import type { DB, MessagesTable } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { parseJsonArray, parseJsonObject } from '../../utils/json-repair.js';
import { isBeforeDay, tzToOffsetMinutes, zonedWallToUtcMs } from '../../utils/tz.js';
import { emailCopyFiling } from '../email/attachment-filing-gate.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { getLlmForUser } from '../llm/factory.js';
import { canUseAi } from '../llm/refusal.js';
import type { LlmService } from '../llm/types.js';
import type { LlmContentPart, LlmMessage } from '../llm/types.js';
import { rowToMessage } from '../messages.service.js';
import { sseHub } from '../sse.hub.js';
import { createEvent, findSameAllDayEvent } from '../events.service.js';
import { createSave } from '../saves.service.js';
import {
  addAccommodation,
  addReservation,
  addTravelLeg,
  createTrip,
  findExistingAccommodation,
  findExistingLeg,
  findTripByDateRange,
  findTripForStay,
  findTripForTraveler,
  reconcileBookedLegs,
  rescheduleSameFlight,
} from '../trips.service.js';

// Normalise the many datetime string formats LLMs produce before Zod validates.
// Handles (in order):
//   "2026-04-24"                      → midnight UTC
//   "2026-04-24 10:30"                → space separator, no tz
//   "2026-04-24 10:30:00"             → space separator, no tz
//   "2026-04-24 10:30:00-05:00"       → space separator, with offset
//   "2026-04-24T10:30"                → T separator, no seconds, no tz
//   "2026-04-24T10:30-05:00"          → T separator, no seconds, with offset (common CDT/EDT)
//   "2026-04-24T10:30:00"             → T separator, no tz → append Z
//   "2026-04-24T10:30:00Z" and alike  → already valid, pass through
// Does NOT force a zone onto a bare datetime — extracted times are local to
// the ticket/reservation and get the right offset applied at filing
// (zonedDatetime for flights, toLocalDatetime for the rest). Allows
// date-only or datetime with optional zone. (The old leniDatetime variant
// that appended Z — a silent UTC assumption — is gone.)
const flightDatetime = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  let s = v.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  s = s.replace(/T(\d{2}:\d{2})(([+-]\d{2}:?\d{2})|Z|$)/, 'T$1:00$2');
  return s;
}, z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?)?$/));

const FlightLeg = z.object({
  origin: z.string().min(1).max(80),
  destination: z.string().min(1).max(80),
  departAt: flightDatetime,
  arriveAt: flightDatetime,
  /** IANA timezone of the origin/destination airport (e.g. "America/New_York",
   *  "Europe/Lisbon"). Used to anchor the local ticket times correctly. */
  departZone: z.string().max(60).optional(),
  arriveZone: z.string().max(60).optional(),
  carrier: z.string().max(80).optional(),
  flightNo: z.string().max(40).optional(),
  /** ADR 0158 — a "flight" booking may actually be rail/coach/ferry. Maps to
   *  `travel_legs.mode`; coach/bus fold to 'other'. Absent → 'flight'. */
  mode: z.enum(['flight', 'train', 'ferry', 'car', 'other']).optional(),
});
const Flight = z.object({
  kind: z.literal('flight'),
  legs: z.array(FlightLeg).min(1).max(10),
  confirmation: z.string().max(80).optional(),
  /** The booking-site itinerary / order number (Expedia, Booking.com …),
   *  distinct from the carrier PNR in `confirmation`. */
  itineraryNumber: z.string().max(120).optional(),
  passengerName: z.string().max(120).optional(),
});
const Hotel = z.object({
  kind: z.literal('hotel'),
  propertyName: z.string().min(1).max(120),
  address: z.string().max(200).optional(),
  /** Just the city (e.g. "Vail"), not the full address — used to title a
   *  hotel-only trip "Trip to <city>" instead of the property name, so a
   *  cancelled/rebooked stay reads as the same trip rather than a new one
   *  named after whichever hotel happened to be booked last. */
  city: z.string().max(80).optional(),
  checkinDate: z.string().min(10).max(10),
  checkoutDate: z.string().min(10).max(10),
  roomCount: z.number().int().positive().max(20).optional(),
  confirmation: z.string().max(80).optional(),
});
/** ADR 0168 — a cancellation notice for a hotel or flight booking. Carries
 *  just enough identifying detail (whichever the email actually restates) to
 *  locate the SPECIFIC booking it cancels — the same fields
 *  `findAccommodationToCancel`/`findLegToCancel` match on — never new
 *  itinerary detail of its own. */
const CancelledLeg = z.object({
  origin: z.string().max(80).optional(),
  destination: z.string().max(80).optional(),
  /** Local departure date/time as printed, same year-resolution rule as `flight`. */
  departAt: flightDatetime.optional(),
});
const Cancellation = z.object({
  kind: z.literal('cancellation'),
  cancelsKind: z.enum(['hotel', 'flight']),
  propertyName: z.string().max(120).optional(),
  checkinDate: z.string().min(10).max(10).optional(),
  checkoutDate: z.string().min(10).max(10).optional(),
  legs: z.array(CancelledLeg).max(10).optional(),
  confirmation: z.string().max(80).optional(),
  itineraryNumber: z.string().max(120).optional(),
});
const Recipe = z.object({
  kind: z.literal('recipe'),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
const RestaurantReservation = z.object({
  kind: z.literal('restaurant'),
  name: z.string().min(1).max(120),
  // No forced zone (like flights): a bare reservation time is local to the
  // uploader and gets their offset at filing — never silently UTC.
  dateTime: flightDatetime,
  address: z.string().max(200).optional(),
  partySize: z.number().int().positive().max(50).optional(),
  confirmation: z.string().max(80).optional(),
});
const MovieTicket = z.object({
  kind: z.literal('movie'),
  title: z.string().min(1).max(120),
  venue: z.string().max(120).optional(),
  dateTime: flightDatetime,
  address: z.string().max(200).optional(),
  confirmation: z.string().max(80).optional(),
});
const CalendarEntry = z.object({
  title: z.string().min(1).max(200),
  // Accept bare YYYY-MM-DD or any datetime string; local offset injected at filing time.
  startsAt: z.string().min(1).max(50),
  location: z.string().max(200).optional(),
});
// A school-year / sports-season calendar legitimately has well over a hundred
// dates. 180 covers a full academic year per response; over-cap responses are
// clamped (not rejected) and the calendar filer paginates for the rest.
const CALENDAR_EVENTS_MAX = 180;
const Calendar = z.object({
  kind: z.literal('calendar'),
  events: z.array(CalendarEntry).min(1).max(CALENDAR_EVENTS_MAX),
});
/**
 * Clamp an over-cap calendar payload to CALENDAR_EVENTS_MAX before validation.
 * A long school-year/season calendar can exceed the cap; without this the
 * `.max()` check rejects the whole payload and every event is dropped. Returns
 * the input unchanged for non-calendar / within-cap payloads.
 */
function clampCalendarEvents(parsed: Record<string, unknown>): Record<string, unknown> {
  const events = (parsed as { events?: unknown }).events;
  if (parsed.kind === 'calendar' && Array.isArray(events) && events.length > CALENDAR_EVENTS_MAX) {
    logger.warn('trip classifier: clamping calendar events', {
      got: events.length,
      cap: CALENDAR_EVENTS_MAX,
    });
    return { ...parsed, events: events.slice(0, CALENDAR_EVENTS_MAX) };
  }
  return parsed;
}

const Other = z.object({ kind: z.literal('other') });
const Classification = z.discriminatedUnion('kind', [
  Flight, Hotel, Cancellation, Recipe, RestaurantReservation, MovieTicket, Calendar, Other,
]);
type ClassificationT = z.infer<typeof Classification>;

/** ADR 0158 — the trip classifier's flight/hotel results, reused by the
 *  email → trip-proposal pass (`email/trip-extraction.ts`). */
export type FlightClassification = z.infer<typeof Flight>;
export type HotelClassification = z.infer<typeof Hotel>;
/** ADR 0168 — a cancellation notice, reused the same way. */
export type CancellationClassification = z.infer<typeof Cancellation>;
export type TravelClassification = ClassificationT;

/** ADR 0158 — a classifier leg's `mode` mapped onto `travel_legs.mode`
 *  (coach/bus and anything unrecognised fold to what the column allows). */
export function legMode(m: string | undefined): 'flight' | 'train' | 'ferry' | 'car' | 'other' {
  return m === 'train' || m === 'ferry' || m === 'car' || m === 'other' ? m : 'flight';
}

/**
 * ADR 0177 — a non-invite `.ics`'s own DTSTART carries a real year a ticket
 * body routinely omits ("Thu, Feb 11"). When the classifier's own resolved
 * date agrees with the hint on month+day but disagrees on YEAR, the hint
 * wins — the same class of error ADR 0167 fixed for the "no today anchor"
 * case, now for the "the anchor itself guessed wrong" case. Returns 0 when
 * there's no hint, the classifier's date doesn't parse, or month/day
 * disagree (a genuinely different date — not this ADR's problem to fix).
 */
export function icsYearCorrection(icsDateHint: string | undefined, classifierDate: string): number {
  if (!icsDateHint) return 0;
  const hint = icsDateHint.slice(0, 10);
  const cls = classifierDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hint) || !/^\d{4}-\d{2}-\d{2}$/.test(cls)) return 0;
  if (hint.slice(5) !== cls.slice(5)) return 0; // different month/day — not a year-only miss
  return Number(hint.slice(0, 4)) - Number(cls.slice(0, 4));
}

/** Shift every YYYY-MM-DD... date string's year by `years` (no-op at 0). */
export function shiftYear(dateStr: string, years: number): string {
  if (years === 0 || !/^\d{4}-/.test(dateStr)) return dateStr;
  const y = Number(dateStr.slice(0, 4));
  return `${y + years}${dateStr.slice(4)}`;
}

/** ADR 0158 — one-line booking detail for a leg/stay's `notes`: the
 *  booking-site itinerary/order number, only when it differs from the carrier
 *  PNR already held in `confirmation`. */
export function bookingNotes(opts: {
  itineraryNumber?: string | null;
  confirmation?: string | null;
}): string | undefined {
  const itin = opts.itineraryNumber?.trim();
  if (!itin) return undefined;
  if (itin.toLowerCase() === (opts.confirmation ?? '').trim().toLowerCase()) return undefined;
  return `Itinerary ${itin}`;
}

const ADDRESS_STATE_ZIP = /^[A-Za-z]{2}\s*\d{5}(-\d{4})?$/;
const ADDRESS_STATE_ONLY = /^[A-Za-z]{2}$/;
const ADDRESS_COUNTRY = /^(united states( of america)?|usa|u\.s\.a\.?|u\.s\.?)$/i;
const ADDRESS_ZIP_ONLY = /^\d{4,10}(-\d{4})?$/;

/**
 * Best-effort fallback when the classifier didn't fill `city` (older cached
 * output, or a doc without a clear one): pick the city-looking segment out of
 * a comma-separated postal address. Imperfect by nature — an address whose
 * first segment is a property name rather than a street number can still
 * pick the wrong segment — which is why `city` on the schema is the primary
 * path and this only backstops it.
 */
function cityFromAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(
      (p) =>
        p &&
        !ADDRESS_STATE_ZIP.test(p) &&
        !ADDRESS_STATE_ONLY.test(p) &&
        !ADDRESS_COUNTRY.test(p) &&
        !ADDRESS_ZIP_ONLY.test(p),
    );
  if (parts.length === 0) return undefined;
  const cityPart = /^\d/.test(parts[0]!) ? parts[1] : parts[0];
  return cityPart?.trim() || undefined;
}

/**
 * ADR-worthy fix for a real bug: a hotel-only trip used to be named after the
 * PROPERTY ("Residence Inn by Marriott Vail"), so a cancelled stay rebooked
 * at a different hotel for the same trip minted a brand-new, differently-named
 * trip instead of extending the old one, and the Trips tab read as if two
 * unrelated bookings existed. Prefer the classifier's own `city`, else a
 * best-effort address parse, else fall back to the property name (unchanged
 * old behaviour) when neither is available.
 */
export function hotelTripCity(hotel: { propertyName: string; address?: string; city?: string }): string | undefined {
  return hotel.city?.trim() || cityFromAddress(hotel.address);
}

const CLASSIFY_SYSTEM = [
  'You classify user-forwarded documents into one of eight kinds:',
  '  - flight: a TRANSPORT booking with one or more legs — plane, train, coach/bus,',
  '            or ferry. Airline ticket, boarding pass, Amtrak/rail e-ticket, etc.',
  '  - hotel: a hotel/Airbnb/stay confirmation.',
  '  - cancellation: a notice that a PREVIOUSLY BOOKED hotel stay or flight has been',
  '                  CANCELLED or REFUNDED — "your trip has been cancelled", "your reservation',
  '                  is cancelled", "your flight has been cancelled and refunded". This is NOT',
  '                  the same as a fresh confirmation just because it restates the property/',
  '                  flight/dates — a cancellation email is telling you a booking is now OFF,',
  '                  not making a new one. If the text says "cancelled" or "refund" about an',
  '                  entire stay or flight, classify it as cancellation, never as hotel/flight.',
  '  - restaurant: a restaurant reservation confirmation.',
  '  - movie: a movie or theater ticket confirmation.',
  '  - recipe: a cooking recipe with a title and ingredients.',
  '  - calendar: a school calendar, academic schedule, sports schedule, or any document',
  '              listing multiple named dates or events (e.g. "Spring Break", "Parent Night",',
  '              "Field Trip", "Game vs Lincoln"). Extract each distinct date as a separate entry.',
  '  - other: anything else (invoices, articles, screenshots, etc.).',
  '',
  'Output ONLY a JSON object matching one of these shapes (no prose, no fences):',
  '  flight:     { "kind":"flight",',
  '                "legs": [ { "origin":"<IATA/station/city>", "destination":"<IATA/station/city>",',
  '                             "departAt":"<local time on the ticket, YYYY-MM-DDTHH:MM:SS, NO timezone suffix>",',
  '                             "arriveAt":"<local time on the ticket, YYYY-MM-DDTHH:MM:SS, NO timezone suffix>",',
  '                             "departZone":"<IANA timezone of the ORIGIN, e.g. America/New_York>",',
  '                             "arriveZone":"<IANA timezone of the DESTINATION, e.g. Europe/Lisbon>",',
  '                             "carrier"?:"<airline / rail operator>", "flightNo"?:"<flight or train number>",',
  '                             "mode"?:"flight|train|ferry|car|other" (use "other" for coach/bus; omit for a plane) }, ... ],',
  '                "confirmation"?:"<carrier PNR / record locator, shared by all legs>",',
  '                "itineraryNumber"?:"<the booking-site itinerary or order number, e.g. Expedia Itinerary #, if DIFFERENT from the PNR>",',
  '                "passengerName"?:"<full name on ticket>" }',
  '                Include ALL legs — outbound AND return. One object per segment.',
  '  hotel:      { "kind":"hotel", "propertyName": "<name>", "address"?:"<full address>",',
  '                "city"?:"<just the city, e.g. Vail — used to title the trip>",',
  '                "checkinDate": "<YYYY-MM-DD>", "checkoutDate": "<YYYY-MM-DD>",',
  '                "roomCount"?:<number>, "confirmation"?:"<code>" }',
  '  cancellation: { "kind":"cancellation", "cancelsKind":"hotel"|"flight",',
  '                  // hotel being cancelled — include whichever the email restates:',
  '                  "propertyName"?:"<name>", "checkinDate"?:"<YYYY-MM-DD>", "checkoutDate"?:"<YYYY-MM-DD>",',
  '                  // flight being cancelled — include whichever the email restates:',
  '                  "legs"?: [ { "origin"?:"<code/city>", "destination"?:"<code/city>",',
  '                               "departAt"?:"<local time, YYYY-MM-DDTHH:MM:SS, NO timezone suffix>" } ],',
  '                  "confirmation"?:"<code>", "itineraryNumber"?:"<booking-site itinerary/order number>" }',
  '                Only identify what is being cancelled — never invent new booking detail.',
  '  restaurant: { "kind":"restaurant", "name": "<restaurant name>",',
  '                "dateTime": "<ISO 8601 with offset>", "address"?:"<address>",',
  '                "partySize"?:<number>, "confirmation"?:"<code>" }',
  '  movie:      { "kind":"movie", "title": "<film title>", "venue"?:"<theater name>",',
  '                "dateTime": "<ISO 8601 with offset>", "address"?:"<address>",',
  '                "confirmation"?:"<code>" }',
  '  recipe:     { "kind":"recipe", "title": "<dish name>", "description"?:"<1–2 sentence summary>" }',
  '  calendar:   { "kind":"calendar",',
  '                "events": [ { "title":"<event name>", "startsAt":"<ISO 8601 or YYYY-MM-DD>",',
  '                               "location"?:"<place if mentioned>" }, ... ] }',
  '                Extract up to 40 entries. For all-day dates use YYYY-MM-DD.',
  '                If there are more than 40 events, include the most significant ones.',
  '  other:      { "kind":"other" }',
  'Use the local timezone offset when it can be inferred from the address or airport.',
  'If you cannot extract the required fields confidently, return { "kind": "other" }.',
  '',
  'DATES WITH NO YEAR — a boarding pass, ticket or confirmation almost never prints one,',
  'because the reader already knows "now". You do not: a Today line is given below every',
  'document. Resolve every year-less date against it — if the month-day falls on or after',
  'Today, use Today\'s year; if that month-day has ALREADY PASSED this year, use next year.',
  'Never let a genuinely upcoming booking resolve to a year that makes it read as already',
  'over (a departAt/checkinDate/dateTime/startsAt in the past for a confirmation that reads',
  'as upcoming is a wrong answer, not a cautious one) — same rule the other direction for',
  'anything the text itself says already happened.',
].join('\n');

function buildTextPrompt(filename: string, text: string, today: string): LlmMessage[] {
  return [
    { role: 'system', content: CLASSIFY_SYSTEM },
    {
      role: 'user',
      content: `Today: ${today}\nFile: ${filename}\n\n---\n${text.slice(0, 8_000)}\n---`,
    },
  ];
}

function buildVisionPrompt(filename: string, pageImage: Buffer, today: string): LlmMessage[] {
  const parts: LlmContentPart[] = [
    { type: 'text', text: `Today: ${today}\nFile: ${filename}\n\nThis is a screenshot or scanned PDF. Extract the booking details shown in the image.` },
    { type: 'image', mimeType: 'image/png', base64: pageImage.toString('base64') },
  ];
  return [
    { role: 'system', content: CLASSIFY_SYSTEM },
    { role: 'user', content: parts },
  ];
}

/** Resolve a passenger name against group members; returns userId or null. */
async function resolvePassengerInGroup(
  db: Kysely<DB>,
  groupId: string,
  name: string,
): Promise<string | null> {
  const needle = name.trim().toLowerCase();
  const rows = await db
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .where('group_members.group_id', '=', groupId)
    .select(['users.id', 'users.username', 'users.display_name'])
    .execute();
  // Prefer exact match on display name or username, then substring match.
  const exact = rows.find(
    (r) =>
      r.username.toLowerCase() === needle ||
      (r.display_name?.toLowerCase() ?? '') === needle,
  );
  if (exact) return exact.id;
  const partial = rows.find((r) => {
    const uname = r.username.toLowerCase();
    const dname = r.display_name?.toLowerCase() ?? '';
    return (
      uname.includes(needle) ||
      (dname && dname.includes(needle)) ||
      needle.includes(uname) ||
      (dname && needle.includes(dname))
    );
  });
  return partial?.id ?? null;
}

/**
 * Classify a document (or email body) into a travel/food/media kind. Exported
 * for ADR 0158's email → trip-proposal pass, which reuses the exact classifier
 * rather than teaching the email magics extractor a second trip vocabulary.
 *
 * `today` (YYYY-MM-DD, in the traveller's own zone — ADR 0074's rule) anchors
 * the model's year inference: a ticket almost never prints one ("Thu, Feb
 * 11"), so with no anchor the model guesses, and a wrong guess that lands in
 * the past gets silently discarded by `stageFlight`/`stageHotel`'s own
 * "nothing past ever surfaces" rule (ADR 0158 §4) — a genuinely upcoming
 * booking then produces no trip at all, with nothing logged to say why.
 * Required, not defaulted to the server's own clock: the same reasoning ADR
 * 0098 already established for `nextScanDate`.
 */
export async function classifyTravelDocument(
  filename: string,
  text: string,
  today: string,
  pageImage: Buffer | undefined,
  /** Whose model reads it - the uploader's own key if they have one (ADR 0257). */
  llm: LlmService,
): Promise<ClassificationT | null> {
  const hasText = text.trim().length >= 80;
  if (!hasText && !pageImage) return null;
  const messages = hasText
    ? buildTextPrompt(filename, text, today)
    : buildVisionPrompt(filename, pageImage!, today);
  let raw: string;
  try {
    // Generous ceiling: a full school-year/season calendar (up to
    // CALENDAR_EVENTS_MAX entries) must fit without truncating the JSON.
    raw = await llm.complete(messages, { maxTokens: 8000, temperature: 0 });
  } catch (err) {
    logger.warn('trip classifier llm failed', { err });
    return null;
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const v = Classification.safeParse(clampCalendarEvents(parsed));
  if (!v.success) {
    logger.warn('trip classifier: invalid shape', {
      raw: debugSnippet(raw, 300, env.NODE_ENV),
      issues: v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return null;
  }
  return v.data;
}

type CalendarEntryT = z.infer<typeof CalendarEntry>;

const MAX_CALENDAR_PASSES = 4;

const calendarDateOf = (startsAt: string): string => startsAt.trim().slice(0, 10);
const calendarEventKey = (e: CalendarEntryT): string =>
  `${e.title.trim().toLowerCase()}|${calendarDateOf(e.startsAt)}`;

/**
 * Pagination for long calendars: ask the model for events strictly AFTER
 * `afterDate` (YYYY-MM-DD) so a school-year calendar with more entries than one
 * response can hold is captured in full instead of clamped+dropped. Best-effort
 * — returns [] on any failure; each entry is validated against CalendarEntry.
 */
async function extractMoreCalendarEvents(
  filename: string,
  text: string,
  afterDate: string,
  llm: LlmService,
): Promise<CalendarEntryT[]> {
  if (!text.trim() || !afterDate) return [];
  try {
    const raw = await llm.complete(
      [
        {
          role: 'system',
          content:
            `Extract calendar events from this document whose date is strictly AFTER ${afterDate}. ` +
            `Return ONLY a JSON array of {"title": string, "startsAt": "YYYY-MM-DD", "location"?: string}, ` +
            `in ascending date order, at most ${CALENDAR_EVENTS_MAX}. Return [] if there are none.`,
        },
        { role: 'user', content: `File: ${filename}\n\n---\n${text.slice(0, 16_000)}\n---` },
      ],
      { maxTokens: 8000, temperature: 0 },
    );
    const arr = parseJsonArray(raw);
    if (!arr) return [];
    const out: CalendarEntryT[] = [];
    for (const e of arr) {
      const p = CalendarEntry.safeParse(e);
      if (p.success) out.push(p.data);
    }
    return out.slice(0, CALENDAR_EVENTS_MAX);
  } catch (err) {
    logger.warn('calendar pagination failed', { err, afterDate });
    return [];
  }
}

async function saveRecipe(
  db: Kysely<DB>,
  groupId: string,
  uploadedBy: string,
  recipe: z.infer<typeof Recipe>,
): Promise<void> {
  const save = await createSave(db, {
    groupId,
    createdBy: uploadedBy,
    kind: 'note',
    title: recipe.title,
    note: recipe.description,
    tags: ['recipe'],
  });
  sseHub.broadcast(groupId, SSE.saveAdded, save);
}

/**
 * ADR 0190 — a flight's trip is decided by who is on it, chained by city
 * through their own other legs (`findTripForTraveler`) — never by which
 * dates happen to overlap. There is no live chat turn to ask in here (this
 * runs fire-and-forget off an attachment), so an unidentified passenger
 * gets the safe default: its own standalone trip, `needsPassenger: true` so
 * the caller can say so — correctable later with the existing
 * `set_trip_passengers`/`merge_trips` tools rather than guessed now.
 *
 * The classifier leaves ticket times BARE ("...T01:50:00" + an airport IANA
 * zone) and the caller zones them before storing, so the legs are zoned here
 * the same way before matching: `findTripForTraveler` compares real instants,
 * and a bare string would be read in the server's zone — hours off whatever
 * is already stored, so a re-upload of the same ticket would never match.
 */
export async function ensureTripForFlight(
  db: Kysely<DB>,
  groupId: string,
  uploadedBy: string,
  flight: z.infer<typeof Flight>,
  personaId: string | null,
  passengerName: string | undefined,
  zoning: { offsetMinutes: number | undefined; tz: string | null | undefined },
): Promise<{ tripId: string; needsPassenger: boolean }> {
  const allDates = flight.legs.flatMap((l) => [l.departAt.slice(0, 10), l.arriveAt.slice(0, 10)]);
  const windowStart = allDates.reduce((a, b) => (a < b ? a : b));
  const windowEnd = allDates.reduce((a, b) => (a > b ? a : b));

  // Always asked, named or not: the same physical flight as one already on a
  // trip joins it whoever is on it (ADR 0190's companions), and that needs no
  // passenger. Without one, only that (and an empty trip shell) can match.
  const matched = await findTripForTraveler(db, {
    userId: uploadedBy,
    personaId,
    passengerName: personaId ? null : passengerName,
    legs: flight.legs.map((l) => ({
      origin: l.origin,
      destination: l.destination,
      departAt: legDatetime(l.departAt, l.origin, l.departZone, zoning.offsetMinutes, zoning.tz),
      arriveAt: legDatetime(l.arriveAt, l.destination, l.arriveZone, zoning.offsetMinutes, zoning.tz),
    })),
    confirmation: flight.confirmation,
    preferGroupId: groupId,
  });
  if (matched) {
    sseHub.broadcast(groupId, SSE.tripUpdated, matched);
    return { tripId: matched.id, needsPassenger: !personaId && !passengerName };
  }

  const firstLeg = flight.legs[0];
  const lastLeg = flight.legs[flight.legs.length - 1];
  const created = await createTrip(db, {
    groupId,
    createdBy: uploadedBy,
    name: `Trip to ${firstLeg.destination}`,
    destination: lastLeg.destination,
    startDate: windowStart,
    endDate: windowEnd,
    participantIds: [],
  });
  sseHub.broadcast(groupId, SSE.tripUpdated, created);
  return { tripId: created.id, needsPassenger: !personaId && !passengerName };
}

/**
 * ADR 0190 — a hotel stay carries no traveler of its own, so it's matched by
 * PLACE AND DATES against this group's trips (neither alone).
 */
async function ensureTripForHotel(
  db: Kysely<DB>,
  groupId: string,
  uploadedBy: string,
  hotel: z.infer<typeof Hotel>,
): Promise<string> {
  const city = hotelTripCity(hotel);
  const cityMatch = await findTripForStay(db, {
    userId: uploadedBy,
    groupId,
    city: city ?? hotel.address ?? hotel.propertyName,
    checkinDate: hotel.checkinDate,
    checkoutDate: hotel.checkoutDate,
  });
  if (cityMatch) {
    sseHub.broadcast(groupId, SSE.tripUpdated, cityMatch);
    return cityMatch.id;
  }
  const created = await createTrip(db, {
    groupId,
    createdBy: uploadedBy,
    name: city ? `Trip to ${city}` : hotel.propertyName,
    destination: city ?? hotel.address ?? hotel.propertyName,
    startDate: hotel.checkinDate,
    endDate: hotel.checkoutDate,
    participantIds: [],
  });
  sseHub.broadcast(groupId, SSE.tripUpdated, created);
  return created.id;
}

async function postIndexed(
  db: Kysely<DB>,
  groupId: string,
  body: string,
  attachmentId: string,
): Promise<void> {
  const row: MessagesTable = {
    id: newId('m'),
    group_id: groupId,
    sender_id: null,
    kind: 'bot',
    body,
    attachment_id: attachmentId,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 0,
  };
  await db.insertInto('messages').values(row).execute();
  sseHub.broadcast(groupId, SSE.message, rowToMessage(row));
}

/**
 * Convert a raw date/datetime string from the LLM to a valid ISO 8601 datetime.
 * Bare YYYY-MM-DD dates become local midnight using the uploader's offset so
 * that "Spring Break Apr 1" stores as Apr 1 in the user's timezone, not UTC midnight.
 */
/** Format minutes east of UTC as "±HH:MM". */
function offsetString(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * UTC offset (minutes) of an IANA timezone at a given wall-clock time, DST-aware.
 * Returns null for an unknown/invalid zone. Read at the instant the wall time
 * names (`zonedWallToUtcMs`); reading it at the wall time taken as UTC gave a
 * departure hours after a clock change the old offset.
 */
function zoneOffsetMinutes(wallNoZone: string, tz: string): number | null {
  try {
    const naive = Date.parse(`${wallNoZone}Z`);
    if (Number.isNaN(naive)) return null;
    return Math.round((naive - zonedWallToUtcMs(wallNoZone, tz)) / 60000);
  } catch {
    return null; // invalid IANA zone
  }
}

/**
 * Anchor a local ticket time to its airport's timezone. Normalizes the bare
 * datetime, then appends the zone's DST-correct offset. Falls back to the
 * uploader's zone (toLocalDatetime) when the airport's own zone is
 * missing/invalid — `fallbackTz` (the uploader's IANA zone, when known) is
 * preferred there over `fallbackOffsetMinutes` for the same reason `tz` is
 * preferred here: a flat offset is only correct for whichever date it was
 * measured on, and a ticket months out routinely lands on the other side of
 * a DST boundary from "today."
 */
export function zonedDatetime(
  raw: string,
  tz: string | undefined,
  fallbackOffsetMinutes: number | undefined,
  fallbackTz?: string | null,
): string {
  const s = raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2');
  // Already carries a zone, or no IANA zone to apply → use the offset path.
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(s) || !tz) return toLocalDatetime(s, fallbackOffsetMinutes, fallbackTz);
  const withSecs = s.replace(/T(\d{2}:\d{2})$/, 'T$1:00');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(withSecs)) {
    return toLocalDatetime(s, fallbackOffsetMinutes, fallbackTz); // date-only or odd shape
  }
  const off = zoneOffsetMinutes(withSecs, tz);
  return off === null
    ? toLocalDatetime(s, fallbackOffsetMinutes, fallbackTz)
    : `${withSecs}${offsetString(off)}`;
}

/**
 * One end of a travel leg, anchored to the clock of the place it happens at.
 *
 * The zone comes from the airport itself when the table knows it, and only
 * then from what the model said: `departZone`/`arriveZone` are optional in the
 * classifier's reply, and when one was missing the time fell back to the
 * READER's zone — a 1:50am Delhi departure filed as 1:50am New York.
 *
 * A value that already carries an offset is re-anchored only when that offset
 * is the reader's own. That is the one mistake a model makes here (the chat
 * prompt tells it to stamp the user's offset on every datetime); any other
 * offset was chosen on purpose and is left alone.
 *
 * "The reader's own" is their offset on the leg's date OR their offset today
 * (`readerOffsetMinutes`). A model stamps the one it was shown, which is
 * today's: an 8:15 Newark departure on 20 November, read on 12 October, came
 * back as 08:15-04:00 and was left alone because New York's offset on that
 * date is -05:00 (ADR 0244).
 */
export function legDatetime(
  raw: string,
  place: string | null | undefined,
  statedZone: string | undefined,
  readerOffsetMinutes: number | undefined,
  readerTz?: string | null,
): string {
  const stated = statedZone && zoneOffsetMinutes('2026-01-01T00:00:00', statedZone) !== null ? statedZone : undefined;
  const tz = airportTimeZone(place) ?? stated;
  const anchored = zonedDatetime(raw, tz, readerOffsetMinutes, readerTz);
  if (!tz) return anchored;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-])(\d{2}):?(\d{2})$/.exec(anchored);
  if (!m) return anchored;
  const wall = m[1]!;
  const carried = (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
  const placeOffset = zoneOffsetMinutes(wall, tz);
  if (placeOffset === null || carried === placeOffset) return anchored;
  const readerOffset = (readerTz ? zoneOffsetMinutes(wall, readerTz) : null) ?? readerOffsetMinutes;
  return carried === readerOffset || carried === readerOffsetMinutes
    ? `${wall}${offsetString(placeOffset)}`
    : anchored;
}

/**
 * A time AT a place, on that place's clock (ADR 0245): a dinner reservation
 * in Denver at 7:00 is 7:00 in Denver whoever booked it and wherever they
 * were. `place` is whatever was written: a city, an airport, a street address.
 *
 * Same rule as a travel leg (`legDatetime`): a bare time, or one carrying the
 * reader's own offset, is put on the place's clock for that date; an offset
 * that is neither was chosen on purpose and is kept.
 *
 * `zone` is null when the place is not in the table. The time is then read
 * on the READER's clock for that date, which is the only clock known, and
 * the caller must say so rather than present it as local time there.
 */
export function placeDatetime(
  raw: string,
  place: string | null | undefined,
  readerOffsetMinutes: number | undefined,
  readerTz?: string | null,
): { at: string; zone: string | null } {
  const zone = placeTimeZone(place);
  if (!zone) return { at: toLocalDatetime(raw, readerOffsetMinutes, readerTz), zone: null };
  return { at: legDatetime(raw, undefined, zone, readerOffsetMinutes, readerTz), zone };
}

/**
 * `tz` (the uploader's/traveller's own IANA zone, when known) is preferred
 * over the flat `tzOffsetMinutes` fallback — that number is a "now" snapshot
 * (see `tzToOffsetMinutes`), so a restaurant/movie/calendar-entry date
 * months out used to silently get today's DST side instead of its own.
 * `tzOffsetMinutes` stays as the true last resort for callers with no zone
 * name at all (e.g. a browser-reported raw offset — `routes/files.ts`).
 */
export function toLocalDatetime(
  raw: string,
  tzOffsetMinutes: number | undefined,
  tz?: string | null,
): string {
  const s = raw.trim();
  const resolvedOffset = (localNoZone: string): string => {
    const off = tz ? zoneOffsetMinutes(localNoZone, tz) : null;
    return offsetString(off ?? tzOffsetMinutes ?? 0);
  };
  // Date-only → local midnight in the traveller's timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00${resolvedOffset(`${s}T00:00:00`)}`;
  let d = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2');
  d = d.replace(/T(\d{2}:\d{2})(([+-]\d{2}:?\d{2})|Z|$)/, 'T$1:00$2');
  // Bare datetime with no zone → interpret in the traveller's timezone, not
  // UTC. A value that already carries Z or an explicit offset is left as-is.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(d)) return `${d}${resolvedOffset(d)}`;
  return d;
}

/**
 * Fire-and-forget: classify a just-indexed group-scope attachment and, if it
 * looks like a flight or hotel confirmation, auto-invoke the matching trip
 * tool. Posts a short bot message announcing what was indexed.
 */
export async function classifyAndAutoFileAttachment(
  db: Kysely<DB>,
  opts: {
    attachmentId: string;
    groupId: string;
    uploadedBy: string;
    filename: string;
    extractedText: string;
    pageImage?: Buffer;
    /** UTC offset in minutes (e.g. -300 for EST, +330 for IST). Used to
     *  convert bare YYYY-MM-DD calendar dates to local midnight instead of UTC.
     *  Last-resort fallback only — see `uploaderTz`, which is DST-correct for
     *  the DOCUMENT'S OWN dates and is preferred whenever known. A caller with
     *  only a raw browser-reported offset (no zone name) still works via this. */
    uploaderTzOffsetMinutes?: number;
    /** The uploader's IANA zone (`users.last_tz`), when known — resolved
     *  fresh below when omitted. Preferred over `uploaderTzOffsetMinutes`
     *  for every date in this document, since that number is only a "now"
     *  snapshot and a flight/reservation date is routinely on the other
     *  side of a DST boundary from whenever this runs. */
    uploaderTz?: string | null;
    /** Set when the file was copied out of an email (ADR 0071), as
     *  `email_threads.id`. Such a file is filed under the email path's rules:
     *  nothing from Trash/Spam/archived mail or a dangerous sender, nothing
     *  already past (ADR 0158 §4), and events on its mailbox's calendar
     *  (ADR 0312). A file a person uploads keeps filing what it says. */
    originEmailThreadId?: string;
  },
): Promise<boolean> {
  // ADR 0283 — the document goes to the model; not before the uploader agreed.
  if (!(await canUseAi(db, opts.uploadedBy))) return false;
  // Returns whether this doc was recognized + auto-filed (flight, hotel,
  // restaurant, recipe, movie, calendar). When true, the caller skips the
  // image content classifier so it doesn't re-propose the same items (e.g. a
  // flight itinerary becoming both a trip AND duplicate calendar events).
  // Non-web ingest paths carry no browser timezoneOffset — the uploader's
  // last-known zone beats a silent UTC fallback. The zone NAME is fetched
  // whenever the caller didn't already supply one (even if it DID supply a
  // raw minutes offset — routes/files.ts's browser-reported number has no
  // zone identity, but a real one is still worth having for DST-correctness
  // on every date in this document).
  if (opts.uploaderTz === undefined) {
    const uploader = await db
      .selectFrom('users')
      .select('last_tz')
      .where('id', '=', opts.uploadedBy)
      .executeTakeFirst();
    opts.uploaderTz = uploader?.last_tz ?? null;
    if (opts.uploaderTzOffsetMinutes === undefined) {
      const minutes = uploader?.last_tz ? tzToOffsetMinutes(uploader.last_tz) : null;
      if (minutes !== null) opts.uploaderTzOffsetMinutes = minutes;
    }
  }
  const today = toLocalDatetime(new Date().toISOString(), opts.uploaderTzOffsetMinutes, opts.uploaderTz).slice(0, 10);
  // Asked before the model call: an email this cannot file from costs nothing.
  let emailCopy: { calendarId: string | null } | null = null;
  if (opts.originEmailThreadId) {
    const gate = await emailCopyFiling(db, opts.uploadedBy, opts.originEmailThreadId);
    if (!gate.file) {
      logger.info('email attachment not auto-filed', {
        attachmentId: opts.attachmentId,
        reason: gate.reason,
      });
      return false;
    }
    emailCopy = { calendarId: gate.calendarId };
  }
  const fromEmailInPast = (iso: string): boolean =>
    emailCopy !== null && isBeforeDay(iso, today, opts.uploaderTz);
  const emailCalendarId = emailCopy?.calendarId ?? undefined;
  const llm = await getLlmForUser(db, opts.uploadedBy, 'trip_classify');
  const result = await classifyTravelDocument(
    opts.filename,
    opts.extractedText,
    today,
    opts.pageImage,
    llm,
  );
  if (!result || result.kind === 'other') return false;

  // ADR 0168 — a cancellation notice never auto-files as a booking (the
  // `else` branch below assumes non-flight means hotel, which a cancellation
  // is not). The email-body path (`email/trip-extraction.ts`) applies a
  // cancellation directly; an uploaded screenshot of one is indexed as a
  // document only, same as `other`.
  if (result.kind === 'cancellation') return false;

  if (result.kind === 'recipe') {
    try {
      await saveRecipe(db, opts.groupId, opts.uploadedBy, result);
      await postIndexed(
        db,
        opts.groupId,
        `📎 Indexed — "${result.title}" recipe. Saved as note.`,
        opts.attachmentId,
      );
    } catch (err) {
      logger.error('recipe auto-save failed', { err, attachmentId: opts.attachmentId });
    }
    return true;
  }

  if (result.kind === 'restaurant') {
    try {
      // ADR 0245 - the table is booked on the restaurant's clock.
      const localDateTime = placeDatetime(
        result.dateTime,
        result.address,
        opts.uploaderTzOffsetMinutes,
        opts.uploaderTz,
      ).at;
      if (fromEmailInPast(localDateTime)) return true;
      const when = localDateTime.slice(0, 10);
      const tripMatch = await findTripByDateRange(db, opts.uploadedBy, when, when, opts.groupId);
      if (tripMatch) {
        const res = await addReservation(db, {
          tripId: tripMatch.id,
          kind: 'restaurant',
          name: result.name,
          dateTime: localDateTime,
          address: result.address,
          confirmation: result.confirmation,
          notes: result.partySize ? `Party of ${result.partySize}` : undefined,
          sourceRawContext: opts.attachmentId,
        });
        sseHub.broadcast(opts.groupId, SSE.reservationCreated, res);
        await postIndexed(db, opts.groupId,
          `📎 Indexed — ${result.name} · ${when}${result.partySize ? ` · party of ${result.partySize}` : ''}. Added to trip.`,
          opts.attachmentId);
      } else {
        const event = await createEvent(db, {
          groupId: opts.groupId,
          title: result.name,
          location: result.address,
          startsAt: localDateTime,
          createdBy: opts.uploadedBy,
          googleCalendarId: emailCalendarId,
        });
        sseHub.broadcast(opts.groupId, SSE.eventCreated, event);
        await postIndexed(db, opts.groupId,
          `📎 Indexed — ${result.name} · ${when}${result.partySize ? ` · party of ${result.partySize}` : ''}. Added to events.`,
          opts.attachmentId);
      }
    } catch (err) {
      logger.error('restaurant auto-file failed', { err, attachmentId: opts.attachmentId });
    }
    return true;
  }

  if (result.kind === 'movie') {
    try {
      const localDateTime = placeDatetime(
        result.dateTime,
        result.address ?? result.venue,
        opts.uploaderTzOffsetMinutes,
        opts.uploaderTz,
      ).at;
      if (fromEmailInPast(localDateTime)) return true;
      const when = localDateTime.slice(0, 10);
      const venue = result.venue ?? result.address;
      const tripMatch = await findTripByDateRange(db, opts.uploadedBy, when, when, opts.groupId);
      if (tripMatch) {
        const res = await addReservation(db, {
          tripId: tripMatch.id,
          kind: 'event',
          name: result.title,
          dateTime: localDateTime,
          address: result.address ?? result.venue,
          confirmation: result.confirmation,
          sourceRawContext: opts.attachmentId,
        });
        sseHub.broadcast(opts.groupId, SSE.reservationCreated, res);
        await postIndexed(db, opts.groupId,
          `📎 Indexed — "${result.title}"${venue ? ` · ${venue}` : ''} · ${when}. Added to trip.`,
          opts.attachmentId);
      } else {
        const event = await createEvent(db, {
          groupId: opts.groupId,
          title: result.title,
          location: venue,
          startsAt: localDateTime,
          createdBy: opts.uploadedBy,
          googleCalendarId: emailCalendarId,
        });
        sseHub.broadcast(opts.groupId, SSE.eventCreated, event);
        await postIndexed(db, opts.groupId,
          `📎 Indexed — "${result.title}"${venue ? ` · ${venue}` : ''} · ${when}. Added to events.`,
          opts.attachmentId);
      }
    } catch (err) {
      logger.error('movie auto-file failed', { err, attachmentId: opts.attachmentId });
    }
    return true;
  }

  if (result.kind === 'calendar') {
    try {
      // Collect all events, paginating when a batch fills the cap so a long
      // school-year calendar is captured in full (not silently truncated).
      const all: CalendarEntryT[] = [];
      const seen = new Set<string>();
      const addBatch = (batch: CalendarEntryT[]): number => {
        let n = 0;
        for (const e of batch) {
          const k = calendarEventKey(e);
          if (seen.has(k)) continue;
          seen.add(k);
          all.push(e);
          n++;
        }
        return n;
      };
      addBatch(result.events);
      let lastFull = result.events.length >= CALENDAR_EVENTS_MAX;
      for (let pass = 0; lastFull && opts.extractedText && pass < MAX_CALENDAR_PASSES; pass++) {
        const afterDate = all.reduce((m, e) => {
          const d = calendarDateOf(e.startsAt);
          return d > m ? d : m;
        }, '');
        const more = await extractMoreCalendarEvents(opts.filename, opts.extractedText, afterDate, llm);
        const fresh = addBatch(more);
        lastFull = more.length >= CALENDAR_EVENTS_MAX;
        if (fresh === 0) break; // no new events — stop paginating
      }

      let added = 0;
      let already = 0;
      for (const entry of all) {
        // Date-only school entries become all-day events → free, so they don't
        // clutter free/busy (ADR 0040); entries with a time stay timed. All-day
        // uses the floating-midnight convention (no offset) the rest of the
        // system expects for all_day rows.
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(entry.startsAt.trim());
        const startsAt = dateOnly
          ? `${entry.startsAt.trim()}T00:00:00`
          : toLocalDatetime(entry.startsAt, opts.uploaderTzOffsetMinutes, opts.uploaderTz);
        if (fromEmailInPast(startsAt)) continue;
        // The same file uploaded again files only what is new. A timed entry
        // folds in createEvent (ADR 0223); an all-day one is checked here.
        if (dateOnly && (await findSameAllDayEvent(db, opts.groupId, entry.title, startsAt.slice(0, 10)))) {
          already++;
          continue;
        }
        const event = await createEvent(db, {
          groupId: opts.groupId,
          title: entry.title,
          location: entry.location,
          startsAt,
          allDay: dateOnly,
          createdBy: opts.uploadedBy,
          sourceRawContext: opts.attachmentId,
          googleCalendarId: emailCalendarId,
        });
        if (event.merged) {
          already++;
          continue;
        }
        sseHub.broadcast(opts.groupId, SSE.eventCreated, event);
        added++;
      }
      const alreadyNote = already > 0 ? ` ${already} already on the calendar.` : '';
      // An emailed calendar that is all history: filed nothing, says nothing.
      if (added === 0 && already === 0 && emailCopy) return true;
      await postIndexed(
        db,
        opts.groupId,
        `📎 Indexed — "${opts.filename}". Added ${added} calendar event${added === 1 ? '' : 's'}.${alreadyNote}`,
        opts.attachmentId,
      );
    } catch (err) {
      logger.error('calendar auto-file failed', { err, attachmentId: opts.attachmentId });
    }
    return true;
  }

  try {
    if (result.kind === 'flight') {
      // ADR 0158 §4 - from email, a leg that already flew is history: a
      // finished trip files nothing, one under way keeps the legs ahead.
      // Filtered before the trip shell is made, or an empty trip appears.
      const booking = emailCopy
        ? {
            ...result,
            legs: result.legs.filter(
              (fl) => !fromEmailInPast(legDatetime(fl.departAt, fl.origin, fl.departZone, opts.uploaderTzOffsetMinutes, opts.uploaderTz)),
            ),
          }
        : result;
      if (booking.legs.length === 0) return true;
      const resolvedPersonaId = booking.passengerName
        ? await resolvePassengerInGroup(db, opts.groupId, booking.passengerName)
        : null;
      // If we can't resolve the passenger to a group member, store the raw name
      // on the leg instead of falling back to the uploader (which is wrong).
      const passengerName = !resolvedPersonaId ? booking.passengerName ?? undefined : undefined;
      let addedLegs = 0;
      let dupLegs = 0;
      let movedLegs = 0;
      // The same flight already on one of the uploader's trips from a booking
      // with no reference (made in chat) is updated, not added a second time.
      // Checked before the trip shell, so a fully matched ticket makes none.
      const sameFlightLegs: typeof booking.legs = [];
      for (const fl of booking.legs) {
        const same = await rescheduleSameFlight(db, opts.uploadedBy, {
          mode: legMode(fl.mode),
          origin: fl.origin,
          destination: fl.destination,
          departAt: legDatetime(fl.departAt, fl.origin, fl.departZone, opts.uploaderTzOffsetMinutes, opts.uploaderTz),
          arriveAt: legDatetime(fl.arriveAt, fl.destination, fl.arriveZone, opts.uploaderTzOffsetMinutes, opts.uploaderTz),
          carrier: fl.carrier,
          flightNo: fl.flightNo,
          confirmation: booking.confirmation,
          notes: bookingNotes(booking) ?? null,
          personaId: resolvedPersonaId,
          passengerName: passengerName ?? null,
        });
        if (same.status === 'moved') movedLegs++;
        else if (same.status === 'unchanged') dupLegs++;
        else sameFlightLegs.push(fl);
      }
      if (sameFlightLegs.length === 0) {
        await postIndexed(
          db,
          opts.groupId,
          movedLegs > 0
            ? '📎 Indexed. That flight was already on your trips, so I updated its time instead of adding it again.'
            : '📎 Indexed. That flight is already on your trips and calendar, so I kept the file but did not add it again.',
          opts.attachmentId,
        );
        return true;
      }
      booking.legs = sameFlightLegs;
      const { tripId, needsPassenger } = await ensureTripForFlight(
        db, opts.groupId, opts.uploadedBy, booking, resolvedPersonaId, passengerName,
        { offsetMinutes: opts.uploaderTzOffsetMinutes, tz: opts.uploaderTz },
      );
      const legInputs = booking.legs.map((fl) => ({
        tripId,
        personaId: resolvedPersonaId ?? undefined,
        passengerName,
        mode: legMode(fl.mode),
        origin: fl.origin,
        destination: fl.destination,
        // Each ticket time is local to its airport: departure in the origin's
        // timezone, arrival in the destination's. Anchor with the airport's
        // own zone (DST-correct), falling back to the uploader's offset.
        departAt: legDatetime(fl.departAt, fl.origin, fl.departZone, opts.uploaderTzOffsetMinutes, opts.uploaderTz),
        arriveAt: legDatetime(fl.arriveAt, fl.destination, fl.arriveZone, opts.uploaderTzOffsetMinutes, opts.uploaderTz),
        carrier: fl.carrier,
        flightNo: fl.flightNo,
        confirmation: booking.confirmation,
        notes: bookingNotes(booking),
        sourceDocId: opts.attachmentId,
      }));
      // Same booking reference: pair this document's legs with the ones
      // already on the trip. Unchanged legs stay, a moved or re-routed flight
      // (and its calendar event) is updated in place instead of duplicated,
      // and only legs with no counterpart go on to be added.
      const rec = await reconcileBookedLegs(db, {
        tripId,
        confirmation: booking.confirmation,
        personaId: resolvedPersonaId,
        passengerName,
        legs: legInputs,
        allowRouteChange: true,
      });
      dupLegs += rec.unchanged.length;
      movedLegs += rec.moved.length + rec.replaced.length;
      for (const legInput of rec.remaining) {
        // Don't re-add a leg already in this trip (same flight + passenger) —
        // a re-upload of the same itinerary should not duplicate it.
        if (await findExistingLeg(db, legInput)) {
          dupLegs++;
          continue;
        }
        const leg = await addTravelLeg(db, legInput);
        sseHub.broadcast(opts.groupId, SSE.travelLegCreated, leg);
        addedLegs++;
      }
      const first = booking.legs[0];
      const last = booking.legs[booking.legs.length - 1];
      const summary = booking.legs.length === 1
        ? `${first.origin}→${first.destination} · ${first.departAt.slice(0, 10)}`
        : `${first.origin}→${first.destination}→${last.destination} · ${booking.legs.length} legs`;
      const msg =
        movedLegs > 0
          ? `📎 Indexed — ${summary}. Same booking as one already on your trips, so I updated the flight time instead of adding a duplicate.`
          : addedLegs === 0 && dupLegs > 0
            ? `📎 Indexed — ${summary}. Already in your trips and calendar — I kept the file but didn't add a duplicate.`
            : dupLegs > 0
              ? `📎 Indexed — ${summary}. Added ${addedLegs} new; ${dupLegs} already present.`
              : `📎 Indexed — ${summary}. Added to trip.`;
      // ADR 0190 — no passenger name on the document means this landed on its
      // own new trip rather than a guessed match; say so, since the fix
      // (set_trip_passengers, or merge_trips if it should join another trip)
      // needs a person to say who was traveling.
      await postIndexed(
        db,
        opts.groupId,
        needsPassenger && addedLegs > 0
          ? `${msg} Who's on this? Tell me and I can attach it to the right trip.`
          : msg,
        opts.attachmentId,
      );
    } else {
      // ADR 0158 §4 - a stay from email that already ended is history.
      if (fromEmailInPast(result.checkoutDate)) return true;
      const tripId = await ensureTripForHotel(db, opts.groupId, opts.uploadedBy, result);
      const accomInput = {
        tripId,
        propertyName: result.propertyName,
        address: result.address,
        checkinDate: result.checkinDate,
        checkoutDate: result.checkoutDate,
        roomCount: result.roomCount,
        confirmation: result.confirmation,
        sourceDocId: opts.attachmentId,
      };
      const summary = `${result.propertyName} · ${result.checkinDate}–${result.checkoutDate}`;
      const dupAccom = await findExistingAccommodation(db, accomInput);
      if (dupAccom) {
        await postIndexed(
          db,
          opts.groupId,
          `📎 Indexed — ${summary}. Already in your trips — I kept the file but didn't add a duplicate.`,
          opts.attachmentId,
        );
      } else {
        const accom = await addAccommodation(db, accomInput);
        sseHub.broadcast(opts.groupId, SSE.accommodationCreated, accom);
        await postIndexed(db, opts.groupId, `📎 Indexed — ${summary}. Added to trip.`, opts.attachmentId);
      }
    }
  } catch (err) {
    logger.error('trip auto-file failed', { err, attachmentId: opts.attachmentId });
  }
  // flight/hotel branch — recognized as travel, so skip the content classifier.
  return true;
}

export const __testing = {
  toLocalDatetime,
  zonedDatetime,
  clampCalendarEvents,
  CALENDAR_EVENTS_MAX,
  buildTextPrompt,
  CLASSIFY_SYSTEM,
};
