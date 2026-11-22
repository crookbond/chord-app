/**
 * The query-side token rules both search surfaces share (ADR 0085), in the
 * utils layer so the blind index can build documents by the same rules that
 * queries are read by. `services/bot/retrieval.ts` re-exports these.
 */
export const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'from', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your',
  'he', 'she', 'it', 'they', 'them', 'their',
  'what', 'where', 'when', 'which', 'who', 'how', 'why',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had',
  'can', 'could', 'would', 'should', 'may', 'might', 'will',
  'get', 'got', 'getting',
  'chord',
  'please', 'thanks', 'thank', 'hey', 'hi', 'ok', 'okay',
]);

/**
 * Is the raw query worth matching literally?
 *
 * The literal arm exists for what FTS cannot tokenize - "512", "Q4", a code
 * embedded in a larger token. It must NOT turn into "match everything": a
 * one-character query, or a query that is nothing but stopwords, would make
 * `%a%` or `%the%` hit almost every row. Below this floor the FTS arm is the
 * only one that runs, which is the behaviour that predates ADR 0085.
 */
export function literalQueryUsable(raw: string): boolean {
  if (raw.length < 3) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  return !tokens.every((t) => STOPWORDS.has(t.replace(/[^a-z0-9]/g, '')));
}

export function extractKeywords(text: string): string[] {
  const toks = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(toks));
}
