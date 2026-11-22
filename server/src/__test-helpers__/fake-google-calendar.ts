/**
 * A stateful stand-in for the Google Calendar events API, installed as the
 * global `fetch`. It keeps each event as Google would (a PATCH replaces only
 * the fields it carries, and `attendees` as a whole), so a test can ask what
 * Google holds after Chord's pushes and guest changes (ADR 0295).
 *
 * Pair it with a mock of `@/services/google/oauth.service.js` so no real token
 * exchange happens.
 */
import { vi } from 'vitest';

export interface FakeGoogleEvent {
  id: string;
  etag: string;
  iCalUID: string;
  attendees?: Array<Record<string, unknown>>;
  organizer: { email?: string; self: boolean };
  [field: string]: unknown;
}

export interface FakeGoogleRequest {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

export interface FakeGoogleCalendar {
  events: Map<string, FakeGoogleEvent>;
  requests: FakeGoogleRequest[];
  /** PATCH requests only, in order. */
  patches(): FakeGoogleRequest[];
  /** Guest emails Google holds for an event, sorted, without the organizer. */
  guests(googleId: string): string[];
}

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

export function installFakeGoogleCalendar(): FakeGoogleCalendar {
  const events = new Map<string, FakeGoogleEvent>();
  const requests: FakeGoogleRequest[] = [];
  let n = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      requests.push({ method, url: u, body });
      const m = /\/calendars\/[^/]+\/events(?:\/([^/?]+))?/.exec(u);
      if (!m) return res({});
      const id = m[1] ? decodeURIComponent(m[1]) : null;

      if (method === 'POST' && !id) {
        n++;
        const ev: FakeGoogleEvent = {
          ...(body ?? {}),
          id: `g_evt_${n}`,
          etag: `"e${n}-1"`,
          iCalUID: `g_evt_${n}@google.com`,
          organizer: { self: true },
        };
        events.set(ev.id, ev);
        return res(ev);
      }
      if (!id) return res({ items: [] });
      const ev = events.get(id);
      if (!ev) return res({ error: 'not found' }, 404);
      if (method === 'GET') return res(ev);
      if (method === 'PATCH') {
        const { conferenceData, ...rest } = body ?? {};
        Object.assign(ev, rest);
        // Google drops conferenceData unless conferenceDataVersion=1 is sent.
        if (conferenceData && u.includes('conferenceDataVersion=1')) {
          ev.conferenceData = conferenceData;
          ev.hangoutLink = `https://meet.google.com/${ev.id.replace(/_/g, '-')}`;
        }
        const version = Number(ev.etag.split('-')[1]?.replace('"', '') ?? 1) + 1;
        ev.etag = `"${ev.id}-${version}"`;
        return res(ev);
      }
      if (method === 'DELETE') {
        events.delete(id);
        return res({}, 204);
      }
      return res({});
    }),
  );

  return {
    events,
    requests,
    patches: () => requests.filter((r) => r.method === 'PATCH'),
    guests: (googleId) =>
      (events.get(googleId)?.attendees ?? [])
        .filter((a) => !a.organizer && !a.self)
        .map((a) => String(a.email).toLowerCase())
        .sort(),
  };
}
