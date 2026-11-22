/**
 * Which browser origins may read API responses (and send the session cookie)
 * cross-origin. Chord's own web app, plus any origin listed in
 * `CORS_ALLOWED_ORIGINS`; in development also any localhost / LAN address,
 * since Expo web serves from its own port. Native apps and server-to-server
 * callers send no Origin header and are unaffected.
 *
 * A refused origin only loses the CORS headers - the request still runs, as
 * it would from a plain HTML form - so nothing here may be treated as
 * authorization (CASA 6.3.1).
 */
const OWN_ORIGINS = ['https://chordapp.ai', 'https://www.chordapp.ai'];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const DEV_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

export function buildCorsOriginCheck(opts: {
  production: boolean;
  extra: string;
  webOrigin: string;
  signupUrl: string;
}): (origin: string | undefined) => boolean {
  const allowed = new Set(OWN_ORIGINS);
  for (const u of [opts.webOrigin, opts.signupUrl, ...opts.extra.split(',')]) {
    const o = u.trim() ? originOf(u.trim()) : null;
    if (o && o !== 'null') allowed.add(o);
  }
  return (origin) => {
    if (!origin) return true;
    if (allowed.has(origin)) return true;
    return !opts.production && DEV_ORIGIN.test(origin);
  };
}
