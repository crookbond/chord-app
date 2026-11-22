/** A live web-search hit, for the `search_web` bot tool. */
export interface SearchResult {
  title: string;
  /** Short excerpt from the page, for the model to summarize honestly. */
  snippet: string;
  url: string;
}

export interface SearchProvider {
  name: string;
  /** Never throws — same convention as WeatherProvider. A failed request
   *  degrades to an empty array; the executor's "unavailable" case is
   *  getSearchProvider() returning null, not an error from a configured one. */
  search(query: string): Promise<SearchResult[]>;
}
