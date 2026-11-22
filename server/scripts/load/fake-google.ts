/**
 * An in-process fake of the slice of Google the calendar sync talks to: the
 * OAuth token endpoint, calendarList, and events list/insert/patch/delete with
 * sync tokens and tombstones. Installed by wrapping `globalThis.fetch`, so the
 * real two-way-sync code runs unmodified — only the network is replaced, and
 * given a configurable round-trip time so its cost is not hidden.
 */
interface FakeEvent {
  id: string;
  version: number;
  deleted: boolean;
  resource: Record<string, unknown>;
}

export interface FakeGoogleStats {
  calls: Record<string, { count: number; totalMs: number }>;
}

const events = new Map<string, Map<string, FakeEvent>>();
let counter = 0;
let version = 0;
const stats: FakeGoogleStats = { calls: {} };

function calStore(id: string): Map<string, FakeEvent> {
  let m = events.get(id);
  if (!m) events.set(id, (m = new Map()));
  return m;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function fakeGoogleStats(): FakeGoogleStats {
  return stats;
}

export function resetFakeGoogleStats(): void {
  stats.calls = {};
}

export function installFakeGoogle(opts: { latencyMs: number }): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const wait = () => {
    const ms = opts.latencyMs * (0.6 + Math.random() * 0.8);
    return ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
  };

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const host = url.hostname;
    if (host !== 'oauth2.googleapis.com' && host !== 'www.googleapis.com') {
      return realFetch(input, init);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    const t0 = performance.now();
    let label = `${method} ${host}${url.pathname}`;
    // Each user's access token is derived from their own refresh token, so
    // every user gets their own calendars: two users' "Family" calendars share
    // an id in Google's API but never share events.
    const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    let res: Response;

    if (host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      label = 'POST oauth/token';
      await wait();
      const form = new URLSearchParams(String(init?.body ?? ''));
      res = json(200, {
        access_token: `fake-at-${form.get('refresh_token') ?? 'anon'}`,
        expires_in: 3600,
        token_type: 'Bearer',
        scope:
          'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify',
      });
    } else if (url.pathname === '/calendar/v3/users/me/calendarList') {
      label = 'GET calendarList';
      await wait();
      res = json(200, {
        items: [
          { id: 'primary', summary: 'Primary', primary: true, accessRole: 'owner', selected: true },
          { id: 'fam_cal', summary: 'Family', accessRole: 'owner', selected: true },
        ],
      });
    } else if (url.pathname === '/calendar/v3/calendars' && method === 'POST') {
      label = 'POST calendars';
      await wait();
      res = json(200, { id: 'fam_cal', summary: 'Family' });
    } else {
      const m = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (!m) {
        res = json(404, { error: { code: 404, message: 'fake google: unhandled ' + url.pathname } });
      } else {
        const calId = decodeURIComponent(m[1]!);
        const evId = m[2] ? decodeURIComponent(m[2]) : null;
        const store = calStore(`${bearer}|${calId}`);
        await wait();
        if (method === 'GET' && !evId) {
          label = 'GET events.list';
          const tok = url.searchParams.get('syncToken');
          const since = tok?.startsWith('v') ? Number(tok.slice(1)) : -1;
          const items = [...store.values()]
            .filter((e) => (since >= 0 ? e.version > since : !e.deleted))
            .map((e) => (e.deleted ? { id: e.id, status: 'cancelled' } : e.resource));
          res = json(200, { items, nextSyncToken: `v${version}` });
        } else if (method === 'GET' && evId) {
          label = 'GET events.get';
          const e = store.get(evId);
          res = e && !e.deleted ? json(200, e.resource) : json(404, {});
        } else if (method === 'POST') {
          label = 'POST events.insert';
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          const id = `gev_${++counter}`;
          version += 1;
          const resource = {
            ...body,
            id,
            iCalUID: `${id}@google.com`,
            etag: `"${version}"`,
            sequence: 0,
            status: 'confirmed',
            updated: new Date().toISOString(),
          };
          store.set(id, { id, version, deleted: false, resource });
          res = json(200, resource);
        } else if (method === 'PATCH' && evId) {
          label = 'PATCH events.patch';
          const e = store.get(evId);
          if (!e || e.deleted) {
            res = json(404, {});
          } else {
            version += 1;
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            e.version = version;
            e.resource = {
              ...e.resource,
              ...body,
              etag: `"${version}"`,
              sequence: Number(e.resource.sequence ?? 0) + 1,
              updated: new Date().toISOString(),
            };
            res = json(200, e.resource);
          }
        } else if (method === 'DELETE' && evId) {
          label = 'DELETE events.delete';
          const e = store.get(evId);
          if (e) {
            version += 1;
            e.deleted = true;
            e.version = version;
          }
          res = json(204, null);
        } else {
          res = json(405, {});
        }
      }
    }

    const s = (stats.calls[label] ??= { count: 0, totalMs: 0 });
    s.count += 1;
    s.totalMs += performance.now() - t0;
    return res;
  }) as typeof fetch;
}
