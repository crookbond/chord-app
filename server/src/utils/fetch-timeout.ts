/**
 * One request to a mail or calendar provider (Gmail, Graph) gives up after
 * this long. A struggling provider holds a request for tens of seconds before
 * answering 5xx, and with no limit every caller waited on it - a thread open
 * once per message, a sync once per page (ADR 0334). Bounds the wait for the
 * answer to start, not the reading of a long body.
 */
let attemptTimeoutMs = 15_000;

export function __setProviderAttemptTimeoutForTests(ms: number | null): void {
  attemptTimeoutMs = ms ?? 15_000;
}

export class ProviderTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out after ${attemptTimeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

/** `fetch`, ended after the attempt timeout. Not retried by callers: the next try would hang the same way. */
export async function fetchWithTimeout(url: string, init: RequestInit, what: string): Promise<Response> {
  const ctl = new AbortController();
  const outer = init.signal;
  const forward = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', forward);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, attemptTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (timedOut) throw new ProviderTimeoutError(what);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}
