/**
 * Search operators (ADR 0126 + ADR 0142 `label:`).
 *
 * `from:`, `has:attachment`, a date range, and `label:` lifted out of the
 * query string so that both search surfaces read a query the same way - the
 * ADR 0085 rule applied one step earlier, to the query rather than to the
 * matching.
 *
 * Deliberately small: these are the ones people type. Anything unrecognised
 * stays in the free text, so searching for "notes:" finds "notes:" rather than
 * silently dropping it.
 */

export interface SearchQuery {
  /** What is left after the operators are lifted out. May be empty. */
  text: string;
  /** A sender: an address, a domain or a name (ADR 0270 resolves it). */
  from?: string;
  /** A recipient, for mail the user sent (ADR 0270). */
  to?: string;
  hasAttachment?: boolean;
  /** ISO instants, inclusive. */
  after?: string;
  before?: string;
  /** ADR 0142 — Chord label name (case-insensitive) or exact provider label id. */
  label?: string;
}

const OPERATOR =
  /(^|\s)(from|to|has|after|before|newer_than|older_than|label):("[^"]*"|\S*)/gi;

/** "3d" / "2w" / "1m" - how long ago, as an instant. */
function relativeDate(value: string, nowMs: number): string | undefined {
  const m = /^(\d+)\s*([dwmy])$/i.exec(value.trim());
  if (!m) return undefined;
  const days = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase() as 'd' | 'w' | 'm' | 'y'];
  return new Date(nowMs - Number(m[1]) * days * 86_400_000).toISOString();
}

/** A bare yyyy-mm-dd. Anything vaguer stays free text rather than being guessed. */
function absoluteDate(value: string): string | undefined {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function parseSearchQuery(raw: string, nowMs = Date.now()): SearchQuery {
  const out: SearchQuery = { text: '' };
  let consumed = false;

  const rest = raw.replace(OPERATOR, (whole, lead: string, op: string, rawValue: string) => {
    const value = rawValue.replace(/^"|"$/g, '').trim();
    // "from:" with nothing after it is a word someone typed, not an operator.
    if (!value) return whole;
    const key = op.toLowerCase();

    if (key === 'from') {
      out.from = value.toLowerCase();
      consumed = true;
      return lead;
    }
    if (key === 'to') {
      out.to = value.toLowerCase();
      consumed = true;
      return lead;
    }
    if (key === 'label') {
      out.label = value;
      consumed = true;
      return lead;
    }
    if (key === 'has') {
      if (!/^attachments?$/i.test(value)) return whole;
      out.hasAttachment = true;
      consumed = true;
      return lead;
    }
    const date =
      key === 'newer_than' || key === 'older_than' ? relativeDate(value, nowMs) : absoluteDate(value);
    if (!date) return whole;
    if (key === 'after' || key === 'newer_than') out.after = date;
    else out.before = date;
    consumed = true;
    return lead;
  });

  if (!consumed) return { text: raw.trim() };
  out.text = rest.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Did the query use an operator?
 *
 * Every one of them is a question only mail can answer - no other searchable
 * thing has a sender or an attachment, and nothing else filters by date - so
 * an operator narrows the search to mail rather than quietly returning
 * unfiltered tasks beside filtered mail.
 */
export function hasSearchOperators(q: SearchQuery): boolean {
  return (
    q.from !== undefined ||
    q.to !== undefined ||
    q.hasAttachment !== undefined ||
    q.after !== undefined ||
    q.before !== undefined ||
    q.label !== undefined
  );
}
