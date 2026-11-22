/**
 * Marketing mail pads its preheader with invisible characters so the inbox
 * preview shows only the headline. In prod that padding was eating the text
 * budget we hand the model: 464 of 2,432 threads lost 40+ characters to it, and
 * on those the median amount of REAL text left was 78 — one short sentence.
 *
 * Cleaned at sync (ADR 0110) rather than at each prompt, so the thread list
 * stops rendering a sentence followed by 200 invisible characters too.
 */
import { decodeHtmlEntities } from '@chord/kernel';

import { visibleHtmlText } from './visible-text.js';

/**
 * Zero-width and directional format characters, plus the two blanks a sender
 * reaches for when a zero-width one gets stripped: NBSP is handled as
 * whitespace below, and BRAILLE PATTERN BLANK is stripped here. Braille is a
 * real script with real uses; none of them is an email preheader.
 */
export const INVISIBLE_PATTERN =
  '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2800\\uFEFF]';

/** Postgres AREs understand `\uwxyz` too, so migration 048 strips exactly this
 *  set from stored snippets by passing the pattern straight through. Kept as
 *  that migration ran it; the set below is wider. */

/**
 * Everything a person cannot see but a model reads (ADR 0268): the set above
 * plus the bidi isolates, the combining grapheme joiner, the Hangul fillers,
 * the Mongolian vowel separator and the Unicode TAG block, which spells ASCII
 * invisibly and is exactly how an instruction gets smuggled into a prompt.
 * Also the variation selectors: a phish wrote "C<VS>o<VS>i<VS>n\u2026" (U+E0139)
 * so the name read as letters, not "Coinbase". An emoji keeps its own
 * presentation selector ("\u2600\uFE0F").
 */
const INVISIBLE =
  /\u034F|(?<!\p{Extended_Pictographic})\p{Variation_Selector}|[\u00AD\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u2800\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;

/** Removes only the invisible characters, leaving every space and tab where it
 *  was (an attachment's CSV columns mean something). */
export function stripInvisible(raw: string): string {
  return raw.replace(INVISIBLE, '');
}

/**
 * One-line preview text: every run of whitespace becomes a single space.
 *
 * Returns '' rather than null for empty input — `snippet` is NOT NULL, and
 * "nothing readable here" is a true statement about a message that is all
 * padding.
 */
export function cleanSnippet(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Body text for an LLM to read. Unlike a snippet this keeps line structure — an
 * itinerary, an address block and a list all mean less as one long line — while
 * collapsing the runs of blank lines that HTML-to-text conversion leaves behind.
 */
export function cleanBodyText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(INVISIBLE, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What a person SEES of an HTML mail body, as text (ADR 0268). Hidden
 * elements (`display:none`, zero-size or same-as-background text, comments,
 * classes a `<style>` rule hides) are dropped, so a sender cannot show the
 * model words the reader never saw. Outlook's Graph API returns HTML and
 * nothing else, so this is often the only body a message has.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return cleanBodyText(visibleHtmlText(html));
}

/**
 * The body an AI pass may read: the rendered HTML when the message has any,
 * the plain part only when it has none. A reader shows the HTML, so a
 * text/plain part that says something else is words nobody saw (ADR 0268).
 */
export function modelBodyText(parts: { text?: string | null; html?: string | null }): string {
  if (parts.html && parts.html.trim()) return htmlToText(parts.html);
  return cleanBodyText(parts.text);
}

/**
 * One STORED message as model input. Every provider stores the HTML beside
 * the plain part whenever it stores a body, so: the HTML when present, else
 * the plain part (the message has no HTML), else the excerpt sync derived
 * through `modelBodyText`. Every pass that reads a body reads it through here.
 */
export function bodyForModel(row: {
  html?: string | null;
  text?: string | null;
  excerpt?: string | null;
}): string {
  if (row.html && row.html.trim()) return htmlToText(row.html);
  return cleanBodyText(row.text) || cleanBodyText(row.excerpt);
}

/**
 * Gmail's API returns `snippet` HTML-escaped (`haven&#39;t`, `&lt;a@b.c&gt;`);
 * Graph's `bodyPreview` and our own IMAP preview are plain text. So this is
 * for Gmail only - decoding a plain-text preview would rewrite a message that
 * really does say `&amp;`.
 */
export function cleanGmailSnippet(raw: string | null | undefined): string {
  return cleanSnippet(raw ? decodeHtmlEntities(raw) : raw);
}

/** How much of an email the AI passes read. Matches the slice magics and
 *  person-extraction already applied to a body they almost never had. */
export const BODY_EXCERPT_CHARS = 2000;

/**
 * The stored excerpt, or null when the provider gave us no text to store.
 *
 * Null and '' are different claims — "we have never had the body" versus "this
 * message genuinely has no text part" — and the ADR 0110 backfill keys off
 * exactly that distinction to know what it still has to fetch. Cleaning happens
 * BEFORE the slice, or the cap gets spent on padding.
 */
export function bodyExcerpt(raw: string | null | undefined): string | null {
  const clean = cleanBodyText(raw);
  return clean ? clean.slice(0, BODY_EXCERPT_CHARS) : null;
}
