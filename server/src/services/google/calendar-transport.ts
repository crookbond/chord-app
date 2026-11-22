/**
 * What the two-way sync engine needs from a calendar provider (ADR 0228).
 *
 * The engine (`two-way-sync.service.ts`) speaks one event shape — Google's —
 * and one set of verbs. Google implements them directly; Outlook translates
 * (`outlook-calendar/transport.ts`). Everything the engine decides — merge
 * rules, invite adoption, series adoption, reverse-delete — is written once.
 */
import type { GoogleEventResource } from './two-way-sync.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

/** The pull window. Reverse-delete only judges rows inside it, so a provider
 *  that lists a different window would delete events it never asked about. */
export const PULL_PAST_DAYS = 7;
export const PULL_FUTURE_DAYS = 365;

/**
 * A provider write that came back non-OK, carrying the status so the caller
 * can tell a retry-worthy failure from a hopeless one — and the response BODY,
 * which the actual rejection reason lives in (e.g. `{"error":{"errors":
 * [{"reason":"invalid","message":"Invalid time range."}]}}`). Prod: an
 * `events.insert 400` sat undiagnosable for a Resy reservation confirm
 * because this class discarded the body, and the log line ("events.insert
 * 400 (giving up until the event changes)") was the only trace — no way to
 * tell WHY short of guessing from the request shape.
 */
export class CalendarWriteError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly body: string = '',
  ) {
    super(`${op} ${status}${body ? `: ${body}` : ''}`);
  }
}

/** Read the response body for an error report without throwing a second
 *  error if the body can't be read (network cut mid-response, etc). */
export async function safeErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1000);
  } catch {
    return '';
  }
}

export interface CalendarWriteResponse {
  id: string;
  etag?: string;
  iCalUID?: string;
  sequence?: number;
}

export interface ChangePage {
  items: GoogleEventResource[];
  nextSyncToken: string | null;
  /** True when the fetch used no cursor (initial or cursor-expired) — `items`
   *  is then the complete non-cancelled set in the window, so absent local rows
   *  can be reverse-deleted. A delta omits unchanged events, so absence there
   *  means nothing. */
  wasFullSync: boolean;
}

/**
 * ADR 0323 — the outcome of asking a calendar for a video call on one of its
 * events. Never a throw and never an assumption: `unsupported` is this
 * calendar saying no (a personal Outlook account has no Teams for Business,
 * an unlicensed tenant refuses — and Graph can accept the write and do
 * nothing, which is the same answer to the only person who cares).
 */
export type OnlineMeetingResult =
  | {
      ok: true;
      joinUrl: string | null;
      /** The provider's answer to the write, so the caller can keep a stored
       *  etag current without a second read — as `patch` already returns. */
      written?: CalendarWriteResponse;
    }
  | { ok: false; reason: 'unsupported' | 'error' };

export interface CalendarTransport {
  /** `notify` = the event has guests the provider should email. */
  insert(
    calendarId: string,
    body: Record<string, unknown>,
    notify: boolean,
  ): Promise<CalendarWriteResponse>;
  /** `'stale'` = the provider refused on `etag`: the event changed there.
   *  `conference` = the body carries Google `conferenceData` (Meet link). */
  patch(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    opts: { etag?: string | null; notify: boolean; conference?: boolean },
  ): Promise<CalendarWriteResponse | 'stale'>;
  get(calendarId: string, eventId: string): Promise<GoogleEventResource | null>;
  /** Already gone counts as removed. `notify` = tell the event's guests it
   *  was cancelled (ADR 0328); Graph always does for a meeting's organizer. */
  remove(calendarId: string, eventId: string, etag?: string | null, notify?: boolean): Promise<void>;
  listChanges(calendarId: string, syncToken: string | null): Promise<ChangePage>;
  /**
   * ADR 0323 — put this provider's own video call on the event and hand back
   * its join link: a Google Meet, a Teams meeting. One verb rather than a
   * conference-shaped body each provider reinterprets, because the two write
   * nothing alike — Google creates a conference through `conferenceData`,
   * Graph sets two fields and initializes a read-only third — and only the
   * provider knows whether its answer really happened.
   *
   * `notify` = the event has guests the provider should email about it.
   */
  addOnlineMeeting(
    calendarId: string,
    eventId: string,
    opts: { requestId: string; notify: boolean },
  ): Promise<OnlineMeetingResult>;
}

export async function gfetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

