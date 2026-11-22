/**
 * WMO 4677 weather codes → a short phrase and an emoji.
 *
 * Open-Meteo returns the raw code; every other provider we might swap in maps
 * onto the same vocabulary, so the rendering lives here rather than in the
 * provider.
 */
const CODES: Record<number, [string, string]> = {
  0: ['☀️', 'Clear'],
  1: ['🌤️', 'Mostly clear'],
  2: ['⛅', 'Partly cloudy'],
  3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'],
  48: ['🌫️', 'Freezing fog'],
  51: ['🌦️', 'Light drizzle'],
  53: ['🌦️', 'Drizzle'],
  55: ['🌦️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'],
  57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'],
  63: ['🌧️', 'Rain'],
  65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'],
  67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'],
  73: ['🌨️', 'Snow'],
  75: ['❄️', 'Heavy snow'],
  77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Showers'],
  81: ['🌧️', 'Showers'],
  82: ['⛈️', 'Heavy showers'],
  85: ['🌨️', 'Snow showers'],
  86: ['❄️', 'Heavy snow showers'],
  95: ['⛈️', 'Thunderstorms'],
  96: ['⛈️', 'Thunderstorms with hail'],
  99: ['⛈️', 'Thunderstorms with hail'],
};

export function describeWmo(code: number): { emoji: string; phrase: string } {
  const hit = CODES[code];
  return hit ? { emoji: hit[0], phrase: hit[1] } : { emoji: '🌡️', phrase: 'Mixed' };
}

/** Codes that mean water is falling out of the sky, by kind. */
const THUNDER = new Set([95, 96, 99]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const WET = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);

/** Below this the chance isn't worth a clause — every forecast has a 10%. */
const MENTION_PCT = 25;
/** At or above this we tell the user to do something about it. */
const ADVISE_PCT = 50;

export function isWetCode(code: number): boolean {
  return THUNDER.has(code) || SNOW.has(code) || WET.has(code);
}

/**
 * How much a reader would care, for breaking ties between hours that share a
 * probability. Not a physical scale — just an ordering.
 */
export function wmoSeverity(code: number | null | undefined): number {
  if (typeof code !== 'number') return -1;
  if (THUNDER.has(code)) return 4;
  if (code === 65 || code === 75 || code === 82 || code === 86) return 3;
  if (SNOW.has(code) || code === 63 || code === 81) return 2;
  if (isWetCode(code)) return 1;
  return 0;
}

/** "3 PM" from a local ISO hour. Hour-resolution: the forecast is hourly. */
function hourLabel(localIso: string): string | null {
  const m = /T(\d{2}):/.exec(localIso);
  if (!m) return null;
  const h = Number(m[1]);
  if (!Number.isFinite(h)) return null;
  const suffix = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

export interface WeatherRender {
  /** Daily WMO code — the headline condition. */
  code: number;
  /** Daily extremes, in Celsius as Open-Meteo returns them. */
  highC: number;
  lowC: number;
  unit: 'F' | 'C';
  /** Peak precipitation chance for the rest of the day, 0-100. */
  chancePct?: number | null;
  /** Local ISO hour that peak falls in, e.g. "2026-08-22T15:00". */
  chanceAt?: string | null;
  /** WMO code at that hour — thunderstorms read differently from drizzle. */
  chanceCode?: number | null;
  /** City the forecast is for, so the briefing names it ("…in Seville today…").
   *  Omitted when unknown — the line just drops the clause. */
  place?: string | null;
}

/**
 * One descriptive line: condition, both extremes, and — when the day is
 * actually wet — what is coming, when, and whether to carry something.
 *
 * "⛅ Partly cloudy today, low 64° and high 79°F · ⛈️ 60% chance of
 * thunderstorms around 3 PM — carry an umbrella"
 *
 * Always a single line with no tabs or doubled spaces: this becomes slot
 * {{1}} of the approved Meta template, and Meta rejects the message
 * outright if a body variable contains one (ADR 0091).
 */
export function renderWeatherLine(w: WeatherRender): string {
  const { emoji, phrase } = describeWmo(w.code);
  const conv = (c: number) => (w.unit === 'F' ? Math.round((c * 9) / 5 + 32) : Math.round(c));
  const where = w.place ? ` in ${w.place}` : '';
  const head = `${emoji} ${phrase}${where} today, low ${conv(w.lowC)}° and high ${conv(w.highC)}°${w.unit}`;

  const pct = typeof w.chancePct === 'number' ? Math.round(w.chancePct) : 0;
  const wetCode = typeof w.chanceCode === 'number' ? w.chanceCode : w.code;
  // A high number against a dry code is a rounding artefact, not a forecast —
  // saying "60% chance of clear" would be worse than saying nothing.
  if (pct < MENTION_PCT || !isWetCode(wetCode)) return head;

  const when = w.chanceAt ? hourLabel(w.chanceAt) : null;
  const kind = describeWmo(wetCode);
  const at = when ? ` around ${when}` : '';
  const clause = `${kind.emoji} ${pct}% chance of ${kind.phrase.toLowerCase()}${at}`;

  if (pct < ADVISE_PCT) return `${head} · ${clause}`;
  const advice = SNOW.has(wetCode) ? 'bundle up' : 'carry an umbrella';
  return `${head} · ${clause} — ${advice}`;
}
