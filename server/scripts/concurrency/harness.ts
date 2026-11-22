/**
 * Shared pieces for the concurrency scenarios: dev sign-in, a raw API call,
 * sending two writes a set gap apart, and a pass/fail record. Scenarios talk
 * to a running dev server over HTTP only, like the app does
 * (docs/ops/concurrency-tests.md).
 */
import { API, SESSION_HEADER } from '@chord/kernel';

export const BASE = (process.env.CHORD_BASE ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

export interface Reply {
  status: number;
  body: any;
}

/** A dev (`AUTH_MODE=dev`) session. Signing in twice with one name gives the same person two sessions, as two devices. */
export async function signIn(username: string): Promise<string> {
  const r = await call(null, 'POST', API.session, { username });
  if (r.status !== 200 && r.status !== 201) throw new Error(`sign-in ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

let keyN = 0;
/** A fresh Idempotency-Key, unique within this run. */
export const newKey = (): string => `conc-${process.pid}-${Date.now()}-${keyN++}`;

export async function call(token: string | null, method: string, path: string, body?: unknown, key?: string): Promise<Reply> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { [SESSION_HEADER]: token } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) {
    throw new Error('the server is rate limiting this run; start it with RATE_LIMIT_ENABLED=false');
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: parsed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts `a`, waits `gapMs`, starts `b`; both may still be in flight together. */
export async function pair<A, B>(gapMs: number, a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
  const pa = a();
  if (gapMs > 0) await sleep(gapMs);
  const pb = b();
  return [await pa, await pb];
}

/** Starts every call at once. */
export const together = <T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

export function tally(values: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export class Checks {
  readonly failures: string[] = [];
  private passed = 0;

  constructor(private readonly scenario: string) {}

  /** Records one expectation and prints it as a line of the report. */
  expect(label: string, ok: boolean, detail = ''): void {
    if (ok) this.passed++;
    else this.failures.push(`${this.scenario}: ${label}${detail ? ` (${detail})` : ''}`);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  -  ${detail}` : ''}`);
  }

  summary(): string {
    return `${this.scenario}: ${this.passed} ok, ${this.failures.length} failed`;
  }
}

export interface Scenario {
  name: string;
  about: string;
  run(checks: Checks): Promise<void>;
}
