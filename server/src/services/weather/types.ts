/** ADR 0091 — one day's weather, already rendered to a single line. */
export interface DailyWeather {
  /** e.g. "☀️ Sunny · 72°/58°" — single line, safe for a Meta template slot. */
  line: string;
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface GeocodedPlace extends Coordinates {
  place: string;
}

export interface WeatherProvider {
  name: string;
  /** Today's forecast for a point, or null when unavailable. Never throws.
   *  `place` is only for the rendered line ("…in Seville today…"); pass it
   *  when known so the briefing names the location. */
  today(at: Coordinates, tz: string | null, place?: string | null): Promise<DailyWeather | null>;
  /** Resolve a free-text place name to coordinates, or null. Never throws. */
  geocode(query: string): Promise<GeocodedPlace | null>;
}
