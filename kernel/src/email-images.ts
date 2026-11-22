/**
 * Deciding what in an email body would phone home (ADR 0120).
 *
 * These live in the kernel rather than beside the renderer for one reason:
 * they are the security-relevant half of image blocking, and the renderer is
 * in `mobile/`, which has no test harness. Here the server's vitest can reach
 * them — and the `url()` case below is exactly the kind of thing that needs a
 * test rather than a careful reading.
 */
import { decodeHtmlEntities } from './html-entities';

/**
 * Anything that fetches from a remote host when the document renders.
 *
 * `cid:` is deliberately not remote: those are the message's own attachments,
 * already downloaded with it. Blocking them would hide the photo someone
 * actually sent while stopping no tracker. Protocol-relative `//host/x` is
 * remote — it inherits the page's scheme and still leaves the device.
 */
export function isRemoteImageUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return REMOTE_URL_START.test(cleanEmailUrl(url));
}

/**
 * A URL as the browser will read it, not as the email spelled it.
 *
 * The URL parser drops tabs and newlines from anywhere in the address and
 * control characters from its ends, so `ht\ntps://host/x` is fetched as
 * `https://host/x` while a test for the literal prefix sees something else.
 */
export function cleanEmailUrl(url: string): string {
  const s = url.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end -= 1;
  return s.slice(start, end);
}

/** `https:` in any spelling the parser accepts (`https:\\host`, `https:host`),
 *  or a protocol-relative start with either kind of slash. */
const REMOTE_URL_START = /^(?:https?:|[/\\]{2})/i;

/** Any `url(...)` in an inline style, capturing what is inside whichever way
 *  it was quoted. */
const ANY_CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;

/** What is left of a remote reference once every `url()` has been dealt with:
 *  `image-set('https://…')` takes a bare string and never says `url`. */
const REMOTE_CSS_REF = /https?:|[/\\]{2}/i;

/**
 * Inline CSS as the browser will read it: comments removed and escapes
 * decoded, so an escaped `url`, an escaped scheme and a comment placed
 * inside the brackets are all seen for the plain remote reference they are.
 */
