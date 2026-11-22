/**
 * ADR 0313 — how a calendar of an attached (secondary) Gmail is named inside
 * Chord: `gacct:<accountId>:<googleCalendarId>` in the generic source-id
 * columns, like Outlook's `outlook:<accountId>:<id>` (ADR 0228). The prefix
 * picks the account's token; a bare id is always the login account's.
 */
const PREFIX = 'gacct:';

export function gmailCalendarKey(accountId: string, googleCalendarId: string): string {
  return `${PREFIX}${accountId}:${googleCalendarId}`;
}

export function isGmailCalendarKey(id: string | null | undefined): boolean {
  return !!id && id.startsWith(PREFIX);
}

export function parseGmailCalendarKey(
  key: string | null | undefined,
): { accountId: string; calendarId: string } | null {
  if (!key || !key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { accountId: rest.slice(0, sep), calendarId: rest.slice(sep + 1) };
}

/** Every calendar key of one account starts with this. */
export function gmailAccountKeyPrefix(accountId: string): string {
  return `${PREFIX}${accountId}:`;
}
