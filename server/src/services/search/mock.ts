/**
 * Deterministic web search for tests and LLM_PROVIDER=mock demos. Never
 * touches the network, mirroring weather/mock.ts and GMAIL_PROVIDER=mock.
 *
 * Results echo the query so a mock-driven demo of `search_web` still reads
 * as a plausible answer rather than an obviously canned one — but the data
 * is fixture, not real, so it must never be mistaken for a live result.
 */
import type { SearchProvider, SearchResult } from './types.js';

export const mockSearchProvider: SearchProvider = {
  name: 'mock',

  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q || q.toLowerCase() === 'nothing') return [];
    return [
      {
        title: `${q} — Overview`,
        snippet: `Mock result for "${q}": a well-reviewed option with typical hours and a central location. (SEARCH_PROVIDER=mock — not a real lookup.)`,
        url: `https://example.com/search?q=${encodeURIComponent(q)}`,
      },
      {
        title: `${q} — Reviews`,
        snippet: `Mock result for "${q}": generally positive feedback, moderate price range.`,
        url: `https://example.com/search?q=${encodeURIComponent(q)}&tab=reviews`,
      },
    ];
  },
};
