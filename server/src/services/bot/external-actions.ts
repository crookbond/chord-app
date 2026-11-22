/**
 * PR-F — Deep-link suggestions.
 *
 * Maps a high-level intent (book a restaurant, find a flight, find a hotel,
 * find an activity) plus structured query fields to a third-party deep-link
 * URL. The bot calls `suggest_external_action` with the intent + query and
 * the executor renders a tappable card with this URL.
 *
 * Each builder is a pure function. URL parameters are encoded via
 * URLSearchParams so query values with spaces / unicode round-trip safely.
 *
 * Affiliate / referral codes intentionally omitted — these are demo links.
 * Add them later in one place per platform.
 */

import { flightTrackingUrl } from '@chord/kernel';

import { trackingForStatedNumber } from '@/services/email/tracking.js';

export type ExternalActionKind =
  | 'restaurant'
  | 'takeout'
  | 'recipe'
  | 'find_person'
  | 'map'
  | 'flight'
  /** ADR 0138 — track a flight the user is already booked on. Distinct from
   *  `flight`, which searches for one to buy. */
  | 'flight_status'
  /** Track a parcel on its carrier's own page (UPS, USPS, FedEx, …). */
  | 'package_tracking'
  | 'hotel'
  | 'activity'
  /** ADR 0262 — the catch-all: a Google search (web, images, videos, news,
   *  shopping) for anything none of the other kinds is about. */
  | 'search';

export type SearchType = 'web' | 'images' | 'videos' | 'news' | 'shopping';

export interface ExternalActionQuery {
  // Restaurant
  restaurantName?: string;
  partySize?: number;
  dateTime?: string;          // ISO 8601
  // Hotel + activity
  city?: string;
  checkinDate?: string;       // YYYY-MM-DD
  checkoutDate?: string;      // YYYY-MM-DD
  // Flight
  origin?: string;            // IATA code or city
  destination?: string;       // IATA code or city
  departDate?: string;        // YYYY-MM-DD
  returnDate?: string;        // YYYY-MM-DD
  // Activity
  activity?: string;
  /** ADR 0138 — the designator for `flight_status`: "UA512" / "UA 512". */
  flightNumber?: string;
  /** `flight_status` — whose flight: the executor finds that person's
   *  soonest leg, so the model never has to produce the number itself. */
  passengerName?: string;
  /** `package_tracking` — the number the user gave. */
  trackingNumber?: string;
  /** `package_tracking` — the carrier, when the user named one. */
  carrier?: string;
  /** Free-text lookup term used by `find_person`, `map` and `search`. */
  q?: string;
  /** `search` — which Google tab to open. Default `web`. */
  searchType?: SearchType;
}

export interface BuiltAction {
  url: string;
  /**
   * Optional native-app deep link (custom scheme). Set when a documented
   * or known-working scheme exists for the target app (e.g. `findmy://`).
   * The Chord mobile app tries this first; bridged surfaces ignore it.
   */
  appUrl?: string;
  /** Provider name shown to the user, e.g. "Google Maps". */
  provider: string;
  /**
   * Short dynamic suffix appended to the bot's `label` for display. For a
   * restaurant: "Antico Ristorante · 4 guests · Sat 7pm". Empty if there are
   * no usable query fields beyond the kind.
   */
  meta: string;
}

const ymd = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  return s.length > 10 ? s.slice(0, 10) : s;
};

function buildRestaurant(q: ExternalActionQuery): BuiltAction {
  const metaParts: string[] = [];
  if (q.restaurantName) metaParts.push(q.restaurantName);
  if (q.partySize) metaParts.push(`${q.partySize} guest${q.partySize === 1 ? '' : 's'}`);
  if (q.dateTime) metaParts.push(formatHumanDateTime(q.dateTime));

  // Always Google Maps (ADR 0153). A NAMED restaurant opens its own place
  // page, whose "Reserve a table" button routes to whatever system it uses
  // (OpenTable / Resy / SevenRooms / Reserve with Google). With no name it
  // opens a "restaurants in <city>" search — the same unbiased inventory,
  // where each place page still carries that reservation button. An OpenTable
  // discovery search would show only OpenTable-partner restaurants, the exact
  // bias the named case exists to avoid. `partySize` / `dateTime` have no Maps
  // URL param, so they ride `meta` only.
  const term = q.restaurantName
    ? [q.restaurantName, q.city].filter(Boolean).join(' ')
    : ['restaurants', q.city ? `in ${q.city}` : ''].filter(Boolean).join(' ');
  const params = new URLSearchParams({ api: '1', query: term });
  return {
    url: `https://www.google.com/maps/search/?${params.toString()}`,
    provider: 'Google Maps',
    meta: metaParts.join(' · '),
  };
}

