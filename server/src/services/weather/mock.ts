/**
 * Deterministic weather for tests and mock-LLM demos. Never touches the
 * network, mirroring GMAIL_PROVIDER=mock and LLM_PROVIDER=mock.
 */
import type { Coordinates, DailyWeather, GeocodedPlace, WeatherProvider } from './types.js';
import { renderWeatherLine } from './wmo.js';

export const mockWeatherProvider: WeatherProvider = {
  name: 'mock',

  async today(
    _at: Coordinates,
    tz: string | null,
    place?: string | null,
  ): Promise<DailyWeather | null> {
    // Carries a wet afternoon so demos and tests exercise the full line —
    // chance, timing and advice — not just the dry headline.
    return {
      line: renderWeatherLine({
        code: 2,
        highC: 22,
        lowC: 14,
        unit: tz?.startsWith('America/') ? 'F' : 'C',
        chancePct: 60,
        chanceAt: '2026-01-01T15:00',
        chanceCode: 95,
        place: place ?? null,
      }),
    };
  },

  async geocode(query: string): Promise<GeocodedPlace | null> {
    const q = query.trim();
    if (!q || q.toLowerCase() === 'nowhere') return null;
    return { place: q, lat: 40.7128, lon: -74.006 };
  },
};
