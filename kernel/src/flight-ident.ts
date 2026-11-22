/**
 * Airline + FlightAware URL from a flight designator (ADR 0138).
 *
 * The sibling of `server/src/services/email/tracking.ts`, and the same posture:
 * a parser and a URL template, never a model call. We only ever RENDER the
 * link — Chord does not fetch a flight-status page (ADR 0135's rule, restated
 * where the temptation is stronger).
 *
 * Two things make this harder than a tracking number:
 *
 * 1. **FlightAware wants the ICAO ident.** `DAL1231`, not `DL1231`; the IATA
 *    form redirects only for a handful of majors. So the table below is not a
 *    lookup convenience, it IS the recognition step — an airline we cannot
 *    name gets no URL at all.
 * 2. **A designator is a far more ambiguous shape than a run of digits.**
 *    `[A-Z]{2}\d{1,4}` is also an order number, a room number, a part number.
 *    ADR 0133's corroboration gate is mandatory here rather than defensive.
 *
 * Lives in kernel because mobile needs the same table for trip-leg rows and
 * has no test harness (the ADR 0120/0121 reason); it is covered by vitest from
 * the server workspace, like `list-name.ts`.
 */

interface Airline {
  /** ICAO designator — the ATC callsign prefix FlightAware idents use. */
  icao: string;
  /** Full legal-ish name, matched word-bounded against the email text. */
  name: string;
  /** Sender domains that vouch for a designator on their own. */
  domains: string[];
  /**
   * Distinctive short forms safe to match on their own.
   *
   * Deliberately absent for anything that is also an ordinary English word:
   * "United States" must not vouch for a `UA1234` order number, and the same
   * goes for Delta, American, Alaska, Frontier and Spirit. Those carriers are
   * recognised by their full name, their domain, or a cue word — never by a
   * word that shows up in unrelated mail.
   */
  aliases?: string[];
}

/**
 * Keyed by IATA designator. Roughly the carriers a family in North America
 * actually flies, plus the majors they connect onto.
 *
 * An airline missing from this table is not a bug that silently mislinks —
 * `findFlight` returns no ident and no URL for it, which is the whole point.
 */
