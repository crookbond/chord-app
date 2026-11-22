/**
 * Weather provider factory (ADR 0091).
 *
 * `WEATHER_PROVIDER` empty disables the briefing's weather line entirely —
 * the section is optional, so an unconfigured deploy simply never renders it.
 */
import { env } from '../../config/env.js';
import { mockWeatherProvider } from './mock.js';
import { openMeteoProvider } from './open-meteo.js';
import type { WeatherProvider } from './types.js';

export type { Coordinates, DailyWeather, GeocodedPlace, WeatherProvider } from './types.js';
export { describeWmo, renderWeatherLine } from './wmo.js';

export function getWeatherProvider(): WeatherProvider | null {
  switch (env.WEATHER_PROVIDER) {
    case 'open-meteo':
      return openMeteoProvider;
    case 'mock':
      return mockWeatherProvider;
    default:
      return null;
  }
}
