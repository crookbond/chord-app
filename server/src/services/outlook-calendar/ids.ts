/**
 * ADR 0228 — how an Outlook calendar is named inside Chord.
 *
 * `calendar_sources.google_calendar_id` and `events.google_calendar_id` are the
 * generic source-id columns (ADR 0057). An Outlook calendar is stored there as
 * `outlook:<accountId>:<graphCalendarId>`: the prefix tells the sync engine
 * which provider to talk to, and the account id says whose token to use — no
 * join needed to route a write.
 */
const PREFIX = 'outlook:';

export function outlookCalendarKey(accountId: string, graphCalendarId: string): string {
  return `${PREFIX}${accountId}:${graphCalendarId}`;
}

export function isOutlookCalendarKey(id: string | null | undefined): boolean {
  return !!id && id.startsWith(PREFIX);
}

export function parseOutlookCalendarKey(
  key: string | null | undefined,
): { accountId: string; calendarId: string } | null {
  if (!key || !key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { accountId: rest.slice(0, sep), calendarId: rest.slice(sep + 1) };
}

/** Every calendar key of one account starts with this. */
export function outlookAccountKeyPrefix(accountId: string): string {
  return `${PREFIX}${accountId}:`;
}
