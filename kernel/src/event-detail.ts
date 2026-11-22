/**
 * What the calendar's event view shows (ADR 0331): an event's description as
 * formatted text with tappable links, the video calls it can be joined on, and
 * a map link for where it is.
 *
 * A description arrives in two shapes. Google stores the HTML its own editor
 * wrote (`<b>`, `<a href>`, `<br>`, lists), and Teams/Zoom invites paste whole
 * HTML blocks into it; Outlook and Chord's own descriptions are plain text with
 * bare URLs. Both become the same small block list, drawn with ordinary text
 * components - never as HTML, so nothing in a description can run, load an
 * image, or style the page around it.
 *
 * Only http(s), mailto and tel links are kept as links; anything else keeps its
 * text and loses the link.
 */
import { decodeHtmlEntities } from './html-entities';

export interface RichRun {
  text: string;
  href?: string;
  bold?: boolean;
}

export interface RichBlock {
  kind: 'p' | 'li';
  runs: RichRun[];
}

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+/gi;
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
/** Trailing punctuation a sentence puts after a URL, not part of it. */
const URL_TAIL = /[.,;:!?)\]}>]+$/;

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'section', 'article', 'header', 'footer',
]);
const DROPPED_CONTENT = new Set(['style', 'script', 'head', 'title', 'template', 'noscript']);
const BOLD_TAGS = new Set(['b', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function descriptionIsHtml(text: string): boolean {
  return /<\/?(a|b|br|p|div|span|strong|em|i|u|ul|ol|li|table|html|body|font)\b[^>]*>/i.test(text);
}

/**
 * The address behind a mail-security rewrite (Proofpoint URL Defense v2/v3,
 * Microsoft Safe Links), which wraps every link in a work invite. Anything not
 * recognised, or not decodable, is returned unchanged.
 */
export function unwrapSafeLink(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let inner: string | null = null;
  try {
    if (/^urldefense\.proofpoint\.com$/i.test(u.hostname) && u.pathname.startsWith('/v2/')) {
      const enc = u.searchParams.get('u');
      if (enc) inner = decodeURIComponent(enc.replace(/-/g, '%').replace(/_/g, '/'));
    } else if (/^urldefense\.com$/i.test(u.hostname) && u.pathname.startsWith('/v3/__')) {
      // v3 replaces some characters with '*'; without decoding those, leave it.
      const m = url.match(/\/v3\/__(.+?)__;/);
      if (m && !m[1]!.includes('*')) inner = m[1]!;
    } else if (/\.safelinks\.protection\.outlook\.com$/i.test(u.hostname)) {
      inner = u.searchParams.get('url');
    }
  } catch {
    return url;
  }
  return inner && /^https?:\/\//i.test(inner) ? inner : url;
}

/** A link as a person reads it: host and path, no scheme, query or fragment. */
export function shortUrlLabel(url: string, max = 48): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol === 'mailto:' || u.protocol === 'tel:') return decodeURIComponent(u.pathname);
  const host = u.hostname.replace(/^www\./i, '');
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const label = host + path;
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const href = unwrapSafeLink(decodeHtmlEntities(raw).trim());
  return SAFE_HREF.test(href) ? href : undefined;
}

/** Bare URLs and addresses in plain text become link runs. */
function linkifyRun(text: string, base: Omit<RichRun, 'text'>): RichRun[] {
  if (base.href) {
    // An anchor whose text is just its address reads as the short form.
    const t = /^\s*https?:\/\/\S+\s*$/i.test(text) ? shortUrlLabel(base.href) : text;
    return [{ text: t, ...base }];
  }
  const found: Array<{ start: number; end: number; href: string; label?: string }> = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(URL_TAIL, '');
    const href = unwrapSafeLink(url);
    found.push({ start: m.index!, end: m.index! + url.length, href, label: shortUrlLabel(href) });
  }
  for (const m of text.matchAll(EMAIL_IN_TEXT)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (found.some((f) => start < f.end && end > f.start)) continue; // inside a URL
    found.push({ start, end, href: `mailto:${m[0]}` });
  }
  if (!found.length) return [{ text, ...base }];
  found.sort((a, b) => a.start - b.start);
  const out: RichRun[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) out.push({ text: text.slice(at, f.start), ...base });
    out.push({ text: f.label ?? text.slice(f.start, f.end), ...base, href: f.href });
    at = f.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), ...base });
  return out;
}

