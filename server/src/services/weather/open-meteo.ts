/**
 * Open-Meteo — forecast + geocoding, no API key.
 *
 * Both hosts are fixed constants, so unlike ADR 0050's calendar import there
 * is no user-supplied URL and no SSRF surface to guard; a timeout and a
 * try/catch are the whole safety story. Weather must never break a briefing,
 * so every failure path returns null.
 */
import { logger } from '../../config/logging.js';
import type { Coordinates, DailyWeather, GeocodedPlace, WeatherProvider } from './types.js';
import { renderWeatherLine, wmoSeverity } from './wmo.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 6000;

/** Zones that read Fahrenheit. Everywhere else gets Celsius. */
const FAHRENHEIT_ZONES = /^(US\/|America\/(New_York|Chicago|Denver|Los_Angeles|Anchorage|Phoenix|Detroit|Indiana|Kentucky|North_Dakota|Boise|Juneau|Sitka|Nome|Adak|Menominee)|Pacific\/(Honolulu|Guam|Pago_Pago))/;

function unitFor(tz: string | null): 'F' | 'C' {
  return tz && FAHRENHEIT_ZONES.test(tz) ? 'F' : 'C';
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      logger.info('weather: request failed', { status: res.status });
      return null;
    }
    return (await res.json()) as unknown;
  } catch (err) {
    logger.info('weather: request errored', { err });
    return null;
  }
}

interface ForecastShape {
  daily?: {
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
  hourly?: {
    time?: string[];
    precipitation_probability?: number[];
    weather_code?: number[];
  };
}

/**
 * The wettest hour still ahead of the reader, so "around 3 PM" is advice and
 * not a report of rain they already walked through. Hourly times come back in
 * the requested zone, so comparing against the local wall clock is valid.
 *
 * Deliberately scoped to the REST of the day, not the whole of it: a briefing
 * read at 6 PM should not promise an umbrella for the shower that soaked the
 * morning. Late in the day that legitimately yields a low number and the
 * caller drops the clause — silence is the right answer there.
 */
export function peakPrecip(
  hourly: ForecastShape['hourly'],
  nowLocalHour: number,
): { pct: number; at: string | null; code: number | null } | null {
  const times = hourly?.time;
  const probs = hourly?.precipitation_probability;
  if (!times || !probs || times.length === 0) return null;
  const codes = hourly?.weather_code;

  let best = -1;
  let bestSeverity = -1;
  let idx = -1;
  for (let i = 0; i < times.length && i < probs.length; i++) {
    const h = Number(/T(\d{2}):/.exec(times[i])?.[1]);
    if (!Number.isFinite(h) || h < nowLocalHour) continue;
    const p = probs[i];
    if (typeof p !== 'number') continue;
    // Long stretches sit at the same probability, so ties are the common
    // case, not the edge. Breaking them on severity stops a day of showers
    // being announced as the drizzle that happened to come first.
    const sev = wmoSeverity(codes?.[i]);
    if (p > best || (p === best && sev > bestSeverity)) {
      best = p;
      bestSeverity = sev;
      idx = i;
    }
  }
  return idx === -1 ? null : { pct: best, at: times[idx], code: codes?.[idx] ?? null };
}

/** The reader's current hour in their own zone, for "still ahead" above. */
function localHour(tz: string | null): number {
  if (!tz) return new Date().getHours();
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    }).format(new Date());
    const h = Number(s);
    return Number.isFinite(h) ? h % 24 : 0;
  } catch {
    return 0;
  }
}

interface GeocodeShape {
  results?: Array<{
    name?: string;
    latitude?: number;
    longitude?: number;
    admin1?: string;
    country_code?: string;
  }>;
}

export const openMeteoProvider: WeatherProvider = {
  name: 'open-meteo',

  async today(
    at: Coordinates,
    tz: string | null,
    place?: string | null,
  ): Promise<DailyWeather | null> {
    // One request covers the whole line: daily gives the headline and the
    // extremes, hourly gives the timing that makes "carry an umbrella"
    // actionable rather than vague.
    const params = new URLSearchParams({
      latitude: String(at.lat),
      longitude: String(at.lon),
      daily:
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      hourly: 'precipitation_probability,weather_code',
      forecast_days: '1',
      timezone: tz || 'auto',
    });
    const json = (await getJson(`${FORECAST_URL}?${params}`)) as ForecastShape | null;
    const d = json?.daily;
    const code = d?.weather_code?.[0];
    const high = d?.temperature_2m_max?.[0];
    const low = d?.temperature_2m_min?.[0];
    if (typeof code !== 'number' || typeof high !== 'number' || typeof low !== 'number') {
      return null;
    }
    const peak = peakPrecip(json?.hourly, localHour(tz));
    return {
      line: renderWeatherLine({
        code,
        highC: high,
        lowC: low,
        unit: unitFor(tz),
        // Prefer the hourly peak; the daily max is the floor when hourly is
        // missing, so a wet day still gets its clause.
        chancePct: peak?.pct ?? d?.precipitation_probability_max?.[0] ?? null,
        chanceAt: peak?.at ?? null,
        chanceCode: peak?.code ?? null,
        place: place ?? null,
      }),
    };
  },

  async geocode(query: string): Promise<GeocodedPlace | null> {
    const q = query.trim();
    if (!q) return null;
    const params = new URLSearchParams({ name: q, count: '1', format: 'json' });
    const json = (await getJson(`${GEOCODE_URL}?${params}`)) as GeocodeShape | null;
    const hit = json?.results?.[0];
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
      return null;
    }
    return {
      place: hit.name ?? q,
      lat: hit.latitude,
      lon: hit.longitude,
    };
  },
};
