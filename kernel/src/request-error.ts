/**
 * The sentence the app shows when the server answered a request with an error.
 * Pure so it can be tested; `mobile/` has no harness.
 *
 * A 4xx carries a message the server wrote for the person on purpose (a
 * refused key, a missing field), so it is shown as sent. Two kinds are not:
 * the rate limiter's "too many requests, slow down", and a 5xx, which is
 * "internal error" (ADR 0269) or, from nginx or Cloudflare, a page of HTML.
 * A 5xx the server words on purpose (e.g. 503 "SMS verification is not set
 * up") is still shown.
 */

export const TOO_MANY_REQUESTS_TEXT = 'Chord got too many requests at once. Try again in a moment.';
export const SERVER_TROUBLE_TEXT = "Something went wrong on Chord's side. Try again in a moment.";

/**
 * `body` is the response text; `{ "error": "..." }` is how the server words a
 * message.
 */
export function requestErrorText(status: number, statusText: string, body: string): string {
  if (status === 429) return TOO_MANY_REQUESTS_TEXT;
  const said = serverMessage(body);
  if (status >= 500) {
    return said && said.toLowerCase() !== 'internal error' ? said : SERVER_TROUBLE_TEXT;
  }
  return said || body.trim() || `${status} ${statusText}`.trim();
}

function serverMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === 'string' && parsed.error.trim() ? parsed.error : null;
  } catch {
    return null;
  }
}