function normalizeCss(style: string): string {
  if (!/\\|\/\*/.test(style)) return style;
  return style
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\([0-9a-f]{1,6})\s?|\\([\s\S])/gi, (_m, hex: string | undefined, ch: string) => {
      if (!hex) return ch;
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/**
 * One pass serves both the reader with images off and the reader with them
 * on: every remote `url()` is replaced (with `none`, or with the proxy's
 * address), and a declaration that still names a remote host afterwards is
 * dropped whole, since nothing here knows how to rewrite it.
 */
/** Stands in for a `url()` while the rest of the style is examined. A
 *  private-use character, which no real style contains. */
const HELD = '\uE000';
const HELD_TOKEN = /\uE000(\d+)\uE000/g;

function filterRemoteCss(style: string, rewrite: ((url: string) => string) | null): string {
  const tokens: string[] = [];
  const held = normalizeCss(style.split(HELD).join('')).replace(
    ANY_CSS_URL,
    (match: string, dq?: string, sq?: string, bare?: string) => {
      const inner = dq ?? sq ?? bare ?? '';
      const out = !isRemoteImageUrl(inner)
        ? match
        : rewrite
          ? `url('${rewrite(cleanEmailUrl(inner)).replace(/'/g, '%27')}')`
          : 'none';
      tokens.push(out);
      return `${HELD}${tokens.length - 1}${HELD}`;
    },
  );
  const kept = REMOTE_CSS_REF.test(held)
    ? held
        .split(';')
        .filter((decl) => !REMOTE_CSS_REF.test(decl))
        .join(';')
    : held;
  return kept.replace(HELD_TOKEN, (_m, i: string) => tokens[Number(i)] ?? '');
}

/**
 * Remove remote references from an inline style.
 *
 * The hole most image blocking misses: `<td style="background-image:url(…)">`
 * fetches on render exactly as an `<img>` does, so a blocker that only rewrites
 * `src` leaves a working tracking pixel behind. Inline styles are allowed on
 * most tags in the reader's subset, so this has to run on all of them rather
 * than on images alone.
 */
export function stripRemoteCssUrls(style: string | undefined | null): string {
  if (!style) return '';
  return filterRemoteCss(style, null);
}

const ESCAPING_DECL = /(^|;)\s*(?:position\s*:\s*(?:fixed|sticky)\b|z-index\s*:)[^;]*/gi;

/**
 * Remove the inline-style declarations that let an email draw outside its own
 * box. On web the body is part of the app's page, so `position:fixed` with an
 * `inset` and a high `z-index` would cover Chord's own controls (a fake
 * sign-in prompt over the reader). `absolute` stays: the reader's container
 * is positioned and clips, so it cannot leave the box. Escapes and comments
 * are resolved first, or `p\osition` would slip past.
 */
export function stripEscapingCss(style: string | undefined | null): string {
  if (!style) return '';
  return normalizeCss(style)
    .replace(ESCAPING_DECL, '$1')
    .split(';')
    .filter((decl) => decl.trim() !== '')
    .join(';');
}

/**
 * The same sites `stripRemoteCssUrls` finds, pointed at the proxy instead of
 * removed (ADR 0136).
 *
 * One filter serves both because they are the same question asked by a reader
 * with images off and a reader with them on — a second one here is a second
 * chance to miss the `background-image` case the first was written for.
 */
export function rewriteRemoteCssUrls(
  style: string | undefined | null,
  rewrite: (url: string) => string,
): string {
  if (!style) return '';
  return filterRemoteCss(style, rewrite);
}

/**
 * Content security policy for the document an email body is rendered in.
 *
 * The sanitizer decides what SHOULD load; this makes the web view unable to
 * load anything else. Images may come only from Chord's own server (the proxy
 * and the inline-part route) or be embedded as `data:`; no script, frame,
 * font, stylesheet or connection of any kind is allowed. A remote reference
 * the sanitizer failed to recognise is therefore never fetched.
 *
 * `scriptNonce` (web): the frame's one script is Chord's own fit probe, run as
 * an inline `<script nonce>`; nothing else may run. A value that is not a
 * plain nonce is ignored rather than spliced into the policy.
 * `remoteImages`: HTML the reader wrote themselves (their signature, ADR 0260)
 * whose images load directly over https.
 */
const NONCE_SHAPE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

export function emailBodyCsp(
  apiBase: string,
  opts: { scriptNonce?: string; remoteImages?: boolean } = {},
): string {
  const origin = /^https?:\/\/[^/?#\s'";]+/i.exec(apiBase.trim())?.[0] ?? '';
  const nonce = opts.scriptNonce && NONCE_SHAPE.test(opts.scriptNonce) ? opts.scriptNonce : null;
  return [
    "default-src 'none'",
    `img-src data:${origin ? ` ${origin}` : ''}${opts.remoteImages ? ' https:' : ''}`,
    ...(nonce ? [`script-src 'nonce-${nonce}'`] : []),
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Absolute URL for an image fetched on the reader's behalf (ADR 0136).
 *
 * Built here rather than in the renderer so the server's tests can pin the
 * encoding: a tracking URL is query-heavy by nature, and an `&` that survives
 * unescaped silently truncates it into a different request.
 */
export function emailImageProxyUrl(apiBase: string, token: string, remoteUrl: string): string {
  const q = `k=${encodeURIComponent(token)}&u=${encodeURIComponent(absoluteEmailImageUrl(remoteUrl))}`;
  return `${apiBase}/api/v1/me/email/image?${q}`;
}

/**
 * The address the proxy is asked for, given a remote reference as the email
 * wrote it. One function for the reader (which builds the request) and the
 * preload pass (which fetches ahead of it), so both name an image the same way.
 */
export function absoluteEmailImageUrl(remoteUrl: string): string {
  // Protocol-relative has no scheme to hand the server; it inherits the
  // document's, which for an email body means https.
  const cleaned = cleanEmailUrl(remoteUrl);
  return /^[/\\]{2}/.test(cleaned) ? `https:${cleaned}` : cleaned;
}

const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const STYLE_ATTR = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Every remote image an email body would fetch when shown: `<img src>` and
 * `url()` in inline styles, in document order, deduped, as absolute addresses.
 *
 * Read off the raw HTML rather than a parse. Where this and the reader's
 * sanitizer disagree about a message, the image is simply not found ahead of
 * time and is fetched when the mail is opened instead.
 */
export function remoteImageUrlsInHtml(html: string | null | undefined): string[] {
  if (!html) return [];
  const out = new Set<string>();
  const add = (raw: string): void => {
    if (isRemoteImageUrl(raw)) out.add(absoluteEmailImageUrl(raw));
  };
  for (const m of html.matchAll(IMG_SRC)) add(decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? ''));
  for (const m of html.matchAll(STYLE_ATTR)) {
    const style = normalizeCss(decodeHtmlEntities(m[1] ?? m[2] ?? ''));
    for (const u of style.matchAll(ANY_CSS_URL)) add(u[1] ?? u[2] ?? u[3] ?? '');
  }
  return [...out];
}

/** Marker the sanitizer leaves on an image whose src it removed, so the reader
 *  can count them without re-parsing the document. */
export const BLOCKED_IMAGE_ATTR = 'data-chord-blocked';

export function countBlockedImages(sanitizedHtml: string): number {
  return (sanitizedHtml.match(new RegExp(`${BLOCKED_IMAGE_ATTR}="1"`, 'g')) ?? []).length;
}

/*
 * Inline images: `<img src="cid:image001.png@01D…">` points at a part of the
 * message itself (a signature logo, a pasted photo), not at a remote host. The
 * bytes come from the reader's own mailbox, so these render whatever the
 * remote-image setting says. What they need is an address: the body names a
 * Content-ID, and the part is fetched by it through Chord.
 */

/** A Content-ID as written in a header (`<abc@x>`) or a `cid:` URL (`abc@x`,
 *  possibly percent-encoded), reduced to one comparable form. */
export function normalizeContentId(raw: string): string {
  let v = raw.trim();
  if (v.toLowerCase().startsWith('cid:')) v = v.slice(4);
  try {
    v = decodeURIComponent(v);
  } catch {
    // Not percent-encoded — use as written.
  }
  return v.replace(/^</, '').replace(/>$/, '').trim().toLowerCase();
}

const CID_SRC = /<img\b[^>]*?\bsrc\s*=\s*["']?\s*cid:([^"'\s>]+)/gi;

/** Content-IDs the body's images point at, normalized and deduped. */
export function inlineImageContentIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const out = new Set<string>();
  for (const m of html.matchAll(CID_SRC)) out.add(normalizeContentId(m[1]));
  return [...out];
}

export function hasInlineImageRefs(html: string | null | undefined): boolean {
  return inlineImageContentIds(html).length > 0;
}

/** Absolute URL for one inline part. Authenticated by the same sealed image
 *  token as the remote proxy — an `<img>` cannot send the session header. */
export function emailInlineImageUrl(
  apiBase: string,
  token: string,
  messageId: string,
  contentId: string,
): string {
  const q = [
    `k=${encodeURIComponent(token)}`,
    `m=${encodeURIComponent(messageId)}`,
    `c=${encodeURIComponent(normalizeContentId(contentId))}`,
  ].join('&');
  return `${apiBase}/api/v1/me/email/inline?${q}`;
}
