/**
 * Sign in with Apple in a browser (ADR 0156 addendum).
 *
 * The browser leaves for Apple and comes back through the server's callback,
 * which relays Apple's form post into the URL fragment. These two functions
 * are the two ends of that trip; they live here so they can be tested (the
 * mobile workspace has no test harness).
 */

const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';

/** What `/health` tells a browser it needs to start the flow. */
export interface AppleWebConfig {
  /** The Services ID. */
  clientId: string;
  /** The server's callback, exactly as registered with Apple. */
  redirectUri: string;
}

export function appleWebAuthorizeUrl(cfg: AppleWebConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    // Apple requires form_post whenever a scope is requested, and without the
    // email scope there is nothing to match an existing account on.
    response_mode: 'form_post',
    scope: 'name email',
    state,
  });
  return `${APPLE_AUTHORIZE_URL}?${q.toString()}`;
}

export interface AppleWebReturn {
  /** Present on success. */
  code: string | null;
  /** Apple's error code otherwise, e.g. `user_cancelled_authorize`. */
  error: string | null;
  state: string;
  givenName?: string;
  familyName?: string;
}

/** Null when the fragment is not a return from Apple at all. */
export function parseAppleWebReturn(hash: string): AppleWebReturn | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const code = q.get('apple_code');
  const error = q.get('apple_error');
  if (!code && !error) return null;
  return {
    code: code || null,
    error: code ? null : error,
    state: q.get('apple_state') ?? '',
    ...(q.get('apple_first') ? { givenName: q.get('apple_first')! } : {}),
    ...(q.get('apple_last') ? { familyName: q.get('apple_last')! } : {}),
  };
}

/**
 * ADR 0263 - the Android app runs this same browser flow (there is no native
 * Sign in with Apple on Android). It marks its state so the server sends the
 * return to the App Link Android already catches for Google (ADR 0081)
 * instead of the web app's root. The state is still checked on the device.
 */
export const APPLE_NATIVE_STATE_PREFIX = 'android.';
export const APPLE_NATIVE_RETURN_PATH = '/nativeauth';

/** The path on the web origin the server's callback returns to. */
export function appleReturnPath(state: string): string {
  return state.startsWith(APPLE_NATIVE_STATE_PREFIX) ? APPLE_NATIVE_RETURN_PATH : '/';
}

/**
 * A browser's state names the origin it started on. The state it checks on
 * return is in that origin's sessionStorage, and Chord is served from more
 * than one (chordapp.ai and www.chordapp.ai), so the return has to come back
 * to the same one. The server only honours an origin that is Chord's own.
 */
const ORIGIN_STATE_PREFIX = 'o.';

export function appleWebState(origin: string, random: string): string {
  const hex = Array.from(origin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `${ORIGIN_STATE_PREFIX}${hex}.${random}`;
}

/** The origin a browser's state names, or null when it names none. */
export function appleStateOrigin(state: string): string | null {
  const m = /^o\.((?:[0-9a-f]{2}){1,100})\./.exec(state);
  if (!m) return null;
  const text = m[1].replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)));
  try {
    const origin = new URL(text).origin;
    return origin === text ? origin : null;
  } catch {
    return null;
  }
}

/** True when the browser that started the flow is the one finishing it. */
export function appleWebStateMatches(returned: string, stored: string | null): boolean {
  return !!stored && stored.length >= 16 && returned === stored;
}