const AIRLINES: Record<string, Airline> = {
  // United States
  AA: { icao: 'AAL', name: 'American Airlines', domains: ['aa.com'] },
  DL: { icao: 'DAL', name: 'Delta Air Lines', domains: ['delta.com'] },
  UA: { icao: 'UAL', name: 'United Airlines', domains: ['united.com'] },
  WN: { icao: 'SWA', name: 'Southwest Airlines', domains: ['southwest.com'] },
  AS: { icao: 'ASA', name: 'Alaska Airlines', domains: ['alaskaair.com'] },
  B6: { icao: 'JBU', name: 'JetBlue Airways', domains: ['jetblue.com'], aliases: ['JetBlue'] },
  NK: { icao: 'NKS', name: 'Spirit Airlines', domains: ['spirit.com'] },
  F9: { icao: 'FFT', name: 'Frontier Airlines', domains: ['flyfrontier.com'] },
  HA: { icao: 'HAL', name: 'Hawaiian Airlines', domains: ['hawaiianairlines.com'] },
  G4: { icao: 'AAY', name: 'Allegiant Air', domains: ['allegiantair.com'], aliases: ['Allegiant'] },
  SY: { icao: 'SCX', name: 'Sun Country Airlines', domains: ['suncountry.com'] },
  MX: { icao: 'MXY', name: 'Breeze Airways', domains: ['flybreeze.com'], aliases: ['Breeze'] },
  OO: { icao: 'SKW', name: 'SkyWest Airlines', domains: ['skywest.com'], aliases: ['SkyWest'] },
  YX: { icao: 'RPA', name: 'Republic Airways', domains: ['rjet.com'] },
  MQ: { icao: 'ENY', name: 'Envoy Air', domains: ['envoyair.com'] },
  OH: { icao: 'JIA', name: 'PSA Airlines', domains: ['psaairlines.com'] },
  '9E': { icao: 'EDV', name: 'Endeavor Air', domains: ['endeavorair.com'] },
  QX: { icao: 'QXE', name: 'Horizon Air', domains: ['horizonair.com'] },

  // Canada + Mexico
  AC: { icao: 'ACA', name: 'Air Canada', domains: ['aircanada.com'] },
  WS: { icao: 'WJA', name: 'WestJet', domains: ['westjet.com'], aliases: ['WestJet'] },
  PD: { icao: 'POE', name: 'Porter Airlines', domains: ['flyporter.com'] },
  AM: { icao: 'AMX', name: 'Aeromexico', domains: ['aeromexico.com'], aliases: ['Aeroméxico'] },
  Y4: { icao: 'VOI', name: 'Volaris', domains: ['volaris.com'], aliases: ['Volaris'] },
  VB: { icao: 'VIV', name: 'Viva Aerobus', domains: ['vivaaerobus.com'] },

  // Europe
  BA: { icao: 'BAW', name: 'British Airways', domains: ['britishairways.com'] },
  VS: { icao: 'VIR', name: 'Virgin Atlantic', domains: ['virginatlantic.com'] },
  LH: { icao: 'DLH', name: 'Lufthansa', domains: ['lufthansa.com'], aliases: ['Lufthansa'] },
  AF: { icao: 'AFR', name: 'Air France', domains: ['airfrance.com'] },
  KL: { icao: 'KLM', name: 'KLM Royal Dutch Airlines', domains: ['klm.com'], aliases: ['KLM'] },
  IB: { icao: 'IBE', name: 'Iberia', domains: ['iberia.com'], aliases: ['Iberia'] },
  AZ: { icao: 'ITY', name: 'ITA Airways', domains: ['itaspa.com'] },
  LX: { icao: 'SWR', name: 'Swiss International Air Lines', domains: ['swiss.com'] },
  OS: { icao: 'AUA', name: 'Austrian Airlines', domains: ['austrian.com'] },
  SN: { icao: 'BEL', name: 'Brussels Airlines', domains: ['brusselsairlines.com'] },
  SK: { icao: 'SAS', name: 'Scandinavian Airlines', domains: ['flysas.com'] },
  AY: { icao: 'FIN', name: 'Finnair', domains: ['finnair.com'], aliases: ['Finnair'] },
  TP: { icao: 'TAP', name: 'TAP Air Portugal', domains: ['flytap.com'] },
  EI: { icao: 'EIN', name: 'Aer Lingus', domains: ['aerlingus.com'], aliases: ['Aer Lingus'] },
  FR: { icao: 'RYR', name: 'Ryanair', domains: ['ryanair.com'], aliases: ['Ryanair'] },
  U2: { icao: 'EZY', name: 'easyJet', domains: ['easyjet.com'], aliases: ['easyJet'] },
  W6: { icao: 'WZZ', name: 'Wizz Air', domains: ['wizzair.com'], aliases: ['Wizz Air'] },
  VY: { icao: 'VLG', name: 'Vueling', domains: ['vueling.com'], aliases: ['Vueling'] },
  TK: { icao: 'THY', name: 'Turkish Airlines', domains: ['turkishairlines.com'] },
  LO: { icao: 'LOT', name: 'LOT Polish Airlines', domains: ['lot.com'] },
  A3: { icao: 'AEE', name: 'Aegean Airlines', domains: ['aegeanair.com'], aliases: ['Aegean'] },
  DY: { icao: 'NAX', name: 'Norwegian Air Shuttle', domains: ['norwegian.com'] },
  BT: { icao: 'BTI', name: 'airBaltic', domains: ['airbaltic.com'], aliases: ['airBaltic'] },
  HV: { icao: 'TRA', name: 'Transavia', domains: ['transavia.com'], aliases: ['Transavia'] },
  EW: { icao: 'EWG', name: 'Eurowings', domains: ['eurowings.com'], aliases: ['Eurowings'] },

  // Middle East + Africa
  EK: { icao: 'UAE', name: 'Emirates', domains: ['emirates.com'], aliases: ['Emirates'] },
  QR: { icao: 'QTR', name: 'Qatar Airways', domains: ['qatarairways.com'] },
  EY: { icao: 'ETD', name: 'Etihad Airways', domains: ['etihad.com'], aliases: ['Etihad'] },
  SV: { icao: 'SVA', name: 'Saudia', domains: ['saudia.com'], aliases: ['Saudia'] },
  MS: { icao: 'MSR', name: 'EgyptAir', domains: ['egyptair.com'], aliases: ['EgyptAir'] },
  ET: { icao: 'ETH', name: 'Ethiopian Airlines', domains: ['ethiopianairlines.com'] },
  LY: { icao: 'ELY', name: 'El Al', domains: ['elal.com'], aliases: ['El Al'] },
  RJ: { icao: 'RJA', name: 'Royal Jordanian', domains: ['rj.com'] },
  WY: { icao: 'OMA', name: 'Oman Air', domains: ['omanair.com'] },
  GF: { icao: 'GFA', name: 'Gulf Air', domains: ['gulfair.com'] },
  KQ: { icao: 'KQA', name: 'Kenya Airways', domains: ['kenya-airways.com'] },

  // Asia-Pacific
  SQ: { icao: 'SIA', name: 'Singapore Airlines', domains: ['singaporeair.com'] },
  CX: { icao: 'CPA', name: 'Cathay Pacific', domains: ['cathaypacific.com'], aliases: ['Cathay'] },
  JL: { icao: 'JAL', name: 'Japan Airlines', domains: ['jal.com', 'jal.co.jp'] },
  NH: { icao: 'ANA', name: 'All Nippon Airways', domains: ['ana.co.jp'] },
  KE: { icao: 'KAL', name: 'Korean Air', domains: ['koreanair.com'] },
  OZ: { icao: 'AAR', name: 'Asiana Airlines', domains: ['flyasiana.com'], aliases: ['Asiana'] },
  TG: { icao: 'THA', name: 'Thai Airways', domains: ['thaiairways.com'] },
  MH: { icao: 'MAS', name: 'Malaysia Airlines', domains: ['malaysiaairlines.com'] },
  GA: { icao: 'GIA', name: 'Garuda Indonesia', domains: ['garuda-indonesia.com'], aliases: ['Garuda'] },
  PR: { icao: 'PAL', name: 'Philippine Airlines', domains: ['philippineairlines.com'] },
  VN: { icao: 'HVN', name: 'Vietnam Airlines', domains: ['vietnamairlines.com'] },
  CI: { icao: 'CAL', name: 'China Airlines', domains: ['china-airlines.com'] },
  BR: { icao: 'EVA', name: 'EVA Air', domains: ['evaair.com'], aliases: ['EVA Air'] },
  CA: { icao: 'CCA', name: 'Air China', domains: ['airchina.com'] },
  MU: { icao: 'CES', name: 'China Eastern Airlines', domains: ['ceair.com'] },
  CZ: { icao: 'CSN', name: 'China Southern Airlines', domains: ['csair.com'] },
  HU: { icao: 'CHH', name: 'Hainan Airlines', domains: ['hnair.com'] },
  AI: { icao: 'AIC', name: 'Air India', domains: ['airindia.com'] },
  '6E': { icao: 'IGO', name: 'IndiGo', domains: ['goindigo.in'], aliases: ['IndiGo'] },
  SG: { icao: 'SEJ', name: 'SpiceJet', domains: ['spicejet.com'], aliases: ['SpiceJet'] },
  QF: { icao: 'QFA', name: 'Qantas', domains: ['qantas.com'], aliases: ['Qantas'] },
  VA: { icao: 'VOZ', name: 'Virgin Australia', domains: ['virginaustralia.com'] },
  JQ: { icao: 'JST', name: 'Jetstar', domains: ['jetstar.com'], aliases: ['Jetstar'] },
  NZ: { icao: 'ANZ', name: 'Air New Zealand', domains: ['airnewzealand.com'] },
  FJ: { icao: 'FJI', name: 'Fiji Airways', domains: ['fijiairways.com'] },
  AK: { icao: 'AXM', name: 'AirAsia', domains: ['airasia.com'], aliases: ['AirAsia'] },
  TR: { icao: 'TGW', name: 'Scoot', domains: ['flyscoot.com'], aliases: ['Scoot'] },

  // Latin America + Caribbean
  LA: { icao: 'LAN', name: 'LATAM Airlines', domains: ['latamairlines.com'], aliases: ['LATAM'] },
  AV: { icao: 'AVA', name: 'Avianca', domains: ['avianca.com'], aliases: ['Avianca'] },
  CM: { icao: 'CMP', name: 'Copa Airlines', domains: ['copaair.com'] },
  AR: { icao: 'ARG', name: 'Aerolineas Argentinas', domains: ['aerolineas.com.ar'] },
  G3: { icao: 'GLO', name: 'GOL Linhas Aereas', domains: ['voegol.com.br'] },
  AD: { icao: 'AZU', name: 'Azul Brazilian Airlines', domains: ['voeazul.com.br'] },
  BW: { icao: 'BWA', name: 'Caribbean Airlines', domains: ['caribbean-airlines.com'] },
};

