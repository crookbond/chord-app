/**
 * ADR 0338 - a reply carries the email it answers.
 *
 * Every reply that Chord builds the MIME for (primary Gmail, a second Gmail,
 * IMAP, and the Drafts-folder copy on every provider) adds the original under
 * the reply here, the way every mail client does: `On <date>, <name> wrote:`
 * and the message, in a `gmail_quote` blockquote in the HTML half and as `> `
 * lines in the text half. Outlook sends are not built here: Graph's `/reply`
 * quotes the original itself.
 */
import { forwardDateLabel } from '@chord/kernel';
import type { Kysely } from 'kysely';
import sanitizeHtml from 'sanitize-html';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { modelBodyText } from '../../utils/email-text.js';

/** Over this much HTML the original is quoted as text. */
export const QUOTE_HTML_MAX = 400_000;

export interface QuotedOriginal {
  from_name: string | null;
  from_email: string | null;
  internal_date: string;
  body_text: string | null;
  body_html: string | null;
}

export interface OutgoingBodies {
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Declarations that run or reach out of a style attribute. */
const UNSAFE_STYLE = /expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import/i;

function cleanStyle(style: string): string {
  return style
    .split(';')
    .filter((d) => d.trim() && !UNSAFE_STYLE.test(d))
    .join(';');
}

/**
 * The original's HTML, safe to send back out: no scripts, forms, frames,
 * `<style>`, event handlers or `javascript:`; images kept except `cid:` ones
 * (their attachments are not re-sent, so they would only be broken pictures).
 */
export function sanitizeQuotedHtml(html: string): string {
  // The body of a full document, when it is one.
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return sanitizeHtml(body, {
    allowedTags: [
      'a', 'abbr', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
      'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'i', 'img', 'ins', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike',
      'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'name', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      font: ['color', 'face', 'size'],
      table: ['width', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'role'],
      td: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'bgcolor'],
      th: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'bgcolor'],
      col: ['width', 'span'],
      '*': ['style', 'align', 'dir', 'class'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'http'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // Style is passed through (an email's look lives in it) minus anything that runs.
    parseStyleAttributes: false,
    transformTags: {
      '*': (tagName, attribs) => {
        if (attribs.style !== undefined) {
          const style = cleanStyle(attribs.style);
          if (style) attribs.style = style;
          else delete attribs.style;
        }
        return { tagName, attribs };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs['src'],
  }).trim();
}

/** `On <date>, <name> <address> wrote:` - the line every client writes. */
export function attributionLine(o: QuotedOriginal, timeZone: string): string {
  const who = o.from_name && o.from_email
    ? `${o.from_name} <${o.from_email}>`
    : o.from_name || o.from_email || 'someone';
  return `On ${forwardDateLabel(o.internal_date, timeZone)}, ${who} wrote:`;
}

/** `bodies` with `original` quoted under them, or unchanged when it has no body. */
export function quoteOriginal<T extends OutgoingBodies>(bodies: T, original: QuotedOriginal | null, timeZone: string): T {
  if (!original) return bodies;
  const rawHtml = original.body_html?.trim() ? original.body_html : null;
  const visibleText = modelBodyText({ text: original.body_text, html: rawHtml });
  if (!visibleText.trim() && !rawHtml) return bodies;

  const line = attributionLine(original, timeZone);
  const quotedLines = visibleText.replace(/\r\n/g, '\n').split('\n').map((l) => (l ? `> ${l}` : '>'));
  const text = `${bodies.text.replace(/\s+$/, '')}\n\n${line}\n${quotedLines.join('\n')}\n`;

  const cleanHtml = rawHtml && rawHtml.length <= QUOTE_HTML_MAX ? sanitizeQuotedHtml(rawHtml) : '';
  const inner = cleanHtml || `<div>${escapeHtml(visibleText).replace(/\n/g, '<br>')}</div>`;
  const html =
    `${bodies.html}<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(line)}<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
    `${inner}</blockquote></div>`;
  return { ...bodies, text, html };
}

/**
 * The bodies of a reply, with the message it answers quoted under them in the
 * user's zone. An automatic reply quotes nothing.
 */
export async function withQuotedOriginal<T extends OutgoingBodies>(
  db: Kysely<DB>,
  userId: string,
  bodies: T,
  original: QuotedOriginal | null | undefined,
  opts: { autoReply?: boolean } = {},
): Promise<T> {
  if (opts.autoReply || !original) return bodies;
  const user = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  return quoteOriginal(bodies, original, user?.last_tz || env.BRIEFING_DEFAULT_TZ);
}
