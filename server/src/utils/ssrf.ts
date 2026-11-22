/**
 * Screening an outbound host the user did not choose (ADR 0050, ADR 0122).
 *
 * Extracted from the .ics fetcher when unsubscribe became the second caller.
 * There is one guard, not one per feature: the next place we follow a URL out
 * of someone else's content must import this rather than re-derive it.
 *
 * Residual TOCTOU: we resolve + screen the hostname, then let fetch connect by
 * name, so a racing DNS flip could still land on an internal IP. Screening
 * every resolved address and re-screening each redirect hop closes the common
 * cases; full IP pinning is noted as future hardening in ADR 0050.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { env } from '../config/env.js';

export class BlockedHostError extends Error {
  constructor(
    readonly reason: 'blocked_host' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'BlockedHostError';
  }
}

/** IPv4 dotted-quad → true when it falls in a non-routable / internal range. */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable — refuse rather than risk it
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:1.2.3.4) — screen the embedded v4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const head = lower.split(':')[0];
  const first = parseInt(head || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Prefixes that carry an IPv4 address a gateway will route to: screen that.
  // 2002::/16 (6to4) holds it in groups 2-3; 64:ff9b::/96 (NAT64) in the last
  // 32 bits. Either can reach 169.254.169.254 or 10/8 through the gateway.
  const groups = expandIpv6(lower);
  if (groups.length !== 8) return true; // unreadable — refuse rather than risk it
  if (groups[0] === 0x2002) return isPrivateIpv4(v4FromGroups(groups[1], groups[2]));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isPrivateIpv4(v4FromGroups(groups[6], groups[7]));
  }
  return false;
}

/** '64:ff9b::a00:1' → its eight 16-bit groups; [] when it cannot be read. A
 *  trailing dotted quad ('64:ff9b::10.0.0.1') counts as the last two groups. */
function expandIpv6(ip: string): number[] {
  let s = ip;
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [p0, p1, p2, p3] = dotted.slice(1, 5).map(Number);
    s = `${s.slice(0, -dotted[0].length)}${((p0 << 8) | p1).toString(16)}:${((p2 << 8) | p3).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return [];
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return [];
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return [];
  return all.map((g) => parseInt(g, 16));
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return true; // not an IP literal — refuse
}

/** Resolve the host and refuse if ANY returned address is internal. */
export async function assertPublicHost(hostname: string): Promise<void> {
  // A bare IP literal in the URL never hits DNS — screen it directly.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new BlockedHostError('blocked_host', `Refusing to fetch a private address (${hostname}).`);
    }
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedHostError('unreachable', `Couldn't resolve ${hostname}.`);
  }
  if (addrs.length === 0) {
    throw new BlockedHostError('unreachable', `Couldn't resolve ${hostname}.`);
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new BlockedHostError('blocked_host', `${hostname} resolves to a private address — refusing.`);
    }
  }
}

/**
 * A user's own model endpoint (BYOK `baseUrl`, ADR 0269). Unlike the other
 * callers this URL is typed by the user, so it is screened when it is saved
 * AND every time it is used: a hostname that was public at save time can be
 * re-pointed at 169.254.169.254 later.
 *
 * In production it must be https on a public host. Elsewhere anything goes, so
 * a developer can point Chord at a local Ollama/vLLM on http://127.0.0.1.
 */
export async function assertSafeModelEndpoint(
  rawUrl: string,
  opts: { production?: boolean } = {},
): Promise<void> {
  const production = opts.production ?? env.NODE_ENV === 'production';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedHostError('blocked_host', 'That endpoint is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedHostError('blocked_host', 'The endpoint must be an https:// URL.');
  }
  if (!production) return;
  if (url.protocol !== 'https:') {
    throw new BlockedHostError('blocked_host', 'The endpoint must be an https:// URL.');
  }
  // `new URL` keeps IPv6 literals bracketed; the screen wants the bare address.
  await assertPublicHost(url.hostname.replace(/^\[(.*)\]$/, '$1'));
}

/**
 * `fetch` for a client talking to a user's model endpoint: screens the host of
 * every request and refuses redirects, so neither a re-pointed DNS name nor a
 * 302 from a public host can turn the call into a request to an internal one.
 */
export function modelEndpointFetch(
  opts: { production?: boolean } = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    await assertSafeModelEndpoint(target, opts);
    return fetch(input, { ...init, redirect: 'error' });
  };
}
