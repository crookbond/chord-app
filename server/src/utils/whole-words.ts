/**
 * Whole-word matching (ADR 0288). A substring test reads "date" into "update"
 * and "link" into "unlinked"; deciding relevance on that put unrelated files in
 * front of the model and under its reply. These compare words, not letters.
 */

/** The lowercase words of `text`, letters and digits only. */
export function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function wordSet(text: string): Set<string> {
  return new Set(words(text));
}

/** `word` is in `set` as itself or with a plain plural ending added or removed. */
export function hasWord(set: ReadonlySet<string>, word: string): boolean {
  if (set.has(word) || set.has(`${word}s`) || set.has(`${word}es`)) return true;
  if (word.endsWith('es') && set.has(word.slice(0, -2))) return true;
  return word.endsWith('s') && set.has(word.slice(0, -1));
}
