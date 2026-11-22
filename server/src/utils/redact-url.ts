/**
 * Query parameters whose VALUE is a credential somewhere in Chord: the web
 * client's SSE session token (`token`), the image/inline proxy capability
 * (`k`), OAuth redirects (`code`, `state`), Graph's subscription handshake
 * (`validationToken`), Meta's verify token, and the generic names an outside
 * service might use. Matched case-insensitively.
 */
const SENSITIVE = new Set(
  [
    'token',
    'k',
    'code',
    'state',
    'validationtoken',
    'hub.verify_token',
    'access_token',
    'id_token',
    'refresh_token',
    'key',
    'api_key',
    'apikey',
    'secret',
    'password',
    'signature',
    'sig',
    'code_verifier',
  ].map((n) => n.toLowerCase()),
);

/**
 * A request URL with every sensitive query value replaced by `REDACTED`, for
 * logging. The path and the parameter NAMES stay, so a log line still says
 * which route was hit and with what shape.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const rawName = eq < 0 ? pair : pair.slice(0, eq);
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      // keep the raw name
    }
    if (eq >= 0 && SENSITIVE.has(name.toLowerCase())) return `${rawName}=REDACTED`;
    return pair;
  });
  return `${url.slice(0, q)}?${parts.join('&')}`;
}
