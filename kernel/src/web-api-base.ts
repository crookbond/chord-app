/**
 * ADR 0316: the web app's session is a SameSite=Lax cookie, which the browser
 * sends only when the page and the API are the same site. In production they
 * share one origin. In development the page is on `localhost:8081` while the
 * configured API is often `127.0.0.1:4000` or a LAN address for phones - a
 * different site, so the cookie never comes back and every request after
 * sign-in is signed out.
 *
 * When both the page and the configured API are this machine or the local
 * network, the API is reached on the page's own host name instead (keeping the
 * configured protocol and port). A public API host is never rewritten.
 */

export interface PageLocation {
  protocol: string;
  hostname: string;
}

const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function isLocalDevHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    PRIVATE_V4.test(h)
  );
}

/** The API base the web app should use, given the configured one (may be
 *  empty) and where the page itself was loaded from. */
export function webApiBase(configured: string | undefined, page: PageLocation, devPort = 4000): string {
  const base = (configured ?? '').replace(/\/$/, '');
  if (!base) return `${page.protocol}//${page.hostname}:${devPort}`;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  if (url.hostname === page.hostname) return base;
  if (!isLocalDevHost(url.hostname) || !isLocalDevHost(page.hostname)) return base;
  url.hostname = page.hostname;
  return url.toString().replace(/\/$/, '');
}
