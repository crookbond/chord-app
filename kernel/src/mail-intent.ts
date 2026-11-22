/**
 * Reading a person out of a plain-language mail question (ADR 0270).
 *
 * The bot is asked to pass a person in the search tool's `from` / `to` fields,
 * and usually does. This is the fallback for when it does not (and for the
 * mock and text-fence providers, which pass the user's words through): it
 * recognises the handful of ways people ask for someone's mail.
 *
 * What it returns is a CANDIDATE. The caller checks it against the user's own
 * mail; a name that matches nobody goes back into the free text, so "email
 * from the school about the trip" still searches for "school" if no sender is
 * called that.
 */

export interface MailIntent {
  /** Remaining free text (the topic). */
  text: string;
  from?: string;
  to?: string;
  /** ISO instant: only mail after this. */
  after?: string;
}

const LEAD = String.raw`^(?:please\s+)?(?:(?:show|find|get|list|search|pull up|look up|look for)\s+(?:me\s+)?)?(?:(?:all|any|the|my|recent|latest)\s+)*`;
const MAIL = String.raw`(?:e-?mails?|mails?|messages?|notes?|threads?)`;
const TOPIC = String.raw`(?:\s+(?:about|re|regarding|on|for|mentioning)\s+(?<topic>.+?))?`;
const WHEN = String.raw`(?:\s+(?<when>(?:in\s+the\s+)?(?:last|past)\s+(?:\d+\s+)?(?:days?|weeks?|months?|years?)|this\s+(?:week|month|year)|yesterday|today|recently))?`;
const TAIL = String.raw`${TOPIC}${WHEN}\s*[?.!]*$`;
const WHO = String.raw`(?<who>[\p{L}][\p{L}\p{N}'.@_+-]*(?:\s+[\p{L}][\p{L}\p{N}'.@_+-]*){0,3}?)`;

const PATTERNS: Array<{ re: RegExp; dir: 'from' | 'to' }> = [
  // "emails I sent to Bill", "what did I send to bob@x.com"
  { re: new RegExp(`${LEAD}(?:${MAIL}\\s+)?(?:that\\s+)?(?:i|we)\\s+(?:sent|wrote|emailed|mailed)(?:\\s+to)?\\s+${WHO}${TAIL}`, 'iu'), dir: 'to' },
  { re: new RegExp(`^what\\s+did\\s+(?:i|we)\\s+(?:send|write)(?:\\s+to)?\\s+${WHO}${TAIL}`, 'iu'), dir: 'to' },
  // "emails from Bill about the cabin", "from Bill"
  { re: new RegExp(`${LEAD}(?:${MAIL}\\s+)?(?:from|by|sent\\s+by)\\s+${WHO}${TAIL}`, 'iu'), dir: 'from' },
  // "what did Bill send me (about ...)", "what has Bill emailed"
  { re: new RegExp(`^what\\s+(?:did|has|have)\\s+${WHO}\\s+(?:send|sent|email|emailed|write|written|mail|mailed)(?:\\s+(?:me|us))?${TAIL}`, 'iu'), dir: 'from' },
  // "Bill Smith about the cabin" - only with a topic, or it is just a keyword search
  { re: new RegExp(`^${WHO}\\s+(?:about|re|regarding)\\s+(?<topic>.+?)${WHEN}\\s*[?.!]*$`, 'iu'), dir: 'from' },
];

const STOP_WHO = new Set(['me', 'us', 'anyone', 'anybody', 'someone', 'everyone', 'it', 'this', 'that', 'them']);

function rollingAfter(when: string, nowMs: number): string | undefined {
  const w = when.toLowerCase();
  const day = 86_400_000;
  if (w === 'today') return new Date(nowMs - day).toISOString();
  if (w === 'yesterday') return new Date(nowMs - 2 * day).toISOString();
  if (w === 'recently') return new Date(nowMs - 14 * day).toISOString();
  const m = /(\d+)?\s*(day|week|month|year)/.exec(w);
  if (!m) return undefined;
  const n = Number(m[1] ?? 1);
  const unit = { day: 1, week: 7, month: 31, year: 366 }[m[2] as 'day' | 'week' | 'month' | 'year'];
  return new Date(nowMs - n * unit * day).toISOString();
}

export function parseMailIntent(raw: string, nowMs = Date.now()): MailIntent {
  const text = raw.trim();
  for (const { re, dir } of PATTERNS) {
    const m = re.exec(text);
    if (!m?.groups?.who) continue;
    const who = m.groups.who.replace(/^(?:the|my|our)\s+/i, '').trim();
    if (!who || STOP_WHO.has(who.toLowerCase())) continue;
    const out: MailIntent = { text: (m.groups.topic ?? '').trim() };
    out[dir] = who;
    if (m.groups.when) {
      const after = rollingAfter(m.groups.when, nowMs);
      if (after) out.after = after;
    }
    return out;
  }
  return { text };
}
