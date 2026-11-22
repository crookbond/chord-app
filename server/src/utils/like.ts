/**
 * A LIKE / ILIKE pattern matching `text` anywhere, with `%`, `_` and `\`
 * escaped so they match themselves. Postgres's default LIKE escape character
 * is the backslash, so no ESCAPE clause is needed. Without this a title the
 * model passes as `%` matches every row.
 */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}