export interface FlightRef {
  /** The designator as recognised, without the separator: `UA512`. */
  iata: string;
  /** Just the numeric part, as written: `512`, or `009`. */
  number: string;
  /** Null when the designator's airline is not in the table. */
  airline: string | null;
  /** The ICAO ident FlightAware addresses: `UAL512`. Null with `airline`. */
  ident: string | null;
  /** Null whenever `ident` is — we never guess a URL. */
  url: string | null;
}

/**
 * A designator is two characters and one to four digits, optionally separated.
 *
 * Matched **case-sensitively**. Lowercasing would make `to 500` and `by 2024`
 * designators, and an ordinary sentence would corroborate itself; a mail that
 * writes its flight in title case is missed instead, which is the direction
 * ADR 0133 chose — a miss costs a search, a wrong link costs trust.
 */
const DESIGNATOR = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])[ -]?(\d{1,4})\b/g;

/**
 * What a flight email says immediately before the number.
 *
 * `confirmation`, `order`, `booking`, `record locator` and `PNR` are
 * deliberately absent: those precede a RECORD LOCATOR (`KX8QP2`), not a flight
 * number. Including them would be exactly the `Order` mistake ADR 0133 made a
 * rule about.
 */
const CUE_BEFORE = /\b(flight|flt)\b(\s*(number|num|no\.?|#))?\W{0,12}$/i;

/** Enough for "Flight number: ", not enough for a sentence to vouch. */
const CUE_WINDOW = 40;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the text name this airline outright? Full name, or a safe short form. */
function mentionsAirline(text: string, a: Airline): boolean {
  for (const n of [a.name, ...(a.aliases ?? [])]) {
    if (new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(text)) return true;
  }
  return false;
}

/** The IATA code of the airline that sent this mail, if it was an airline. */
function senderIata(fromEmail?: string | null): string | null {
  const domain = fromEmail?.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return null;
  for (const [iata, a] of Object.entries(AIRLINES)) {
    if (a.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return iata;
  }
  return null;
}

/** Resolve a free-text carrier — an IATA code, a full name, or an alias. */
function iataForCarrier(carrier?: string | null): string | null {
  const c = carrier?.trim();
  if (!c) return null;
  const upper = c.toUpperCase();
  if (AIRLINES[upper]) return upper;
  const lower = c.toLowerCase();
  for (const [iata, a] of Object.entries(AIRLINES)) {
    if (a.name.toLowerCase() === lower) return iata;
    if ((a.aliases ?? []).some((n) => n.toLowerCase() === lower)) return iata;
  }
  return null;
}

/**
 * An ATC callsign carries no leading zeros — `AF 009` flies as `AFR9` — and a
 * FlightAware ident is a callsign. The printed form keeps its zeros.
 */
function callsignDigits(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Where FlightAware keeps a flight, given its ICAO ident.
 *
 * The one place the template lives. A stored flight rebuilds its link through
 * here rather than keeping a URL (ADR 0135's rule), and a second copy of this
 * string is how the two would come to disagree.
 */
export function flightAwareUrl(ident: string): string {
  return `https://www.flightaware.com/live/flight/${ident}`;
}

function urlFor(icao: string, digits: string): string {
  return flightAwareUrl(`${icao}${callsignDigits(digits)}`);
}

function resolved(code: string, digits: string, a: Airline): FlightRef {
  return {
    iata: `${code}${digits}`,
    number: digits,
    airline: a.name,
    ident: `${a.icao}${callsignDigits(digits)}`,
    url: urlFor(a.icao, digits),
  };
}

/**
 * The flight this text is about, with the airline it belongs to.
 *
 * Every designator needs corroboration, and the bar is deliberately asymmetric:
 *
 * - **A code we know** is vouched for by the sender being that airline, the
 *   airline being named in the text, or a cue word right before the number.
 * - **A code we do not know** needs the cue word specifically. Nothing else can
 *   speak for a designator we cannot even name — and the sender arm is useless
 *   there by construction.
 *
 * The sender is a strong positive and never a requirement: most flight mail
 * does come from the airline, but plenty arrives via Expedia, TripIt or a
 * travel agent — the same reason ADR 0133 declined to require a carrier sender.
 *
 * Two passes, because a resolvable flight beats an unresolvable one wherever it
 * appears: "Flight XX123 was rebooked to Flight UA512" should link UA512.
 */
export function findFlight(text: string, fromEmail?: string | null): FlightRef | null {
  if (!text) return null;
  const sender = senderIata(fromEmail);
  const candidates: Array<{ code: string; digits: string; cue: boolean }> = [];

  for (const m of text.matchAll(DESIGNATOR)) {
    const at = m.index ?? 0;
    candidates.push({
      code: m[1],
      digits: m[2],
      cue: CUE_BEFORE.test(text.slice(Math.max(0, at - CUE_WINDOW), at)),
    });
  }

  for (const c of candidates) {
    const a = AIRLINES[c.code];
    if (!a) continue;
    if (sender === c.code || mentionsAirline(text, a) || c.cue) return resolved(c.code, c.digits, a);
  }

  for (const c of candidates) {
    if (AIRLINES[c.code] || !c.cue) continue;
    // Named but unlinkable: the number is worth showing, a guessed URL is not.
    return { iata: `${c.code}${c.digits}`, number: c.digits, airline: null, ident: null, url: null };
  }

  return null;
}

/**
 * Rebuild the link for a carrier + flight number we already hold.
 *
 * Stored rather than parsed callers — a travel leg, a persisted flight fact —
 * come through here, so no surface has to store a URL that might change shape
 * (ADR 0135's rejected alternative).
 *
 * `flightNo` arrives both ways in practice: `add_travel_leg` records `UA482`
 * from one document and a bare `412` from another, so both are accepted. When
 * the number carries its own designator that designator wins — conflicting
 * evidence resolves to no link rather than to a guess.
 */
export function flightTrackingUrl(
  carrier?: string | null,
  flightNo?: string | null,
): string | null {
  const r = resolveStored(carrier, flightNo);
  return r ? urlFor(r.airline.icao, r.digits) : null;
}

/**
 * The printed designator ("WN2714") for a carrier + number we hold, or null
 * when the airline is not one we can name. A leg stores "Southwest Airlines"
 * and "2714" apart; the bot is told the designator, which is also exactly what
 * `flightTrackingUrl` accepts back.
 */
export function flightDesignator(
  carrier?: string | null,
  flightNo?: string | null,
): string | null {
  const r = resolveStored(carrier, flightNo);
  return r ? `${r.code}${r.digits}` : null;
}

function resolveStored(
  carrier?: string | null,
  flightNo?: string | null,
): { code: string; digits: string; airline: Airline } | null {
  const raw = (flightNo ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!raw) return null;

  const embedded = /^([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4})$/.exec(raw);
  const digits = embedded ? embedded[2] : /^\d{1,4}$/.test(raw) ? raw : null;
  if (!digits) return null;

  const code = embedded ? embedded[1] : iataForCarrier(carrier);
  const airline = code ? AIRLINES[code] : undefined;
  return code && airline ? { code, digits, airline } : null;
}

/** The airline's display name for a carrier we can resolve, else null. */
export function airlineName(carrier?: string | null): string | null {
  const code = iataForCarrier(carrier);
  return code ? AIRLINES[code].name : null;
}