export function googleCalendarTransport(accessToken: string): CalendarTransport {
  const eventsUrl = (calendarId: string) =>
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  const eventUrl = (calendarId: string, eventId: string) =>
    `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;

  const api: CalendarTransport = {
    async insert(calendarId, body, notify) {
      const res = await gfetch(
        `${eventsUrl(calendarId)}${notify ? '?sendUpdates=all' : ''}`,
        accessToken,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!res.ok) throw new CalendarWriteError('events.insert', res.status, await safeErrorBody(res));
      return (await res.json()) as CalendarWriteResponse;
    },

    async patch(calendarId, eventId, body, opts) {
      const q = new URLSearchParams();
      if (opts.notify) q.set('sendUpdates', 'all');
      // Without this Google silently drops `conferenceData` from the body.
      if (opts.conference) q.set('conferenceDataVersion', '1');
      const res = await gfetch(
        `${eventUrl(calendarId, eventId)}${q.toString() ? `?${q.toString()}` : ''}`,
        accessToken,
        {
          method: 'PATCH',
          headers: opts.etag ? { 'if-match': opts.etag } : {},
          body: JSON.stringify(body),
        },
      );
      if (res.status === 412 && opts.etag) return 'stale';
      if (!res.ok) throw new CalendarWriteError('events.patch', res.status, await safeErrorBody(res));
      return (await res.json()) as CalendarWriteResponse;
    },

    async get(calendarId, eventId) {
      const res = await gfetch(eventUrl(calendarId, eventId), accessToken);
      if (!res.ok) return null;
      const json = (await res.json()) as GoogleEventResource & { hangoutLink?: string };
      // ADR 0323 — Google's own name for the Meet link, read into the
      // provider-neutral field the engine's shape carries.
      return json.hangoutLink ? { ...json, videoCallLink: json.hangoutLink } : json;
    },

    async remove(calendarId, eventId, etag, notify) {
      const res = await gfetch(`${eventUrl(calendarId, eventId)}${notify ? '?sendUpdates=all' : ''}`, accessToken, {
        method: 'DELETE',
        headers: etag ? { 'if-match': etag } : {},
      });
      if (!res.ok && res.status !== 404 && res.status !== 410 && res.status !== 412) {
        throw new CalendarWriteError('events.delete', res.status, await safeErrorBody(res));
      }
    },

    /** All changed events for a calendar, paged. Uses the stored syncToken for
     *  an incremental delta; falls back to a bounded full sync when there is no
     *  token or Google expires it (410). */
    async listChanges(calendarId, syncToken) {
      const base = eventsUrl(calendarId);
      const now = Date.now();
      let useToken = syncToken;
      let items: GoogleEventResource[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;

      for (;;) {
        const p = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
        if (useToken) {
          p.set('syncToken', useToken);
        } else {
          p.set('timeMin', new Date(now - PULL_PAST_DAYS * 86_400_000).toISOString());
          p.set('timeMax', new Date(now + PULL_FUTURE_DAYS * 86_400_000).toISOString());
        }
        if (pageToken) p.set('pageToken', pageToken);

        const res = await gfetch(`${base}?${p.toString()}`, accessToken);
        if (res.status === 410 && useToken) {
          // Token expired — restart a full sync from scratch.
          useToken = null;
          pageToken = undefined;
          items = [];
          continue;
        }
        if (!res.ok) throw new Error(`events.list (${calendarId}) ${res.status}`);
        const json = (await res.json()) as {
          items?: GoogleEventResource[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };
        items.push(...(json.items ?? []));
        if (json.nextPageToken) {
          pageToken = json.nextPageToken;
          continue;
        }
        nextSyncToken = json.nextSyncToken ?? null;
        break;
      }
      // useToken is null when we started without a token or Google expired it
      // (410) and we restarted a full window sync.
      return { items, nextSyncToken, wasFullSync: useToken === null };
    },

    /**
     * ADR 0317 — the same create request Google Calendar's own "Add Google
     * Meet video conferencing" sends. Google may answer before the link
     * exists, so a missing one is re-read once and then reported as pending
     * rather than refused: a Meet really does arrive a moment later.
     */
    async addOnlineMeeting(calendarId, eventId, opts) {
      const written = await api.patch(
        calendarId,
        eventId,
        {
          conferenceData: {
            createRequest: {
              requestId: opts.requestId,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        },
        { notify: opts.notify, conference: true },
      );
      if (written === 'stale') return { ok: false, reason: 'error' };
      const link =
        (written as { hangoutLink?: string }).hangoutLink ??
        (await api.get(calendarId, eventId).catch(() => null))?.videoCallLink ??
        null;
      return { ok: true, joinUrl: link, written };
    },
  };

  return api;
}
