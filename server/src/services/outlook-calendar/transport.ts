/**
 * ADR 0228 — the Outlook side of two-way calendar sync, over Microsoft Graph.
 *
 * Implements the engine's `CalendarTransport` (see
 * `google/calendar-transport.ts`) plus the three calls only Outlook needs:
 * listing calendars, finding an invitation by its UID, and answering one.
 *
 * Calendar ids arrive namespaced (`outlook:<accountId>:<id>`); event ids are
 * Graph's own. Every call asks for immutable ids, so an event keeps its id
 * when it is moved between calendars, and for UTC times and plain-text bodies,
 * which is what `map.ts` reads.
 *
 * Not yet run against a live mailbox: the request and response shapes are
 * Graph's documented ones, and the tests pin them at the fetch boundary.
 */
import {
  CalendarWriteError,
  PULL_FUTURE_DAYS,
  PULL_PAST_DAYS,
  safeErrorBody,
  type CalendarTransport,
  type CalendarWriteResponse,
  type ChangePage,
} from '../google/calendar-transport.js';
import { parseOutlookCalendarKey } from './ids.js';
import { fetchWithTimeout } from '../../utils/fetch-timeout.js';
import {
  googleBodyToGraph,
  graphDeltaToResources,
  graphEventToResource,
  needsFullBody,
  TEAMS_PROVIDER,
  type GraphCalendar,
  type GraphEvent,
  type RemovedOccurrence,
} from './map.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text", IdType="ImmutableId"';

/**
 * How long a delta cursor is used before a full listing replaces it. A Graph
 * calendar delta is tied to the window it was started with, so the window
 * only moves forward when the listing starts over — and a full listing is
 * also what removes a local event the delta never mentioned.
 */
const FULL_RESYNC_MS = 12 * 60 * 60 * 1000;

/** Events per listing whose cut-off preview is replaced by the full body. */
const BODY_FETCH_CAP = 50;
const BODY_FETCH_PARALLEL = 4;

export type OutlookRsvp = 'accepted' | 'declined' | 'tentative';

export interface OutlookCalendarApi extends CalendarTransport {
  listCalendars(): Promise<GraphCalendar[]>;
  /** The id of the event an invitation put on the calendar, or null. */
  findByICalUid(icalUid: string): Promise<string | null>;
  /** Answer an invitation; Outlook tells the organizer. */
  respond(eventId: string, response: OutlookRsvp): Promise<boolean>;
}

interface DeltaCursor {
  link: string;
  /** When the listing this cursor continues was started. */
  at: string;
}

function parseCursor(token: string | null): DeltaCursor | null {
  if (!token) return null;
  try {
    const c = JSON.parse(token) as Partial<DeltaCursor>;
    return typeof c.link === 'string' && typeof c.at === 'string' ? { link: c.link, at: c.at } : null;
  } catch {
    return null;
  }
}

function nativeCalendarId(calendarKey: string): string {
  const parsed = parseOutlookCalendarKey(calendarKey);
  if (!parsed) throw new Error(`not an outlook calendar id: ${calendarKey}`);
  return parsed.calendarId;
}

async function graphFetch(
  accessToken: string,
  url: string,
  init: RequestInit = {},
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(
      url,
      {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          Prefer: PREFER,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      },
      'outlook calendar request',
    );
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers?.get?.('retry-after') ?? 0);
      await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1)));
      continue;
    }
    return res;
  }
}

const RSVP_ACTION: Record<OutlookRsvp, string> = {
  accepted: 'accept',
  tentative: 'tentativelyAccept',
  declined: 'decline',
};

/**
 * @param displayTz the reader's IANA zone; pulled times are restated in it.
 */
