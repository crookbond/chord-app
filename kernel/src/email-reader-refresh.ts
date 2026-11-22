/**
 * Keeping an open email still while it is refreshed, and fitting it to the screen.
 *
 * The open email is re-read several times in its first seconds (the open
 * itself, mark-read, the read-time check finishing, a mail sync), and every
 * read mints a new image token (ADR 0136). The token is part of every image
 * URL, so adopting each one rebuilt the whole HTML body and reloaded every
 * image: the email flickered once per re-read.
 */

/** A token is sealed with a 12h expiry the client cannot read; re-adopt well inside it. */
export const IMAGE_TOKEN_KEEP_MS = 6 * 60 * 60 * 1000;

export interface HeldImageToken {
  threadId: string;
  token: string;
  adoptedAt: number;
}

/**
 * The token the open email should render with. The first one seen for a
 * thread is kept while it is still young, whatever later reads return; a
 * different thread, a held token that is too old, or none held takes the new one.
 */
export function holdImageToken(
  held: HeldImageToken | null,
  threadId: string,
  next: string | null | undefined,
  now: number,
): HeldImageToken | null {
  if (held && held.threadId === threadId && now - held.adoptedAt < IMAGE_TOKEN_KEEP_MS) {
    return held;
  }
  return next ? { threadId, token: next, adoptedAt: now } : null;
}

/**
 * How much to shrink an email laid out wider than the screen so it fits
 * with no sideways scrolling. Never enlarges; a pixel or two of rounding is
 * not overflow.
 */
export function fitScale(contentWidth: number, viewportWidth: number): number {
  if (!(contentWidth > 0) || !(viewportWidth > 0)) return 1;
  if (contentWidth <= viewportWidth + 1) return 1;
  return viewportWidth / contentWidth;
}

/**
 * The phone reader draws an email inline as one WebView exactly as tall as
 * the email, inside the thread's scroll. Past this the box stops growing and
 * the reader offers the full-screen view, which scrolls inside its own window
 * and so draws only what is on screen, however long the email is. Generous
 * on purpose: the first cap, 4,000, cut a newsletter off after a few screens.
 * An unbounded box lets a hostile email ask for a view taller than the phone
 * can draw.
 */
export const EMAIL_BODY_INLINE_MAX_HEIGHT = 16_000;
export const EMAIL_BODY_MIN_HEIGHT = 40;

/** The box for a measured body height, and whether the email goes on past it; null = not a height. */
export function emailBodyBox(measured: number): { height: number; clipped: boolean } | null {
  if (!Number.isFinite(measured) || measured <= 0) return null;
  const h = Math.max(Math.ceil(measured), EMAIL_BODY_MIN_HEIGHT);
  return h > EMAIL_BODY_INLINE_MAX_HEIGHT
    ? { height: EMAIL_BODY_INLINE_MAX_HEIGHT, clipped: true }
    : { height: h, clipped: false };
}

/**
 * How much of an email body the phone and web reader take at all. Sanitizing
 * runs on the app's UI thread, so a multi-megabyte body would freeze the app.
 * Gmail itself clips at 102KB; these are several times that, and only
 * markup-heavy mail gets near the HTML figure. The stored email is untouched
 * (search, tldr and the mail app still have all of it).
 */
export const EMAIL_READER_HTML_MAX = 500_000;
export const EMAIL_READER_TEXT_MAX = 60_000;

/**
 * Cut at `max`, backing up to the start of the tag the cut would split (or a
 * line or word break in plain text) when one is close, so the sanitizer is
 * not handed half a tag.
 */
export function clipForReader(
  body: string | null | undefined,
  max: number,
  kind: 'html' | 'text',
): { body: string | null; clipped: boolean } {
  if (body == null || body.length <= max) return { body: body ?? null, clipped: false };
  const head = body.slice(0, max);
  const floor = Math.floor(max * 0.9);
  let cut = max;
  if (kind === 'html') {
    const lt = head.lastIndexOf('<');
    if (lt >= floor && lt > head.lastIndexOf('>')) cut = lt;
  } else {
    const ws = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
    if (ws >= floor) cut = ws;
  }
  return { body: body.slice(0, cut), clipped: true };
}
