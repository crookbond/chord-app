/**
 * Airport → metro matching, for checking that one trip leg connects to the
 * next (ADR pending — trip-leg continuity in `get_trip_status`).
 *
 * "Does leg N's arrival airport connect to leg N+1's departure airport"
 * can't be answered with exact string equality: New York alone has three
 * airports (JFK/LGA/EWR) and a real itinerary routinely departs from one and
 * returns to another — that is not a gap, it is how the metro works. The
 * trip classifier also emits whatever the source document printed — an IATA
 * code, a full airport name, or a bare city — so even a single-airport city
 * needs matching, not just the multi-airport ones.
 *
 * Curated, not exhaustive — same posture as `flight-ident.ts`'s airline
 * table. An airport missing from this table does not produce a WRONG
 * answer, it produces NO answer: `resolveMetro` returns null and the caller
 * skips the check for that pair. That is the safe direction (ADR 0133's
 * asymmetry): a missed gap costs nothing, a false "your itinerary is broken"
 * costs trust.
 *
 * Lives in kernel for the same reason `flight-ident.ts` does — a shared
 * table, covered by vitest from the server workspace, usable from mobile
 * with no test harness of its own.
 */

interface AirportInfo {
  /** Canonical metro key — airports sharing one are treated as interchangeable. */
  metro: string;
  /** Display city, folded into the alias index below. */
  city: string;
}

