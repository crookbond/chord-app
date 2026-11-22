import { describe, expect, it } from 'vitest';

// The VM-side scripts are plain ESM under scripts/deploy/vm (they run as root from a root-owned
// directory, so they cannot live in the app tree). Imported here so CI exercises them.
// @ts-expect-error untyped .mjs
import * as lib from '../../../../scripts/deploy/vm/secrets-lib.mjs';

type Res = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
const ok = (body: unknown): Res => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
const fail = (status: number): Res => ({ ok: false, status, json: async () => ({}), text: async () => '' });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** A fake metadata server + Secret Manager. `secrets` maps name -> value | status code to fail with. */
function fakeGoogle(secrets: Record<string, string | number | Array<string | number>>) {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/token')) return ok({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/project/project-id')) return ok('chord-495323');
    const m = /secrets\/([A-Z0-9_]+)\/versions\/latest:access$/.exec(url);
    if (!m) return fail(404);
    const spec = secrets[m[1]];
    const n = (counters[m[1]] = (counters[m[1]] ?? -1) + 1);
    const cur = Array.isArray(spec) ? spec[Math.min(n, spec.length - 1)] : spec;
    if (typeof cur === 'number') return fail(cur);
    if (cur === undefined) return fail(404);
    return ok({ payload: { data: b64(cur) } });
  };
  return { fetchImpl, calls };
}
const noSleep = async () => undefined;

describe('secrets keys file and env file parsing', () => {
  it('reads names, ignoring comments and blanks, and rejects anything that is not a variable name', () => {
    expect(lib.parseKeysFile('# secrets\nDATABASE_URL\n\n  STRIPE_SECRET_KEY  \n')).toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    expect(() => lib.parseKeysFile('DATABASE_URL\nrm -rf /\n')).toThrow(/bad secret name/);
    expect(() => lib.parseKeysFile('lower_case\n')).toThrow(/bad secret name/);
  });

  it('parses an env file keeping each value exactly as written', () => {
    const m = lib.parseEnvFile('# c\nA=1\nB=postgresql://u:p@h:5432/d?sslmode=no-verify\nC=\nD=has=equals and spaces\n');
    expect(m.get('A')).toBe('1');
    expect(m.get('B')).toBe('postgresql://u:p@h:5432/d?sslmode=no-verify');
    expect(m.get('C')).toBe('');
    expect(m.get('D')).toBe('has=equals and spaces');
  });
});

describe('rendering the tmpfs env file', () => {
  it('writes NAME=value lines with the value untouched (a private key with \\n escapes stays one line)', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\\nMIGT\\n-----END PRIVATE KEY-----';
    expect(lib.renderEnvFile([['APPLE_PRIVATE_KEY', pem], ['STRIPE_SECRET_KEY', 'sk_live_x']])).toBe(
      `APPLE_PRIVATE_KEY=${pem}\nSTRIPE_SECRET_KEY=sk_live_x\n`,
    );
  });

  it('refuses a value with a newline: it would start another assignment', () => {
    expect(() => lib.renderEnvFile([['STRIPE_SECRET_KEY', 'sk_live_x\nDATABASE_URL=postgresql://evil@h/d']])).toThrow(/newline/);
  });

  it('refuses a bad name', () => {
    expect(() => lib.renderEnvFile([['bad name', 'v']])).toThrow(/bad secret name/);
  });
});

describe('fetching from Secret Manager', () => {
  it('returns every value, decoded', async () => {
    const g = fakeGoogle({ DATABASE_URL: 'postgresql://chord:pw@10.59.0.3:5432/chord?sslmode=no-verify', STRIPE_SECRET_KEY: 'sk_live_x' });
    const { entries, failures } = await lib.fetchAll({ names: ['DATABASE_URL', 'STRIPE_SECRET_KEY'], fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(failures).toEqual([]);
    expect(entries).toEqual([
      ['DATABASE_URL', 'postgresql://chord:pw@10.59.0.3:5432/chord?sslmode=no-verify'],
      ['STRIPE_SECRET_KEY', 'sk_live_x'],
    ]);
    expect(g.calls.some((u) => u.includes('/projects/chord-495323/secrets/DATABASE_URL/versions/latest:access'))).toBe(true);
  });

  it('a missing secret is a failure, never a silent skip (a missing DATABASE_URL would mean the local Postgres)', async () => {
    const g = fakeGoogle({ STRIPE_SECRET_KEY: 'sk_live_x' });
    const { entries, failures } = await lib.fetchAll({ names: ['DATABASE_URL', 'STRIPE_SECRET_KEY'], fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(failures).toEqual(['secret DATABASE_URL: Secret Manager answered 404']);
    expect(entries.map(([n]: [string]) => n)).toEqual(['STRIPE_SECRET_KEY']);
  });

  it('reports every failure in one run, and a refused secret (403) is not retried', async () => {
    const g = fakeGoogle({ A: 403, B: 404, C: 'fine' });
    const { failures } = await lib.fetchAll({ names: ['A', 'B', 'C'], fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(failures).toHaveLength(2);
    expect(g.calls.filter((u) => u.includes('/secrets/A/')).length).toBe(1);
  });

  it('retries a transient failure and then succeeds', async () => {
    const g = fakeGoogle({ DATABASE_URL: [503, 429, 'postgresql://ok'] });
    const { entries, failures } = await lib.fetchAll({ names: ['DATABASE_URL'], fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(failures).toEqual([]);
    expect(entries).toEqual([['DATABASE_URL', 'postgresql://ok']]);
  });

  it('gives up after the attempts are spent on a persistent 5xx', async () => {
    const g = fakeGoogle({ DATABASE_URL: 503 });
    const { failures } = await lib.fetchAll({ names: ['DATABASE_URL'], fetchImpl: g.fetchImpl, sleep: noSleep, attempts: 3 });
    expect(failures).toEqual(['secret DATABASE_URL: Secret Manager answered 503']);
    expect(g.calls.filter((u) => u.includes('/secrets/DATABASE_URL/')).length).toBe(3);
  });

  it('never puts a secret value in an error message', async () => {
    const g = fakeGoogle({ A: 'super-secret-value', B: 404 });
    const { failures } = await lib.fetchAll({ names: ['A', 'B'], fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(JSON.stringify(failures)).not.toContain('super-secret-value');
  });
});
