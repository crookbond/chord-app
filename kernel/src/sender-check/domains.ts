/**
 * Domain helpers for the sender checks (ADR 0294). Deliberately small: no
 * public-suffix list (ADR 0150 declined that dependency). A wrong
 * registrable domain here can only make two addresses look MORE alike or
 * less alike than they are; every check that uses it is phrased as "this
 * does not match", never as "this is safe".
 */

/** Second-level labels that sit under a country code: `co.uk`, `com.au`. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'gob', 'gouv']);

export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  const host = (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/[>.\s]+$/, '');
  return host && host.includes('.') ? host : null;
}

/** `mail.notify.robinhood.com` → `robinhood.com`; `x.co.uk` → `x.co.uk`. */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  if (labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(second)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

/** The name part of a registrable domain: `robinhood.com` → `robinhood`. */
export function domainLabel(registrable: string): string {
  return registrable.split('.')[0] ?? registrable;
}

/** Free mailboxes anyone can open. A company does not send its alerts from one. */
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', 'tutanota.com', 'fastmail.com',
  'hey.com', 'yahoo.co.uk', 'yahoo.co.in', 'hotmail.co.uk', 'rediffmail.com',
]);

export function isFreemail(registrable: string | null): boolean {
  return !!registrable && FREEMAIL.has(registrable);
}

/** A label written in punycode (`xn--`) may render as look-alike letters. */
export function hasPunycode(host: string | null): boolean {
  return !!host && host.split('.').some((l) => l.startsWith('xn--'));
}

/**
 * Letters swapped to look like other letters, folded to what they imitate:
 * `rnicrosoft` → `microsoft`, `paypa1` → `paypal`, `amaz0n` → `amazon`.
 */
export function foldLookalikes(label: string): string {
  return label
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/0/g, 'o')
    .replace(/[1l|i!]/g, 'l')
    .replace(/5/g, 's')
    .replace(/3/g, 'e')
    .replace(/[-_]/g, '');
}

/** Levenshtein distance, capped: anything past `max` returns `max + 1`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** A host written as an IP address (`http://185.2.3.4/login`). */
export function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}