const AIRPORTS: Record<string, AirportInfo> = {
  // ── Multi-airport metros (the actual case this table exists for) ──────
  // New York
  JFK: { metro: 'nyc', city: 'New York' },
  LGA: { metro: 'nyc', city: 'New York' },
  EWR: { metro: 'nyc', city: 'New York' },
  HPN: { metro: 'nyc', city: 'White Plains' },
  // Washington DC
  DCA: { metro: 'dc', city: 'Washington' },
  IAD: { metro: 'dc', city: 'Washington' },
  BWI: { metro: 'dc', city: 'Baltimore' },
  // Chicago
  ORD: { metro: 'chicago', city: 'Chicago' },
  MDW: { metro: 'chicago', city: 'Chicago' },
  // Los Angeles
  LAX: { metro: 'la', city: 'Los Angeles' },
  BUR: { metro: 'la', city: 'Burbank' },
  LGB: { metro: 'la', city: 'Long Beach' },
  SNA: { metro: 'la', city: 'Santa Ana' },
  ONT: { metro: 'la', city: 'Ontario' },
  // San Francisco Bay Area
  SFO: { metro: 'sfbay', city: 'San Francisco' },
  OAK: { metro: 'sfbay', city: 'Oakland' },
  SJC: { metro: 'sfbay', city: 'San Jose' },
  // Houston
  IAH: { metro: 'houston', city: 'Houston' },
  HOU: { metro: 'houston', city: 'Houston' },
  // Dallas
  DFW: { metro: 'dallas', city: 'Dallas' },
  DAL: { metro: 'dallas', city: 'Dallas' },
  // South Florida
  MIA: { metro: 'miami', city: 'Miami' },
  FLL: { metro: 'miami', city: 'Fort Lauderdale' },
  PBI: { metro: 'miami', city: 'West Palm Beach' },
  // London
  LHR: { metro: 'london', city: 'London' },
  LGW: { metro: 'london', city: 'London' },
  STN: { metro: 'london', city: 'London' },
  LTN: { metro: 'london', city: 'London' },
  LCY: { metro: 'london', city: 'London' },
  // Paris
  CDG: { metro: 'paris', city: 'Paris' },
  ORY: { metro: 'paris', city: 'Paris' },
  // Milan
  MXP: { metro: 'milan', city: 'Milan' },
  LIN: { metro: 'milan', city: 'Milan' },
  BGY: { metro: 'milan', city: 'Bergamo' },
  // Rome
  FCO: { metro: 'rome', city: 'Rome' },
  CIA: { metro: 'rome', city: 'Rome' },
  // Tokyo
  NRT: { metro: 'tokyo', city: 'Tokyo' },
  HND: { metro: 'tokyo', city: 'Tokyo' },
  // Osaka
  KIX: { metro: 'osaka', city: 'Osaka' },
  ITM: { metro: 'osaka', city: 'Osaka' },
  // Seoul
  ICN: { metro: 'seoul', city: 'Seoul' },
  GMP: { metro: 'seoul', city: 'Seoul' },
  // Beijing
  PEK: { metro: 'beijing', city: 'Beijing' },
  PKX: { metro: 'beijing', city: 'Beijing' },
  // Shanghai
  PVG: { metro: 'shanghai', city: 'Shanghai' },
  SHA: { metro: 'shanghai', city: 'Shanghai' },
  // Moscow
  SVO: { metro: 'moscow', city: 'Moscow' },
  DME: { metro: 'moscow', city: 'Moscow' },
  VKO: { metro: 'moscow', city: 'Moscow' },
  // Toronto
  YYZ: { metro: 'toronto', city: 'Toronto' },
  YTZ: { metro: 'toronto', city: 'Toronto' },
  // Sao Paulo
  GRU: { metro: 'saopaulo', city: 'Sao Paulo' },
  CGH: { metro: 'saopaulo', city: 'Sao Paulo' },
  // Buenos Aires
  EZE: { metro: 'buenosaires', city: 'Buenos Aires' },
  AEP: { metro: 'buenosaires', city: 'Buenos Aires' },
  // Istanbul
  IST: { metro: 'istanbul', city: 'Istanbul' },
  SAW: { metro: 'istanbul', city: 'Istanbul' },
  // Bangkok
  BKK: { metro: 'bangkok', city: 'Bangkok' },
  DMK: { metro: 'bangkok', city: 'Bangkok' },
  // Stockholm
  ARN: { metro: 'stockholm', city: 'Stockholm' },
  BMA: { metro: 'stockholm', city: 'Stockholm' },

  // ── Single-airport hubs a family is likely to actually fly (US) ───────
  ATL: { metro: 'ATL', city: 'Atlanta' },
  DEN: { metro: 'DEN', city: 'Denver' },
  SEA: { metro: 'SEA', city: 'Seattle' },
  PHX: { metro: 'PHX', city: 'Phoenix' },
  DTW: { metro: 'DTW', city: 'Detroit' },
  MSP: { metro: 'MSP', city: 'Minneapolis' },
  PHL: { metro: 'PHL', city: 'Philadelphia' },
  CLT: { metro: 'CLT', city: 'Charlotte' },
  MCO: { metro: 'MCO', city: 'Orlando' },
  LAS: { metro: 'LAS', city: 'Las Vegas' },
  SAN: { metro: 'SAN', city: 'San Diego' },
  PDX: { metro: 'PDX', city: 'Portland' },
  SLC: { metro: 'SLC', city: 'Salt Lake City' },
  BNA: { metro: 'BNA', city: 'Nashville' },
  AUS: { metro: 'AUS', city: 'Austin' },
  MCI: { metro: 'MCI', city: 'Kansas City' },
  STL: { metro: 'STL', city: 'St. Louis' },
  PIT: { metro: 'PIT', city: 'Pittsburgh' },
  CLE: { metro: 'CLE', city: 'Cleveland' },
  CVG: { metro: 'CVG', city: 'Cincinnati' },
  CMH: { metro: 'CMH', city: 'Columbus' },
  IND: { metro: 'IND', city: 'Indianapolis' },
  RDU: { metro: 'RDU', city: 'Raleigh' },
  MSY: { metro: 'MSY', city: 'New Orleans' },
  BOS: { metro: 'BOS', city: 'Boston' },
  TPA: { metro: 'TPA', city: 'Tampa' },
  RSW: { metro: 'RSW', city: 'Fort Myers' },
  JAX: { metro: 'JAX', city: 'Jacksonville' },
  SAT: { metro: 'SAT', city: 'San Antonio' },
  OKC: { metro: 'OKC', city: 'Oklahoma City' },
  TUS: { metro: 'TUS', city: 'Tucson' },
  ABQ: { metro: 'ABQ', city: 'Albuquerque' },
  BOI: { metro: 'BOI', city: 'Boise' },
  ANC: { metro: 'ANC', city: 'Anchorage' },
  HNL: { metro: 'HNL', city: 'Honolulu' },
  OGG: { metro: 'OGG', city: 'Maui' },
  // Ski country — small local fields that matter a lot for exactly the trips
  // this app tracks (fly into DEN or SLC, drive the rest of the way is
  // common; some parties fly point-to-point on the resort's own strip).
  EGE: { metro: 'EGE', city: 'Vail' },
  ASE: { metro: 'ASE', city: 'Aspen' },
  JAC: { metro: 'JAC', city: 'Jackson Hole' },
  HDN: { metro: 'HDN', city: 'Steamboat Springs' },
  // Canada
  YVR: { metro: 'YVR', city: 'Vancouver' },
  YUL: { metro: 'YUL', city: 'Montreal' },
  YYC: { metro: 'YYC', city: 'Calgary' },
  // Mexico + Latin America
  MEX: { metro: 'MEX', city: 'Mexico City' },
  CUN: { metro: 'CUN', city: 'Cancun' },
  GDL: { metro: 'GDL', city: 'Guadalajara' },
  BOG: { metro: 'BOG', city: 'Bogota' },
  LIM: { metro: 'LIM', city: 'Lima' },
  SCL: { metro: 'SCL', city: 'Santiago' },
  GIG: { metro: 'GIG', city: 'Rio de Janeiro' },

  // ── International single-airport hubs ──────────────────────────────────
  SYD: { metro: 'SYD', city: 'Sydney' },
  MEL: { metro: 'MEL', city: 'Melbourne' },
  BNE: { metro: 'BNE', city: 'Brisbane' },
  PER: { metro: 'PER', city: 'Perth' },
  AKL: { metro: 'AKL', city: 'Auckland' },
  SIN: { metro: 'SIN', city: 'Singapore' },
  HKG: { metro: 'HKG', city: 'Hong Kong' },
  DXB: { metro: 'DXB', city: 'Dubai' },
  DOH: { metro: 'DOH', city: 'Doha' },
  AUH: { metro: 'AUH', city: 'Abu Dhabi' },
  FRA: { metro: 'FRA', city: 'Frankfurt' },
  MUC: { metro: 'MUC', city: 'Munich' },
  BER: { metro: 'BER', city: 'Berlin' },
  AMS: { metro: 'AMS', city: 'Amsterdam' },
  ZRH: { metro: 'ZRH', city: 'Zurich' },
  GVA: { metro: 'GVA', city: 'Geneva' },
  MAD: { metro: 'MAD', city: 'Madrid' },
  BCN: { metro: 'BCN', city: 'Barcelona' },
  LIS: { metro: 'LIS', city: 'Lisbon' },
  DUB: { metro: 'DUB', city: 'Dublin' },
  VIE: { metro: 'VIE', city: 'Vienna' },
  CPH: { metro: 'CPH', city: 'Copenhagen' },
  OSL: { metro: 'OSL', city: 'Oslo' },
  HEL: { metro: 'HEL', city: 'Helsinki' },
  ATH: { metro: 'ATH', city: 'Athens' },
  BOM: { metro: 'BOM', city: 'Mumbai' },
  DEL: { metro: 'DEL', city: 'Delhi' },
  BLR: { metro: 'BLR', city: 'Bangalore' },
  MAA: { metro: 'MAA', city: 'Chennai' },
  HYD: { metro: 'HYD', city: 'Hyderabad' },
  CAI: { metro: 'CAI', city: 'Cairo' },
  JNB: { metro: 'JNB', city: 'Johannesburg' },
  CPT: { metro: 'CPT', city: 'Cape Town' },
  // Nairobi — the international gateway (NBO) and the domestic strip
  // safari legs actually fly out of (Wilson, WIL) are ~10km apart and
  // printed under both names/codes on real itineraries (ADR 0190).
  NBO: { metro: 'nairobi', city: 'Nairobi' },
  WIL: { metro: 'nairobi', city: 'Nairobi Wilson' },
  ADD: { metro: 'ADD', city: 'Addis Ababa' },
  // Alexandria — the active airport is Borg El Arab (HBE); the old in-city
  // Nouzha field (ALY) is largely closed to commercial traffic but still
  // shows up on older bookings and documents, so both resolve to one metro.
  HBE: { metro: 'ALY', city: 'Alexandria' },
  ALY: { metro: 'ALY', city: 'Alexandria' },
};