class Builder {
  blocks: RichBlock[] = [];
  private current: RichBlock | null = null;

  start(kind: RichBlock['kind']) {
    this.end();
    this.current = { kind, runs: [] };
  }

  add(text: string, style: Omit<RichRun, 'text'>) {
    if (!text) return;
    if (!this.current) this.current = { kind: 'p', runs: [] };
    const runs = this.current.runs;
    // Collapse whitespace across run boundaries, and none at a block's start.
    let t = text;
    if (!runs.length || /\s$/.test(runs[runs.length - 1]!.text)) t = t.replace(/^\s+/, '');
    if (!t) return;
    for (const r of linkifyRun(t, style)) {
      const prev = runs[runs.length - 1];
      if (prev && prev.href === r.href && !!prev.bold === !!r.bold) prev.text += r.text;
      else runs.push(r);
    }
  }

  end() {
    const c = this.current;
    this.current = null;
    if (!c) return;
    const last = c.runs[c.runs.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, '');
    c.runs = c.runs.filter((r) => r.text.length > 0);
    if (c.runs.length) this.blocks.push(c);
  }
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

function htmlToBlocks(html: string): RichBlock[] {
  const b = new Builder();
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  const token = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
  let bold = 0;
  let href: string | undefined;
  let dropping: string | null = null;
  for (const m of source.matchAll(token)) {
    const whole = m[0];
    const name = m[1]?.toLowerCase();
    if (!name) {
      if (dropping) continue;
      b.add(decodeHtmlEntities(whole.replace(/\s+/g, ' ')), { ...(href ? { href } : {}), ...(bold ? { bold: true } : {}) });
      continue;
    }
    const closing = whole.startsWith('</');
    if (dropping) {
      if (closing && name === dropping) dropping = null;
      continue;
    }
    if (!closing && DROPPED_CONTENT.has(name)) {
      if (!/\/>$/.test(whole)) dropping = name;
      continue;
    }
    if (name === 'a') {
      href = closing ? undefined : safeHref(attr(whole, 'href'));
      continue;
    }
    if (BOLD_TAGS.has(name)) bold = Math.max(0, bold + (closing ? -1 : 1));
    if (name === 'li') {
      if (closing) b.end();
      else b.start('li');
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (closing) b.add(' ', {});
      continue;
    }
    if (BLOCK_TAGS.has(name)) b.end();
  }
  b.end();
  return b.blocks;
}

function textToBlocks(text: string): RichBlock[] {
  const b = new Builder();
  // Outlook's plain-text bodies write a link as "label <url>"; the brackets go.
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*(https?:\/\/[^\s<>]+)\s*>/gi, '$1')
    .split('\n');
  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[-*•·]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      b.start('li');
      b.add(bullet[1]!, {});
      b.end();
      continue;
    }
    if (!line.trim()) {
      b.end();
      continue;
    }
    b.end();
    b.add(line, {});
  }
  b.end();
  return b.blocks;
}

const blockText = (b: RichBlock) => b.runs.map((r) => r.text).join('');
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * An event description as blocks of styled, linked text. A paragraph that only
 * repeats the event's title (invites often open with it) is left out.
 */
export function eventDescriptionBlocks(
  description: string | null | undefined,
  opts: { title?: string | null } = {},
): RichBlock[] {
  const text = (description ?? '').trim();
  if (!text) return [];
  const blocks = descriptionIsHtml(text) ? htmlToBlocks(text) : textToBlocks(text);
  const title = opts.title ? squash(opts.title) : '';
  return title ? blocks.filter((b) => squash(blockText(b)) !== title) : blocks;
}