function buildFindPerson(q: ExternalActionQuery): BuiltAction {
  // Apple Find My web app — the universal fallback. On iOS this URL
  // will offer to launch the native app; on web/Android it opens the
  // iCloud surface. We don't pass the person name in the URL because
  // Find My doesn't accept a search query — the name lives in `meta`
  // so the card subtitle reads "Looking for Alice".
  const url = 'https://www.icloud.com/find/';
  // `findmy://` is undocumented but lands on the Find My app on modern
  // iOS. There's no public surface for passing the person name, so the
  // card subtitle/meta keep that hint. Required Info.plist entry:
  // `LSApplicationQueriesSchemes: ['findmy']` (see mobile/app.json).
  const appUrl = 'findmy://';
  const name = q.q ?? q.restaurantName;
  return {
    url,
    appUrl,
    provider: 'Find My',
    meta: name ? `Looking for ${name}` : '',
  };
}

function buildMap(q: ExternalActionQuery): BuiltAction {
  // Google Maps universal search URL — works on iOS (offers Maps app),
  // Android (offers Maps app), and web. `api=1` is the documented
  // stable shape; `query` is the free-text place lookup.
  const term = q.q ?? q.restaurantName ?? q.activity ?? q.city ?? '';
  const params = new URLSearchParams();
  params.set('api', '1');
  if (term) params.set('query', term);
  const url = `https://www.google.com/maps/search/?${params.toString()}`;
  return {
    url,
    provider: 'Google Maps',
    meta: term ? term : '',
  };
}

function buildTakeout(q: ExternalActionQuery): BuiltAction {
  // DoorDash search. Path-segment search is the most reliable deep link;
  // empty query falls back to the home page (which prompts for address).
  const term = q.restaurantName ?? q.activity ?? q.city ?? '';
  const slug = encodeURIComponent(term).replace(/%20/g, '+');
  const url = slug
    ? `https://www.doordash.com/search/store/${slug}/`
    : 'https://www.doordash.com/';
  const metaParts: string[] = [];
  if (q.restaurantName) metaParts.push(q.restaurantName);
  else if (q.activity) metaParts.push(q.activity);
  if (q.city) metaParts.push(q.city);
  return { url, provider: 'DoorDash', meta: metaParts.join(' · ') };
}

function buildRecipe(q: ExternalActionQuery): BuiltAction {
  // AllRecipes search — free, doesn't paywall, works on mobile + web.
  // The bot's default for recipes is an inline LLM answer; this card
  // exists for "show me recipes" / "find me a recipe" browse intent.
  // Lookup term comes from `q.q` (preferred) or `activity` as a fallback.
  const term = q.q ?? q.activity ?? '';
  const params = new URLSearchParams();
  if (term) params.set('q', term);
  const url = term
    ? `https://www.allrecipes.com/search?${params.toString()}`
    : 'https://www.allrecipes.com/';
  return {
    url,
    provider: 'AllRecipes',
    meta: term ? term : '',
  };
}

function buildFlight(q: ExternalActionQuery): BuiltAction {
  // Google Flights parses a natural-language `q=`. Carry origin, destination
  // AND both dates — "flights to Lisbon May 3–10" must not collapse to
  // "Flights from BOS" with the trip dropped (ADR 0153).
  const clauses = ['Flights'];
  if (q.origin) clauses.push(`from ${q.origin}`);
  if (q.destination) clauses.push(`to ${q.destination}`);
  if (q.departDate) clauses.push(`on ${ymd(q.departDate)}`);
  if (q.returnDate) clauses.push(`through ${ymd(q.returnDate)}`);
  const params = new URLSearchParams({ q: clauses.join(' ') });
  const url = `https://www.google.com/travel/flights?${params.toString()}`;
  const metaParts: string[] = [];
  if (q.origin && q.destination) metaParts.push(`${q.origin} → ${q.destination}`);
  else if (q.destination) metaParts.push(`to ${q.destination}`);
  else if (q.origin) metaParts.push(`from ${q.origin}`);
  if (q.departDate) metaParts.push(`depart ${ymd(q.departDate)}`);
  if (q.returnDate) metaParts.push(`return ${ymd(q.returnDate)}`);
  return { url, provider: 'Google Flights', meta: metaParts.join(' · ') };
}

/**
 * ADR 0138 — the live page for a flight we can name.
 *
 * Returns null rather than a guess: FlightAware addresses a flight by ICAO
 * ident, so an airline outside `flight-ident`'s table has no correct URL, and
 * a link that dead-ends reads as Chord's mistake rather than as a gap. The
 * executor turns that null into a refusal with no card.
 */
