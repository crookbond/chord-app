/**
 * Search provider factory (mirrors weather/index.ts, ADR 0091's seam).
 *
 * `SEARCH_PROVIDER` empty disables the `search_web` bot tool entirely — the
 * executor tells the model live search is unavailable rather than letting it
 * fabricate a result.
 */
import { env } from '../../config/env.js';
import { googleSearchProvider } from './google.js';
import { mockSearchProvider } from './mock.js';
import type { SearchProvider } from './types.js';

export type { SearchProvider, SearchResult } from './types.js';

export function getSearchProvider(): SearchProvider | null {
  switch (env.SEARCH_PROVIDER) {
    case 'google':
      return googleSearchProvider;
    case 'mock':
      return mockSearchProvider;
    default:
      return null;
  }
}
