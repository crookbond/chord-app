/**
 * A bot tool call's arguments as they may be logged in production: which
 * fields the model set and to what kind of value, never what the user typed.
 *
 * A chat search returned nothing (2026-10-20) and the log said only
 * `search "from mallory": 0 hit(s)` - which of its filters the model had set
 * was unknowable. Free text (a query, a name, a body) is the user's own words,
 * which the production prompt log deliberately keeps out (PROMPT_LOG), so
 * it is written as its length; a date, a choice from a fixed list, a number
 * or a yes/no says how the call was shaped and carries nothing personal.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/;
const WORDLIKE = /^[a-z][a-z0-9_]{0,31}$/;
/** A Chord row id (`newId`): prefix, underscore, random part. */
const ROW_ID = /^[a-z]{1,8}_[A-Za-z0-9_-]{6,32}$/;
/**
 * Fields whose value is a choice from a fixed list. Only these may show a
 * plain word: anything else ("costco", a list name, a first name) may be
 * the user's words, however short.
 */
const CHOICE = /(kind|action|mode|scope|status|frequency|type|source|rank|groupby|categor(y|ies)|platform|provider|plan|interval|direction|unit|weekdays?|order|priority|response|channel)$/i;

export function toolArgShape(args: unknown, key = ''): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args === 'boolean' || typeof args === 'number') return args;
  if (typeof args === 'string') {
    if (args === '') return '';
    if (DAY.test(args) || INSTANT.test(args)) return args;
    // An id the server made, or a value from a fixed list ("to_do", "receipt").
    if (ROW_ID.test(args) || (CHOICE.test(key) && WORDLIKE.test(args))) return args;
    return `<${args.length} chars>`;
  }
  if (Array.isArray(args)) return args.slice(0, 10).map((v) => toolArgShape(v, key));
  if (typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = toolArgShape(v, k);
    return out;
  }
  return typeof args;
}
