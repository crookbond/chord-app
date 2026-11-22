// Shared by fetch-secrets.mjs and with-env.mjs (ADR 0211). Plain ESM, no dependencies: it runs as
// ROOT on the VM from /usr/local/lib/chord (root-owned), never from the app's own directory, so the
// app's user cannot change code that root runs.

const META = 'http://metadata.google.internal/computeMetadata/v1';
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** One secret name per line; blank lines and `#` comments ignored; every name validated. */
export function parseKeysFile(text) {
  const names = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!NAME_RE.test(line)) throw new Error(`bad secret name in keys file: ${JSON.stringify(line.slice(0, 40))}`);
    names.push(line);
  }
  return names;
}

/** `KEY=VALUE` lines, value kept exactly as written (the app's env files have no quoting). */
export function parseEnvFile(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || /^\s*#/.test(raw)) continue;
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const name = raw.slice(0, eq).trim();
    if (!NAME_RE.test(name)) continue;
    out.set(name, raw.slice(eq + 1));
  }
  return out;
}

/**
 * Text for a systemd EnvironmentFile. Values are written raw, exactly like the `.env` they replace,
 * so systemd parses them the same way it always has. A newline or NUL would start another
 * assignment or truncate one, so those are refused rather than escaped.
 */
export function renderEnvFile(entries) {
  let out = '';
  for (const [name, value] of entries) {
    if (!NAME_RE.test(name)) throw new Error(`bad secret name: ${JSON.stringify(name.slice(0, 40))}`);
    if (/[\n\r\0]/.test(value)) throw new Error(`secret ${name} contains a newline or NUL; store it single-line`);
    out += `${name}=${value}\n`;
  }
  return out;
}

async function json(res) {
  return res.json();
}

/** Access token for the VM's service account. */
export async function metadataToken(fetchImpl = fetch) {
  const res = await fetchImpl(`${META}/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token request failed (${res.status})`);
  const body = await json(res);
  if (!body.access_token) throw new Error('metadata token response had no access_token');
  return body.access_token;
}

export async function projectId(fetchImpl = fetch) {
  const res = await fetchImpl(`${META}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata project-id request failed (${res.status})`);
  return (await res.text()).trim();
}

/** Latest version of one secret. Never logs the value; errors carry the name and status only. */
export async function accessSecret({ project, name, token, fetchImpl = fetch }) {
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const e = new Error(`secret ${name}: Secret Manager answered ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const body = await json(res);
  const data = body?.payload?.data;
  if (typeof data !== 'string') throw new Error(`secret ${name}: response had no payload`);
  return Buffer.from(data, 'base64').toString('utf8');
}

/**
 * Fetch every named secret. Transient failures (network, 429, 5xx) are retried; a missing secret
 * (404) or a refused one (403) is NOT: those are configuration, and silently skipping a name would
 * let the app start on its defaults (a missing DATABASE_URL means the local Postgres). All failures
 * are collected so one run reports every problem, not the first.
 */
export async function fetchAll({ names, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4 }) {
  const token = await metadataToken(fetchImpl);
  const project = await projectId(fetchImpl);
  const entries = [];
  const failures = [];
  for (const name of names) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        entries.push([name, await accessSecret({ project, name, token, fetchImpl })]);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const s = err.status;
        const transient = s === undefined || s === 429 || s >= 500;
        if (!transient) break;
        await sleep(250 * 2 ** i);
      }
    }
    if (lastErr) failures.push(lastErr.message);
  }
  return { entries, failures };
}