/**
 * Named airports (or their common short forms) that would not otherwise
 * resolve from the `city` field above — printed itineraries name the
 * airport, not the metro, at exactly the multi-airport cases where the
 * distinction matters most.
 */
const AIRPORT_NAME_ALIASES: Record<string, string> = {
  laguardia: 'nyc',
  'la guardia': 'nyc',
  newark: 'nyc',
  'newark liberty': 'nyc',
  kennedy: 'nyc',
  westchester: 'nyc',
  "o'hare": 'chicago',
  ohare: 'chicago',
  midway: 'chicago',
  // The "<city> <airport>" spellings real documents print (prod itineraries
  // carry "Chicago O'Hare International" and "New York La Guardia").
  "chicago o'hare": 'chicago',
  'chicago ohare': 'chicago',
  'chicago midway': 'chicago',
  'new york la guardia': 'nyc',
  'new york laguardia': 'nyc',
  'new york kennedy': 'nyc',
  'new york newark': 'nyc',
  reagan: 'dc',
  'reagan national': 'dc',
  national: 'dc',
  dulles: 'dc',
  baltimore: 'dc',
  'baltimore washington': 'dc',
  burbank: 'la',
  'hollywood burbank': 'la',
  'long beach': 'la',
  'orange county': 'la',
  'john wayne': 'la',
  'santa ana': 'la',
  oakland: 'sfbay',
  'san jose': 'sfbay',
  hobby: 'houston',
  'bush intercontinental': 'houston',
  'love field': 'dallas',
  'fort worth': 'dallas',
  'fort lauderdale': 'miami',
  'west palm beach': 'miami',
  'palm beach': 'miami',
  heathrow: 'london',
  gatwick: 'london',
  stansted: 'london',
  luton: 'london',
  'london city': 'london',
  'charles de gaulle': 'paris',
  roissy: 'paris',
  orly: 'paris',
  malpensa: 'milan',
  linate: 'milan',
  bergamo: 'milan',
  'orio al serio': 'milan',
  fiumicino: 'rome',
  ciampino: 'rome',
  narita: 'tokyo',
  haneda: 'tokyo',
  kansai: 'osaka',
  itami: 'osaka',
  gimpo: 'seoul',
  incheon: 'seoul',
  pudong: 'shanghai',
  hongqiao: 'shanghai',
  'capital airport': 'beijing',
  daxing: 'beijing',
  sheremetyevo: 'moscow',
  domodedovo: 'moscow',
  vnukovo: 'moscow',
  pearson: 'toronto',
  'billy bishop': 'toronto',
  'island airport': 'toronto',
  guarulhos: 'saopaulo',
  congonhas: 'saopaulo',
  ezeiza: 'buenosaires',
  aeroparque: 'buenosaires',
  'sabiha gokcen': 'istanbul',
  'suvarnabhumi': 'bangkok',
  'don mueang': 'bangkok',
};