export function outlookCalendarApi(accessToken: string, displayTz: string | null): OutlookCalendarApi {
  const eventUrl = (eventId: string) => `${GRAPH}/me/events/${encodeURIComponent(eventId)}`;

  async function getRaw(eventId: string): Promise<GraphEvent | null> {
    const res = await graphFetch(accessToken, eventUrl(eventId));
    if (!res.ok) return null;
    return (await res.json()) as GraphEvent;
  }

  /**
   * A delta can list an event with only its short `bodyPreview`, which
   * cut descriptions off mid-link. Those events get their body read once per
   * listing, a few at a time and at most BODY_FETCH_CAP per listing; one that
   * cannot be read keeps its preview.
   */
  async function fillCutOffBodies(events: GraphEvent[]): Promise<void> {
    const todo = events.filter(needsFullBody).slice(0, BODY_FETCH_CAP);
    for (let i = 0; i < todo.length; i += BODY_FETCH_PARALLEL) {
      await Promise.all(
        todo.slice(i, i + BODY_FETCH_PARALLEL).map(async (ev) => {
          try {
            const res = await graphFetch(accessToken, `${eventUrl(ev.id)}?$select=body`);
            if (!res.ok) return;
            const json = (await res.json()) as Pick<GraphEvent, 'body'>;
            if (json.body?.content) ev.body = json.body;
          } catch {
            // Keep the preview.
          }
        }),
      );
    }
  }

  /** Graph keeps no exception list on a series: a removed occurrence is
   *  removed by deleting that one instance. Already gone is fine. */
  async function removeOccurrences(masterId: string, removals: RemovedOccurrence[]): Promise<void> {
    for (const r of removals) {
      const p = new URLSearchParams({
        startDateTime: r.from,
        endDateTime: r.to,
        $select: 'id,start',
        $top: '10',
      });
      const res = await graphFetch(accessToken, `${eventUrl(masterId)}/instances?${p.toString()}`);
      if (!res.ok) {
        throw new CalendarWriteError('outlook events.instances', res.status, await safeErrorBody(res));
      }
      const body = (await res.json()) as { value?: GraphEvent[] };
      for (const inst of body.value ?? []) {
        if (r.startMs !== null) {
          const startMs = inst.start ? Date.parse(`${inst.start.dateTime.slice(0, 19)}Z`) : NaN;
          if (startMs !== r.startMs) continue;
        }
        const del = await graphFetch(accessToken, eventUrl(inst.id), { method: 'DELETE' });
        if (!del.ok && del.status !== 404) {
          throw new CalendarWriteError('outlook events.delete', del.status, await safeErrorBody(del));
        }
      }
    }
  }

  function writeResponse(ev: GraphEvent): CalendarWriteResponse {
    return { id: ev.id, etag: ev['@odata.etag'], iCalUID: ev.iCalUId };
  }

  return {
    async insert(calendarKey, body) {
      const { body: graphBody, removals } = googleBodyToGraph(body, true);
      const res = await graphFetch(
        accessToken,
        `${GRAPH}/me/calendars/${encodeURIComponent(nativeCalendarId(calendarKey))}/events`,
        { method: 'POST', body: JSON.stringify(graphBody) },
      );
      if (!res.ok) throw new CalendarWriteError('outlook events.insert', res.status, await safeErrorBody(res));
      const ev = (await res.json()) as GraphEvent;
      if (removals.length) await removeOccurrences(ev.id, removals);
      return writeResponse(ev);
    },

    // Graph is not sent an etag: without a `sequence` to compare, a refused
    // write would have nothing better to decide by than the timestamps the
    // pull already uses.
    async patch(_calendarKey, eventId, body) {
      const { body: graphBody, removals } = googleBodyToGraph(body, false);
      const res = await graphFetch(accessToken, eventUrl(eventId), {
        method: 'PATCH',
        body: JSON.stringify(graphBody),
      });
      if (!res.ok) throw new CalendarWriteError('outlook events.patch', res.status, await safeErrorBody(res));
      const ev = (await res.json()) as GraphEvent;
      if (removals.length) await removeOccurrences(ev.id, removals);
      return writeResponse(ev);
    },

    async get(_calendarKey, eventId) {
      const ev = await getRaw(eventId);
      return ev ? graphEventToResource(ev, displayTz) : null;
    },

    async remove(_calendarKey, eventId) {
      const res = await graphFetch(accessToken, eventUrl(eventId), { method: 'DELETE' });
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        throw new CalendarWriteError('outlook events.delete', res.status, await safeErrorBody(res));
      }
    },

    async listChanges(calendarKey, syncToken): Promise<ChangePage> {
      const calendarId = nativeCalendarId(calendarKey);
      const now = Date.now();
      const initialUrl = (): string => {
        const p = new URLSearchParams({
          startDateTime: new Date(now - PULL_PAST_DAYS * 86_400_000).toISOString(),
          endDateTime: new Date(now + PULL_FUTURE_DAYS * 86_400_000).toISOString(),
        });
        return `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${p.toString()}`;
      };

      let cursor = parseCursor(syncToken);
      if (cursor && now - Date.parse(cursor.at) > FULL_RESYNC_MS) cursor = null;
      let full = cursor === null;
      let url = cursor?.link ?? initialUrl();
      let events: GraphEvent[] = [];
      let deltaLink: string | null = null;

      for (;;) {
        const res = await graphFetch(accessToken, url, {
          headers: { Prefer: `${PREFER}, odata.maxpagesize=200` },
        });
        // An expired or unknown cursor: start the listing over.
        if (!full && (res.status === 410 || res.status === 400)) {
          full = true;
          events = [];
          url = initialUrl();
          continue;
        }
        if (!res.ok) throw new Error(`outlook calendarView.delta ${res.status}`);
        const json = (await res.json()) as {
          value?: GraphEvent[];
          '@odata.nextLink'?: string;
          '@odata.deltaLink'?: string;
        };
        events.push(...(json.value ?? []));
        if (json['@odata.nextLink']) {
          url = json['@odata.nextLink'];
          continue;
        }
        deltaLink = json['@odata.deltaLink'] ?? null;
        break;
      }

      await fillCutOffBodies(events);
      let mapped = graphDeltaToResources(events, displayTz);
      if (mapped.missingMasters.length) {
        const fetched = new Map<string, GraphEvent>();
        for (const id of mapped.missingMasters) {
          const master = await getRaw(id);
          if (master) fetched.set(id, master);
        }
        mapped = graphDeltaToResources(events, displayTz, fetched);
      }

      const startedAt = full ? new Date(now).toISOString() : cursor!.at;
      return {
        items: mapped.items,
        nextSyncToken: deltaLink ? JSON.stringify({ link: deltaLink, at: startedAt }) : null,
        wasFullSync: full,
      };
    },

    async listCalendars() {
      const out: GraphCalendar[] = [];
      let url: string | undefined =
        `${GRAPH}/me/calendars?$top=100&$select=id,name,canEdit,isDefaultCalendar,hexColor,owner`;
      while (url) {
        const res: Response = await graphFetch(accessToken, url);
        if (!res.ok) throw new Error(`outlook calendars.list ${res.status}`);
        const json = (await res.json()) as { value?: GraphCalendar[]; '@odata.nextLink'?: string };
        out.push(...(json.value ?? []));
        url = json['@odata.nextLink'];
      }
      return out;
    },

    async findByICalUid(icalUid) {
      const p = new URLSearchParams({
        $filter: `iCalUId eq '${icalUid.replace(/'/g, "''")}'`,
        $select: 'id',
        $top: '2',
      });
      const res = await graphFetch(accessToken, `${GRAPH}/me/events?${p.toString()}`);
      if (!res.ok) return null;
      const json = (await res.json()) as { value?: GraphEvent[] };
      return json.value?.[0]?.id ?? null;
    },

    /**
     * ADR 0323 — a Teams meeting on an Outlook / 365 event: set
     * `isOnlineMeeting` and `onlineMeetingProvider`, and Graph initializes the
     * read-only `onlineMeeting` whose `joinUrl` is the link.
     *
     * Asked of the calendar first, which is Microsoft's own documented test:
     * a calendar's `allowedOnlineMeetingProviders` names the providers it can
     * host, and a personal account has no Teams for Business while a tenant
     * without the licence refuses. A calendar that cannot be read is not
     * taken as a yes — guessing costs a write that reports a meeting nobody
     * can join.
     *
     * The write is then VERIFIED rather than trusted. Graph is reported to
     * answer 200 with `isOnlineMeeting: false` where the provider is not
     * allowed, and an accepted write that did nothing is the failure ADR 0137
     * is about — so a response with no join link is re-read once and then
     * refused, never passed on as pending. Unlike a Meet, a Teams join URL
     * comes back with the write, so there is nothing to wait for.
     */
    async addOnlineMeeting(calendarKey, eventId) {
      const calRes = await graphFetch(
        accessToken,
        `${GRAPH}/me/calendars/${encodeURIComponent(nativeCalendarId(calendarKey))}?$select=allowedOnlineMeetingProviders`,
      );
      if (!calRes.ok) return { ok: false, reason: 'error' };
      const cal = (await calRes.json()) as GraphCalendar;
      if (!(cal.allowedOnlineMeetingProviders ?? []).includes(TEAMS_PROVIDER)) {
        return { ok: false, reason: 'unsupported' };
      }

      const res = await graphFetch(accessToken, eventUrl(eventId), {
        method: 'PATCH',
        body: JSON.stringify({ isOnlineMeeting: true, onlineMeetingProvider: TEAMS_PROVIDER }),
      });
      if (!res.ok) return { ok: false, reason: 'error' };
      const written = (await res.json()) as GraphEvent;
      const joinUrl =
        written.onlineMeeting?.joinUrl ??
        (await getRaw(eventId).catch(() => null))?.onlineMeeting?.joinUrl ??
        null;
      // No `notify`: Graph mails a meeting's attendees about a change itself,
      // so there is no `sendUpdates` to pass (the same reason `patch` has none).
      return joinUrl ? { ok: true, joinUrl, written: writeResponse(written) } : { ok: false, reason: 'unsupported' };
    },

    async respond(eventId, response) {
      const res = await graphFetch(accessToken, `${eventUrl(eventId)}/${RSVP_ACTION[response]}`, {
        method: 'POST',
        body: JSON.stringify({ sendResponse: true }),
      });
      return res.ok;
    },
  };
}
