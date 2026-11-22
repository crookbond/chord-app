/**
 * Google Custom Search JSON API. Fixed host, no user-supplied URL — unlike
 * ADR 0050's calendar import there is no SSRF surface to guard; a timeout
 * and a try/catch are the whole safety story, same reasoning as
 * weather/open-meteo.ts. Never throws — a failed request degrades to an
 * empty result list so a `search_web` call never crashes a bot turn.
 */
import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { SearchProvider, SearchResult } from './types.js';

const SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';
const TIMEOUT_MS = 6000;
const MAX_RESULTS = 5;

interface CustomSearchShape {
  items?: Array<{ title?: string; snippet?: string; link?: string }>;
}

export const googleSearchProvider: SearchProvider = {
  name: 'google',

  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q || !env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_CX) return [];
    const params = new URLSearchParams({
      key: env.GOOGLE_SEARCH_API_KEY,
      cx: env.GOOGLE_SEARCH_CX,
      q,
      num: String(MAX_RESULTS),
    });
    try {
      const res = await fetch(`${SEARCH_URL}?${params}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.info('search_web: request failed', { status: res.status });
        return [];
      }
      const json = (await res.json()) as CustomSearchShape;
      return (json.items ?? [])
        .filter((item) => item.title && item.link)
        .slice(0, MAX_RESULTS)
        .map((item) => ({
          title: item.title as string,
          snippet: item.snippet ?? '',
          url: item.link as string,
        }));
    } catch (err) {
      logger.info('search_web: request errored', { err });
      return [];
    }
  },
};
