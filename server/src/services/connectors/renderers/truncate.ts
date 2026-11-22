/**
 * Per-platform message length caps.
 *
 * Bridged surfaces have hard limits and Chord's longest messages — the daily
 * briefing with its email and proposals sections — routinely exceed them. Left
 * alone the platform decides what happens, and the answers are all bad: Twilio
 * rejects the whole send with error 21617 (that is 10 of the 100 failures in
 * production's WhatsApp log), Telegram rejects with `MESSAGE_TOO_LONG`, and
 * Discord's client silently slices mid-word.
 *
 * So clip deliberately, at a boundary a reader won't notice, and hand back a
 * link to the full thing rather than dropping the tail on the floor.
 */

/**
 * Twilio's cap on a WhatsApp body, well under WhatsApp's own 4096.
 *
 * Stays the DEFAULT rather than the only value (ADR 0140). A caller that
 * forgets to say which transport it is gets the smaller number, which clips
 * early — degraded but sent. Defaulting the other way would hand Twilio a body
 * it rejects outright with 21617, which is no send at all.
 */
export const WHATSAPP_LIMIT = 1600;
/** WhatsApp's own cap, available when Meta is the transport (ADR 0090). */
export const WHATSAPP_CLOUD_LIMIT = 4096;
/** Telegram's `sendMessage` text cap. */
export const TELEGRAM_LIMIT = 4096;

const ELLIPSIS = '…';

/**
 * Clip `text` to `limit`, appending a pointer to the full version.
 *
 * The suffix is budgeted *before* cutting, so the result is always within the
 * limit — a naive `slice(0, limit)` plus a suffix overshoots and still gets
 * rejected. The cut prefers a paragraph break, then a line break, then a word
 * boundary, so a briefing ends on a whole bullet instead of mid-sentence.
 */
export function clipForPlatform(
  text: string,
  limit: number,
  moreUrl?: string,
): string {
  if (text.length <= limit) return text;

  const suffix = moreUrl ? `\n\n${ELLIPSIS} Read more: ${moreUrl}` : `\n\n${ELLIPSIS}`;
  // A pathological limit (or an absurdly long URL) leaves no room for content;
  // returning the bare suffix beats emitting something over the cap.
  const budget = limit - suffix.length;
  if (budget <= 0) return suffix.trimStart().slice(0, limit);

  const head = text.slice(0, budget);
  return head.slice(0, cutPoint(head)).trimEnd() + suffix;
}

/**
 * Where to cut `head` so the break reads as intentional. Only accepts a
 * boundary in the last 30% of the budget — otherwise an early paragraph break
 * would throw away most of the allowance to gain a slightly tidier edge.
 */
function cutPoint(head: string): number {
  const floor = Math.floor(head.length * 0.7);
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = head.lastIndexOf(sep);
    if (at >= floor) return at;
  }
  return head.length;
}
