/**
 * Where the new message ends and the quoted history begins (ADR 0121).
 *
 * Lives in the kernel rather than beside the renderer because `mobile/` has no
 * test harness, and a wrong split hides mail.
 */

export interface SplitBody {
  /** What the reader sees. Never empty when the input was not. */
  visible: string;
  /** The quoted history, or null when there is nothing to collapse. */
  quoted: string | null;
}

const whole = (s: string): SplitBody => ({ visible: s, quoted: null });

/** A quoted tail this short is not worth a control. */
const MIN_QUOTE = 24;

/**
 * Two lines are enough to be a real quote; one line beginning with ">" is
 * usually someone quoting a phrase mid-sentence.
 */
const MIN_QUOTE_LINES = 2;

const ATTRIBUTION = [
  // "On Mon, 4 Aug 2026 at 09:12, Jo <jo@x.com> wrote:"
  /^\s*On\b[\s\S]{0,300}?\bwrote:\s*$/,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*Begin forwarded message:\s*$/i,
  // Outlook's separator rule.
  /^\s*_{10,}\s*$/,
];

/** Outlook top-posts a header block instead of quoting with ">". */
function outlookHeaderAt(lines: string[], i: number): boolean {
  if (!/^\s*From:\s*\S/i.test(lines[i] ?? '')) return false;
  const next = lines.slice(i + 1, i + 4).join('\n');
  return /^\s*(Sent|Date|To):/im.test(next);
}

function attributionAt(lines: string[], i: number): boolean {
  const line = lines[i] ?? '';
  for (const re of ATTRIBUTION) {
    if (re.test(line)) return true;
  }
  // Gmail wraps a long attribution, leaving "wrote:" on the next line.
  if (/^\s*On\b/.test(line) && /\bwrote:\s*$/.test(lines[i + 1] ?? '')) return true;
  return false;
}

/** Start of a run of at least MIN_QUOTE_LINES lines beginning with ">". */
function quoteRunAt(lines: string[], i: number): boolean {
  for (let n = 0; n < MIN_QUOTE_LINES; n += 1) {
    if (!/^\s*>/.test(lines[i + n] ?? '')) return false;
  }
  return true;
}

/**
 * Split a plain-text body at the first quoted history.
 *
 * Deliberately conservative: when the split would leave nothing to read, the
 * whole body is returned as visible. Hiding the message is worse than showing
 * a quote.
 */
export function splitQuotedText(text: string | null | undefined): SplitBody {
  if (!text) return whole('');
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    if (!attributionAt(lines, i) && !quoteRunAt(lines, i) && !outlookHeaderAt(lines, i)) {
      continue;
    }
    const visible = lines.slice(0, i).join('\n').trim();
    const quoted = lines.slice(i).join('\n').trim();
    if (visible.length === 0 || quoted.length < MIN_QUOTE) return whole(text);
    return { visible, quoted };
  }

  return whole(text);
}

/**
 * Markers every mail client leaves on the container it quotes into. Matched on
 * the RAW html, before sanitizing strips the class that identifies them.
 */
const HTML_QUOTE_MARKERS =
  /<(?:div|blockquote|p)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg|OLK_SRC_BODY_SECTION|protonmail_quote)/i;

const BARE_BLOCKQUOTE = /<blockquote\b/i;

/** Is there anything a reader would call content left in this html? */
function hasText(html: string): boolean {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim().length > 0;
}

/**
 * Split an html body at the quoted history.
 *
 * Both halves can be left with unbalanced tags; the sanitizer that runs after
 * this closes them, which is why the split happens on the raw html where the
 * client's own markers are still readable.
 */
export function splitQuotedHtml(html: string | null | undefined): SplitBody {
  if (!html) return whole('');

  const marked = HTML_QUOTE_MARKERS.exec(html);
  const bare = BARE_BLOCKQUOTE.exec(html);
  const at = Math.min(marked?.index ?? Infinity, bare?.index ?? Infinity);
  if (!Number.isFinite(at) || at <= 0) return whole(html);

  const visible = html.slice(0, at);
  const quoted = html.slice(at);
  if (!hasText(visible) || quoted.length < MIN_QUOTE) return whole(html);
  return { visible, quoted };
}
