/**
 * List-name matching — the ONE rule every read and every write agrees on.
 *
 * Read and write used to disagree: `get_list` stemmed and prefix-matched so
 * "restaurant list" found "Restaurants", while the write behind
 * `add_list_item` compared names with a raw `=`. So the bot read one list and
 * then created a second one next to it, and a user asking about "restaurants"
 * accumulated a card per casing the model happened to emit.
 */
import { normalizeText } from './text';

/**
 * Fold one word toward a form its singular and plural share.
 *
 * Deliberately NOT "strip the plural suffix": that rule cannot be written
 * correctly in one pass, because nothing in the surface form says whether a
 * trailing "es" is the suffix ("boxes") or an "e" stem plus "s" ("notes").
 * Stripping both characters broke the very case the stemmer exists for -
 * "Notes" folded to "not" while "Note" stayed "note", so the two never
 * matched, and "movies" became "movy". Instead push BOTH forms to the same
 * lossy stem: drop a trailing "s", then a trailing "e", then map "y" to "i".
 * note/notes both land on "not", movie/movies on "movi", story/stories on
 * "stori".
 *
 * The stem is never shown to anyone, so being a non-word costs nothing. The
 * "s" step takes no length guard because "do"/"dos" must fold together for
 * "To-do"/"To-dos"; the cost is that a genuinely short "-us" word ("bus")
 * does not match its plural.
 */
function foldWord(w: string): string {
  let t = w;
  if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith('y')) t = `${t.slice(0, -1)}i`;
  return t;
}

/**
 * Tokens for matching: lowercased, punctuation dropped, the filler word
 * "list" removed, singular and plural folded together so
 * "groceries"/"grocery" and "books"/"book" collapse.
 *
 * Empties are dropped AFTER folding as well as before: a possessive leaves a
 * bare "s" token (Nolan + s) that folds away to nothing.
 */
export function listNameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'list' && w !== 'lists')
    .map(foldWord)
    .filter((w) => w.length > 0);
}

/**
 * Canonical identity of a list name: two names sharing a key ARE the same
 * list. Names that tokenize to nothing ("List", "!!!") fall back to their
 * normalized raw text, so they collide only with themselves.
 */
export function listNameKey(s: string): string {
  return listNameTokens(s).join(' ') || normalizeText(s);
}

/**
 * Looser than the key: every query token prefix-matches (in either
 * direction) some token of the candidate. "books" finds "Books to read";
 * "grocery" finds "Groceries". Used to offer candidates when there is no
 * exact key match — never to pick a list silently.
 */
export function listNameLooseMatch(candidate: string, query: string): boolean {
  const q = listNameTokens(query);
  if (q.length === 0) return false;
  const c = listNameTokens(candidate);
  return q.every((qt) => c.some((ct) => ct === qt || ct.startsWith(qt) || qt.startsWith(ct)));
}

export type ListNameResolution<T> =
  | { status: 'resolved'; match: T }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'none' };

/**
 * Resolve a spoken name against a set of lists.
 *
 * An exact key match always wins, so "books" picks "Books" over "Books to
 * read" rather than reporting the pair as ambiguous. Failing that, a single
 * loose match resolves and several stay ambiguous — the caller asks. Order
 * matters only for the pathological case of two lists sharing a key (rows
 * that predate migration 042): the FIRST wins, so pass oldest-first and the
 * original is the one that keeps growing.
 */
export function resolveListName<T extends { name: string }>(
  lists: readonly T[],
  query: string,
): ListNameResolution<T> {
  const key = listNameKey(query);
  if (!key) return { status: 'none' };
  const exact = lists.filter((l) => listNameKey(l.name) === key);
  if (exact.length > 0) return { status: 'resolved', match: exact[0] };
  const loose = lists.filter((l) => listNameLooseMatch(l.name, query));
  if (loose.length === 1) return { status: 'resolved', match: loose[0] };
  if (loose.length > 1) return { status: 'ambiguous', candidates: loose };
  return { status: 'none' };
}