/** Lower-cased words to drop before matching a place name. */
const NOISE_WORDS = /\b(international|regional|municipal|county|metropolitan|airport|airfield|field)\b/g;

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(NOISE_WORDS, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** City names from `AIRPORTS`, folded in once at module load. */
const CITY_INDEX: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  for (const info of Object.values(AIRPORTS)) {
    const key = normalizeText(info.city);
    if (key && !(key in index)) index[key] = info.metro;
  }
  for (const [alias, metro] of Object.entries(AIRPORT_NAME_ALIASES)) {
    const key = normalizeText(alias);
    if (key) index[key] = metro;
  }
  return index;
})();

/**
 * Resolve free text — an IATA code, an airport name, or a city, exactly as
 * a source document or a person would write it — to a metro key. Returns
 * null when nothing in the table recognizes it; that is a "don't know", not
 * a mismatch, and callers must treat it that way (see the asymmetry note
 * above).
 */
export function resolveMetro(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const paren = /\(([A-Za-z]{3})\)/.exec(trimmed);
  if (paren) {
    const code = paren[1].toUpperCase();
    if (AIRPORTS[code]) return AIRPORTS[code].metro;
  }

  const bare = trimmed.toUpperCase();
  if (/^[A-Z]{3}$/.test(bare) && AIRPORTS[bare]) return AIRPORTS[bare].metro;

  // A document often prints "City, ST" or "City, Country" — try the whole
  // string first (in case "airport" is embedded further along), then just
  // the part before the first comma.
  const firstSegment = trimmed.split(',')[0] ?? trimmed;
  for (const candidate of [trimmed, firstSegment]) {
    const key = normalizeText(candidate);
    if (key && CITY_INDEX[key]) return CITY_INDEX[key];
  }

  return null;
}

/**
 * `resolveMetro` for a place written inside longer text: a street address
 * ("650 15th St, Denver, CO") is tried whole and then one comma-separated
 * part at a time. Null is still "don't know".
 */
export function resolvePlaceMetro(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const whole = resolveMetro(raw);
  if (whole) return whole;
  for (const part of raw.split(',')) {
    const metro = resolveMetro(part);
    if (metro) return metro;
  }
  return null;
}

/** A city name to show for a metro key ("nyc" is "New York"); null if unknown. */
export function metroCity(metro: string | null | undefined): string | null {
  if (!metro) return null;
  for (const info of Object.values(AIRPORTS)) {
    if (info.metro === metro) return info.city;
  }
  return null;
}

/**
 * Do these two places belong to the same metro/airport system? Null means
 * "can't tell" (one or both sides didn't resolve) — never treat null as a
 * mismatch; skip the check instead.
 */
export function sameMetro(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const ma = resolveMetro(a);
  const mb = resolveMetro(b);
  if (!ma || !mb) return null;
  return ma === mb;
}