function buildFlightStatus(q: ExternalActionQuery): BuiltAction | null {
  const raw = (q.flightNumber ?? '').trim();
  // "UA512" carries its own airline; "Southwest Airlines 2714" names it in
  // words, the way a travel leg stores it.
  const spelled = /^(.*\D)\s*(\d{1,4})$/.exec(raw);
  const url =
    flightTrackingUrl(null, raw) ??
    (spelled ? flightTrackingUrl(spelled[1].trim(), spelled[2]) : null);
  if (!url) return null;
  return { url, provider: 'FlightAware', meta: raw.toUpperCase().replace(/\s+/g, ' ') };
}

/**
 * The carrier's own tracking page. Null when the number fits no carrier or
 * fits two — the executor resolves those cases (and the no-number case) into
 * a question before this runs, so null here is a backstop, not a path.
 */
function buildPackageTracking(q: ExternalActionQuery): BuiltAction | null {
  if (!q.trackingNumber?.trim()) return null;
  const r = trackingForStatedNumber(q.trackingNumber, q.carrier);
  if (!r.ok) return null;
  return { url: r.ref.url, provider: r.ref.carrier, meta: r.ref.number };
}

function buildHotel(q: ExternalActionQuery): BuiltAction {
  // Google Travel's hotel search (ADR 0153) — a price aggregator across
  // Booking / Expedia / Hotels.com / direct, sitting next to `flight` under
  // google.com/travel/*. Check-in / check-out have no stable URL param in this
  // form, so they ride `meta`.
  const term = ['hotels', q.city ? `in ${q.city}` : ''].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: term });
  const metaParts: string[] = [];
  if (q.city) metaParts.push(q.city);
  if (q.checkinDate && q.checkoutDate) metaParts.push(`${ymd(q.checkinDate)} → ${ymd(q.checkoutDate)}`);
  else if (q.checkinDate) metaParts.push(`from ${ymd(q.checkinDate)}`);
  return {
    url: `https://www.google.com/travel/search?${params.toString()}`,
    provider: 'Google Hotels',
    meta: metaParts.join(' · '),
  };
}

function buildActivity(q: ExternalActionQuery): BuiltAction {
  // Google Travel's "things to do" (ADR 0153) — aggregates GetYourGuide /
  // Viator / operators, same google.com/travel/* family as flights + hotels.
  const what = q.activity?.trim() || 'things to do';
  const term = [what, q.city ? `in ${q.city}` : ''].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: term });
  const metaParts: string[] = [];
  if (q.activity) metaParts.push(q.activity);
  if (q.city) metaParts.push(q.city);
  return {
    url: `https://www.google.com/travel/search?${params.toString()}`,
    provider: 'Google Things to do',
    meta: metaParts.join(' · '),
  };
}

const SEARCH_TABS: Record<SearchType, { param?: [string, string]; provider: string }> = {
  web: { provider: 'Google' },
  images: { param: ['udm', '2'], provider: 'Google Images' },
  videos: { param: ['tbm', 'vid'], provider: 'Google Videos' },
  news: { param: ['tbm', 'nws'], provider: 'Google News' },
  shopping: { param: ['tbm', 'shop'], provider: 'Google Shopping' },
};

/** Null without a term: an empty search page is not an answer. */
function buildSearch(q: ExternalActionQuery): BuiltAction | null {
  const term = (q.q ?? q.activity ?? '').trim();
  if (!term) return null;
  const tab = SEARCH_TABS[q.searchType ?? 'web'] ?? SEARCH_TABS.web;
  const params = new URLSearchParams({ q: term });
  if (tab.param) params.set(tab.param[0], tab.param[1]);
  return {
    url: `https://www.google.com/search?${params.toString()}`,
    provider: tab.provider,
    meta: term,
  };
}

export function buildExternalAction(
  kind: ExternalActionKind,
  query: ExternalActionQuery,
): BuiltAction | null {
  switch (kind) {
    case 'restaurant':
      return buildRestaurant(query);
    case 'takeout':
      return buildTakeout(query);
    case 'recipe':
      return buildRecipe(query);
    case 'find_person':
      return buildFindPerson(query);
    case 'map':
      return buildMap(query);
    case 'flight':
      return buildFlight(query);
    case 'flight_status':
      return buildFlightStatus(query);
    case 'package_tracking':
      return buildPackageTracking(query);
    case 'hotel':
      return buildHotel(query);
    case 'activity':
      return buildActivity(query);
    case 'search':
      return buildSearch(query);
  }
}

function formatHumanDateTime(iso: string): string {
  // Cheap formatter — avoids pulling Intl polyfills on Node. "Sat 7pm" is
  // the goal but with no locale data we'd need stable output across runtimes,
  // so settle for ISO date + 24h time.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) return iso;
  return `${m[1]} ${m[2]}`;
}
