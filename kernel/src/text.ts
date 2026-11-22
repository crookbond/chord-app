/**
 * Generic text helpers shared across server + mobile (imported via
 * `@chord/kernel`). Kept runtime-free so server tests can use them.
 */

/** Lowercase, trim, and collapse internal whitespace — for case/space-
 *  insensitive de-duplication of free-text (list items, task titles). */
export function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
