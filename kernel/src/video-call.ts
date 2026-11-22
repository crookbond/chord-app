/**
 * ADR 0319 — whether a meeting gets a video-call link by default, and which
 * kind, decided from the provider of the calendar the event is going on.
 * ADR 0323 — an Outlook / Microsoft 365 calendar gets a Teams meeting.
 *
 * Chord creates each provider's own video call: a Google Meet by patching
 * `conferenceData` on a Google Calendar event (ADR 0317), a Teams meeting by
 * setting `isOnlineMeeting` on a Graph event (ADR 0323). It never crosses them
 * — a Meet on a 365 event is a link to a service the organiser never chose.
 * An IMAP mailbox has no calendar of its own at all, so it has nothing to put
 * one on.
 *
 * In kernel because three surfaces ask the same question (the bot executor,
 * the calendar write, and the event editor, which has no test harness of its
 * own) and three copies of a provider rule is how they stop agreeing — the
 * ADR 0085/0127 reasoning.
 */

/** What Chord can put on an event, by the provider that would host it. */
export type VideoCallKind = 'google_meet' | 'teams';

/** What to call it, so the bot's words and the editor's button agree. */
export function videoCallLabel(kind: VideoCallKind): string {
  return kind === 'teams' ? 'Teams meeting' : 'Google Meet';
}

/**
 * How a calendar is named in `events.google_calendar_id` /
 * `calendar_sources.google_calendar_id` (ADR 0057's generic source-id
 * column): a bare id is the login Google account's, `gacct:<accountId>:<id>`
 * an attached Gmail's (ADR 0313), `outlook:<accountId>:<id>` an Outlook /
 * 365 calendar (ADR 0228). A phone-mirrored calendar also stores a bare id
 * there, so a caller that knows the provider says so.
 */
export interface VideoCallCalendar {
  calendarId?: string | null;
  /** `calendar_sources.provider`, when the caller already knows it. */
  provider?: 'google' | 'device' | 'outlook' | null;
}

const OUTLOOK_PREFIX = 'outlook:';
const GMAIL_ACCOUNT_PREFIX = 'gacct:';

/**
 * The video call this calendar gets by default, or null for none.
 *
 * - Google-driven (the login account's own calendars, and an attached
 *   Gmail's `gacct:` calendars) → a Google Meet, which is what Google
 *   Calendar's own "Add Google Meet video conferencing" would add.
 * - Outlook / Microsoft 365 → a Teams meeting (ADR 0323), which is what
 *   Outlook's own "Teams meeting" toggle would add. Never a Google Meet: that
 *   is a link to a service the organiser never chose, and on a work tenant
 *   often one their guests cannot open.
 * - A phone-mirrored calendar → none: Chord reads those, it does not write
 *   them, so there is no provider event to put a conference on. A phone
 *   calendar that is really a Google calendar folds into its Google row
 *   (ADR 0072) and is judged by that row, which is `google`.
 * - No calendar (an IMAP-only mailbox, or an event that lives only in
 *   Chord) → none.
 */
export function videoCallDefaultFor(cal: VideoCallCalendar): VideoCallKind | null {
  const id = cal.calendarId?.trim();
  if (!id) return null;
  if (cal.provider === 'device') return null;
  // Whether that tenant LICENSES Teams is a question only Graph can answer,
  // and it is answered at the write (ADR 0323): this says what the provider
  // offers, not what one mailbox is entitled to.
  if (cal.provider === 'outlook' || id.startsWith(OUTLOOK_PREFIX)) return 'teams';
  // A `gacct:` key and a bare one are both written through the Google
  // Calendar API, each with its own account's token (ADR 0313); a Google
  // calendar id never holds a colon (it is an address, or `primary`), so any
  // other prefixed key belongs to a provider added since this was written
  // and gets no default until someone decides what it can do.
  if (id.startsWith(GMAIL_ACCOUNT_PREFIX)) return 'google_meet';
  return id.includes(':') ? null : 'google_meet';
}

/** Whether this calendar can be given a video call at all, by any means. */
export function canAddVideoCall(cal: VideoCallCalendar): boolean {
  return videoCallDefaultFor(cal) !== null;
}

/**
 * Does the person's own wording ask for a video call?
 *
 * A default is not a request. Through OpenRouter, OpenAI models fill every
 * optional field of a tool call (ADR 0229), so `videoCall: true` arrives on
 * plain "add a meeting at 3" — which is exactly the default this ADR is
 * about, and must follow the calendar's provider rather than be acted on
 * everywhere. A real request is honoured where it can be, and refused in
 * plain words where it cannot.
 *
 * Generous on purpose: a false "they asked" costs an honest refusal on a
 * non-Google calendar, a false "they did not" silently drops a link someone
 * wanted.
 */
export function looksLikeVideoCallRequest(text: string): boolean {
  if (/\b(?:on|via|over|a|by)\s+(?:ms\s+|microsoft\s+)?teams\b/i.test(text)) return true;
  return /\b(video\s?-?\s?(call|chat|conferenc\w*|link|meeting)|google\s?meet|hangout\w*|zoom|teams\s+(call|meeting|link)|web\s?-?ex|conferenc\w*\s+(call|line|link|bridge)|dial\s?-?in|call\s+link|meeting\s+link|join\s+link|virtual\w*|online\s+(call|meeting)|remotely|over\s+(video|a\s+call)|face\s?-?time)\b/i.test(
    text,
  );
}

/**
 * The kind of call the person's own words named, or null when they named no
 * kind ("video call", "Zoom"). Read only once a call was asked for, so
 * "Teams" here is Microsoft Teams, not a sports team.
 */
export function videoCallKindNamed(text: string): VideoCallKind | null {
  if (/\b(?:ms\s+|microsoft\s+)?teams\b/i.test(text)) return 'teams';
  if (/\b(?:google\s?meet|g\s?-?meet|hangouts?)\b/i.test(text)) return 'google_meet';
  return null;
}