export type JoinProvider = 'google_meet' | 'teams' | 'zoom' | 'webex' | 'other';

export interface JoinLink {
  provider: JoinProvider;
  label: string;
  url: string;
}

const JOIN_PATTERNS: Array<{ provider: JoinProvider; label: string; host: RegExp; path?: RegExp }> = [
  { provider: 'google_meet', label: 'Join Google Meet', host: /^meet\.google\.com$/i, path: /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i },
  { provider: 'teams', label: 'Join Teams meeting', host: /^teams\.(microsoft|live)\.com$/i, path: /^\/(l\/meetup-join|meet)\b/i },
  { provider: 'zoom', label: 'Join Zoom', host: /(^|\.)zoom\.(us|com)$/i, path: /^\/(j|my|w)\//i },
  { provider: 'webex', label: 'Join Webex', host: /(^|\.)webex\.com$/i, path: /^\/(meet|join|[^/]+\/j\.php)/i },
];

/** The video-call provider a URL joins, or null for an ordinary link. */
export function joinProviderOf(url: string): { provider: JoinProvider; label: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  for (const p of JOIN_PATTERNS) {
    if (p.host.test(u.hostname) && (!p.path || p.path.test(u.pathname))) {
      return { provider: p.provider, label: p.label };
    }
  }
  return null;
}

/**
 * Every video call the event can be joined on, the calendar's own link first
 * (Google's `hangoutLink`, Graph's Teams join URL), then any found in the
 * location or description. One per provider: a Teams invite repeats its join
 * link three times.
 */
export function eventJoinLinks(args: {
  videoCallLink?: string | null;
  location?: string | null;
  description?: string | null;
}): JoinLink[] {
  const urls: string[] = [];
  if (args.videoCallLink) urls.push(args.videoCallLink);
  for (const src of [args.location, args.description]) {
    if (!src) continue;
    for (const block of eventDescriptionBlocks(src)) {
      for (const r of block.runs) if (r.href) urls.push(r.href);
    }
  }
  const out: JoinLink[] = [];
  for (const url of urls) {
    const p = joinProviderOf(url);
    if (!p || out.some((j) => j.provider === p.provider)) continue;
    out.push({ ...p, url });
  }
  if (args.videoCallLink && !out.some((j) => j.url === args.videoCallLink) && SAFE_HREF.test(args.videoCallLink)) {
    out.unshift({ provider: 'other', label: 'Join video call', url: args.videoCallLink });
  }
  return out;
}

/**
 * Where a location opens: a URL is itself; anything else is a Google Maps
 * search, which opens the Maps app on a phone that has it and the website
 * otherwise (the same link on iPhone, Android and web).
 */
export function eventPlaceLink(
  location: string | null | undefined,
): { url: string; isMap: boolean; label: string } | null {
  const raw = (location ?? '').trim();
  if (!raw) return null;
  // A video-call link in the location is the Join button's job, and so is the
  // text an invite writes around it ("Google Meet (instructions in description)").
  const loc = raw
    .replace(/https?:\/\/[^\s<>;,]+/gi, (u) => (joinProviderOf(unwrapSafeLink(u)) ? ' ' : u))
    .replace(/\((?:instructions|details|join info)[^)]*\)/gi, ' ')
    .replace(/\s*[;,|]\s*(?=[;,|]|$)/g, '')
    .replace(/^[\s;,|]+|[\s;,|]+$/g, '')
    .replace(/\s{2,}/g, ' ');
  if (!loc) return null;
  const url = loc.match(/^https?:\/\/\S+$/i)?.[0];
  if (url) {
    const href = unwrapSafeLink(url);
    return { url: href, isMap: false, label: shortUrlLabel(href) };
  }
  // "Microsoft Teams Meeting" / "Google Meet" is how a call names itself, not a place.
  if (/^(microsoft teams( meeting)?|teams( meeting)?|google meet|zoom( meeting)?|webex( meeting)?|online|virtual|video call|phone call|tbd)$/i.test(loc)) {
    return null;
  }
  return { url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`, isMap: true, label: loc };
}
