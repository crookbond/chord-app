/**
 * Messages from the web reader's email frame to the app.
 *
 * On web an email body is drawn in a sandboxed `<iframe srcdoc>` with an
 * opaque origin (no `allow-same-origin`), so it can reach neither the app's
 * DOM nor its storage. The one script inside is Chord's own fit probe; it
 * talks to the app only through `postMessage`, and everything it says is
 * checked here before the app acts on it. The app also checks that the
 * message came from that frame's own window.
 */

/** Past this the frame stops growing and scrolls inside itself. A hostile
 *  email must not be able to ask the page for a box of any height. */
export const EMAIL_FRAME_MAX_HEIGHT = 100_000;

const MAX_URL_LENGTH = 8_192;

export type EmailFrameMessage =
  | { kind: 'height'; height: number }
  | { kind: 'open'; url: string };

/** A link out of an email the app will open: http(s) and mailto only. */
export function isOpenableEmailLink(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** The message, or null for anything that is not exactly one of ours. */
export function parseEmailFrameMessage(data: unknown): EmailFrameMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  if (m.chordEmail === 'height') {
    const h = m.height;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null;
    return { kind: 'height', height: Math.min(Math.ceil(h), EMAIL_FRAME_MAX_HEIGHT) };
  }
  if (m.chordEmail === 'open') {
    return isOpenableEmailLink(m.url) ? { kind: 'open', url: m.url } : null;
  }
  return null;
}

/** `sandbox` for the email frame: scripts (the probe) and popups (a link the
 *  reader opens with a modifier key), and never `allow-same-origin`. */
export const EMAIL_FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
