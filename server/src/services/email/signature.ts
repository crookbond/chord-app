/**
 * ADR 0260 - the signature on outgoing mail, in one place.
 *
 * Every send (compose and reply, for Gmail, an attached Gmail, Outlook and
 * IMAP) asks `outgoingBodies` for its two halves, and a test fails the build if
 * a send path builds the separator itself. Since the ADR 0260 addendum nothing
 * is appended at send: the signature is in the body the person saw.
 *
 * A signature is either plain text (as before) or sanitised HTML. The HTML is
 * what the person pasted, run through an allow-list: it is authored by the user
 * but pasted from anywhere, and it goes out under their name, so scripts,
 * trackers and anything that could run are stripped before it is ever stored.
 * The plain-text half of a message is derived from it, so a rich signature still
 * leaves a readable text part (and Outlook, which sends HTML only, loses nothing).
 */
import type { Kysely } from 'kysely';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

import {
  SIGNATURE_SEPARATOR,
  bodyWithSignature,
  findSignature,
  hasOutdatedSignature,
  mailboxSignatureKey,
  sharedSignature,
  signatureBlock,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { htmlToText } from '../../utils/email-text.js';
import { textToHtml } from '../google/gmail-sync.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { listMailboxChoices, matchMailboxByName, type MailboxChoice } from './default-mailbox.js';
import { sanitizeQuotedHtml } from './reply-quote.js';
import { isSignatureImageUrl } from './signature-images.js';

/** The most HTML a signature may be, before and after cleaning. */
export const SIGNATURE_HTML_MAX = 20_000;

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.\s,%]+\)$/i, /^[a-z]{3,20}$/i];
const LENGTH = /^-?\d+(\.\d+)?(px|pt|em|rem|%)?$/i;
const BOX = /^(-?\d+(\.\d+)?(px|pt|em|rem|%)?\s*){1,4}$/i;

const ALLOWED_TAGS = [
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span', 'img', 'hr',
  'font', 'sub', 'sup', 'small', 'blockquote', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
];

/** Styles that make a signature look like one. Nothing that loads a resource
 *  (`url(`, `@import`), positions it off the page, or runs (`expression(`) is here. */
const ALLOWED_STYLES = {
  '*': {
    color: COLOR,
    'background-color': COLOR,
    'font-size': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/i],
    'font-family': [/^[\w\s,'"-]{1,120}$/],
    'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
    'font-style': [/^(normal|italic|oblique)$/i],
    'text-decoration': [/^(none|underline|line-through)$/i],
    'text-align': [/^(left|right|center|justify)$/i],
    'vertical-align': [/^(baseline|top|middle|bottom|sub|super)$/i],
    'line-height': [LENGTH],
    padding: [BOX],
    margin: [BOX],
    width: [LENGTH],
    height: [LENGTH],
    'max-width': [LENGTH],
    'border-radius': [LENGTH],
    border: [/^(?!.*url\s*\()[\w\s#.,()%-]{1,80}$/i],
  },
};

/**
 * The allow-listed HTML of a signature, or '' when nothing survives. Anything
 * that is not on the list is dropped, its text kept where it is text.
 */
export function sanitizeSignatureHtml(html: string): string {
  const clean = sanitizeHtml(html.slice(0, SIGNATURE_HTML_MAX), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      font: ['color', 'face', 'size'],
      table: ['width', 'border', 'cellpadding', 'cellspacing', 'align', 'style'],
      td: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'style'],
      th: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'style'],
      '*': ['style', 'align'],
    },
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    // A logo must be reachable by the recipient: a public https URL. Never
    // `data:` (it can carry a huge payload) and never `cid:` (we attach nothing).
    // Off production the app talks to a plain-http dev server, so a picture
    // it uploaded (ADR 0326) is `http://`; only those are let through.
    allowedSchemesByTag: { img: env.NODE_ENV === 'production' ? ['https'] : ['https', 'http'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
    // An image whose address was refused has nothing left to show.
    exclusiveFilter: (frame) =>
      frame.tag === 'img' &&
      (!frame.attribs['src'] ||
        (/^http:/i.test(frame.attribs['src']) && !isSignatureImageUrl(frame.attribs['src']))),
  }).trim();
  // Markup that cleaned down to nothing but empty wrappers is not a signature.
  return htmlToText(clean).trim() || /<img\b/i.test(clean) ? clean : '';
}

/** The plain-text rendering of a cleaned signature, with each link's address kept. */
export function signatureTextFromHtml(sanitized: string): string {
  const withAddresses = sanitized.replace(
    /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_whole, href: string, inner: string) => {
      const label = htmlToText(inner).trim();
      const address = href.replace(/^mailto:/i, '');
      const shown = htmlToText(address);
      return !label || label === shown ? address : `${label} (${address})`;
    },
  );
  return htmlToText(withAddresses).trim();
}

export interface SignatureRow {
  email_signature?: string | null;
  email_signature_html?: string | null;
}

/**
 * The two halves of an outgoing message. Nothing is added: the signature is in
 * the body because the composer put it there (or the server did, for mail
 * nobody types), and a person who deleted it sends none (ADR 0260 addendum).
 *
 * When the body still holds the user's signature unchanged and they have a rich
 * one, the html half shows the rich version in its place. An edited signature
 * is their own text now and goes out as written.
 */
export function outgoingBodies(
  body: string,
  row: SignatureRow | null | undefined,
): { text: string; html: string } {
  const rich = row?.email_signature_html?.trim();
  const at = rich ? findSignature(body, row?.email_signature) : -1;
  if (rich && at < 0 && hasOutdatedSignature(body, row?.email_signature)) {
    // An older copy of the signature in the body: it goes as typed text, and
    // the rich one is not used (ADR 0260 addendum 2026-11-13).
    logger.warn('rich signature not used: the body holds a different signature block');
  }
  if (!rich || at < 0) return { text: body, html: textToHtml(body) };
  const text = body.replace(/\r\n/g, '\n');
  const before = text.slice(0, at).replace(/\s+$/, '');
  const after = text.slice(at + signatureBlock(row?.email_signature).length).replace(/^\n+/, '');
  return {
    text: body,
    html:
      (before ? `${textToHtml(before)}<div><br></div>` : '') +
      `<div>${SIGNATURE_SEPARATOR}</div><div>${rich}</div>` +
      (after.trim() ? `<div><br></div>${textToHtml(after)}` : ''),
  };
}

/** ADR 0339 - how the composer wrote the message. Absent = an app from before
 *  the Plain / Rich switch, which keeps the `outgoingBodies` rule. */
export interface ComposedBody {
  body: string;
  format?: 'plain' | 'rich';
  bodyHtml?: string | null;
}

export interface ComposedBodies {
  text: string;
  html: string;
  /** Plain: the message goes as text only, with no HTML half where the
   *  provider allows it (Graph always takes HTML, so Outlook still gets
   *  `html`, which is the text escaped). */
  plain: boolean;
}

/**
 * ADR 0339 - the two halves of an outgoing message, by how it was written.
 * Rich: the editor's HTML, cleaned on the way out (it is the person's own,
 * but pasted from anywhere and sent under their name), signature included
 * (the editor holds it inline), and a text half derived from it with each
 * link's address kept. Plain: the text exactly, nothing rich added.
 */
export function composedBodies(input: ComposedBody, row: SignatureRow | null | undefined): ComposedBodies {
  if (input.format === 'rich' && input.bodyHtml?.trim()) {
    const html = sanitizeQuotedHtml(input.bodyHtml);
    if (htmlToText(html).trim() || /<img\b/i.test(html)) {
      return { text: signatureTextFromHtml(html) || input.body, html, plain: false };
    }
  }
  if (input.format === 'plain' || input.format === 'rich') {
    return { text: input.body, html: textToHtml(input.body), plain: input.format === 'plain' };
  }
  return { ...outgoingBodies(input.body, row), plain: false };
}

/**
 * ADR 0260 addendum - a mailbox's own signature, keyed 'primary' or an
 * account id. A mailbox with no entry uses the shared `users` columns; an
 * entry with both halves null means that mailbox sends no signature.
 */
export const mailboxSignatures = defineUserDefault(
  'mailbox_signatures',
  z.record(
    z.string().min(1).max(64),
    z.object({ text: z.string().max(4000).nullable(), html: z.string().max(SIGNATURE_HTML_MAX).nullable() }),
  ),
);

/**
 * The signature mail from one mailbox carries (null `accountId` = the primary
 * Gmail): its own, else the one every mailbox shares. Every send path and the
 * composers read it through here, so the signature the composer put in the
 * box is the one the send recognises.
 */
export async function mailboxSignatureRow(
  db: Kysely<DB>,
  userId: string,
  accountId: string | null | undefined,
): Promise<SignatureRow> {
  const [me, own] = await Promise.all([
    db
      .selectFrom('users')
      .select(['email_signature', 'email_signature_html'])
      .where('id', '=', userId)
      .executeTakeFirst(),
    mailboxSignatures.get(db, userId),
  ]);
  const mine = own?.[mailboxSignatureKey(accountId)];
  if (mine) return { email_signature: mine.text, email_signature_html: mine.html };
  // Never set (NULL) reads as the Chord default; cleared ('') is none.
  const text = me ? sharedSignature(me.email_signature) : null;
  return { email_signature: text || null, email_signature_html: me?.email_signature_html ?? null };
}

/**
 * `body` with the sending mailbox's signature under it, for mail nobody types
 * in the composer (a chat-drafted message, a family invite, a vacation
 * auto-reply): what the composer would have opened with.
 */
export async function signedBody(
  db: Kysely<DB>,
  userId: string,
  body: string,
  accountId: string | null = null,
): Promise<string> {
  const row = await mailboxSignatureRow(db, userId, accountId);
  return bodyWithSignature(body, row.email_signature);
}

/**
 * True when `text` (what the user said) names the mailbox `name` (what the
 * model put in the tool call): the whole name, or one of its words of 3+
 * letters ("work", "outlook", the part before the @).
 */
export function namesMailbox(text: string, name: string): boolean {
  const said = text.toLowerCase();
  const want = name.toLowerCase().trim();
  if (!want) return false;
  if (said.includes(want)) return true;
  const words = want.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['mail', 'email', 'mailbox', 'com', 'the', 'account'].includes(w));
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(said));
}

export type SetMailboxSignatureResult =
  | { ok: true; mailbox: MailboxChoice; signature: string | null; own: boolean }
  | { ok: false; reason: 'not_found' | 'no_mailbox' }
  | { ok: false; reason: 'ambiguous'; candidates: MailboxChoice[] };

/**
 * Give one mailbox its own signature, by key (Settings) or by what the user
 * called it (chat). `useShared` removes it, back to the shared signature.
 * The text/html rule is `signaturePatch`'s, so a rich one is cleaned the same.
 */
export async function setMailboxSignature(
  db: Kysely<DB>,
  userId: string,
  target: { mailbox: string } | { name: string },
  input: { text?: string | null; html?: string | null; useShared?: boolean },
): Promise<SetMailboxSignatureResult> {
  let mailbox: MailboxChoice | undefined;
  if ('mailbox' in target) {
    const all = await listMailboxChoices(db, userId);
    if (all.length === 0) return { ok: false, reason: 'no_mailbox' };
    mailbox = all.find((m) => m.mailbox === target.mailbox);
    if (!mailbox) return { ok: false, reason: 'not_found' };
  } else {
    const found = await matchMailboxByName(db, userId, target.name);
    if (!found.ok) return found;
    mailbox = found.mailbox;
  }
  const key = mailbox.mailbox;
  const patch = input.useShared ? null : signaturePatch({ text: input.text, html: input.html });
  await mailboxSignatures.update(db, userId, (current) => {
    const next = { ...(current ?? {}) };
    if (patch) {
      next[key] = { text: patch.email_signature ?? null, html: patch.email_signature_html ?? null };
    } else {
      delete next[key];
    }
    return { value: Object.keys(next).length > 0 ? next : null, result: undefined };
  });
  const row = await mailboxSignatureRow(db, userId, mailbox.accountId);
  return { ok: true, mailbox, signature: row.email_signature ?? null, own: !!patch };
}

/**
 * The columns to write for a signature the user set, from Settings or from chat.
 *
 * Rich HTML wins: it is cleaned, stored, and the plain text is derived from it so
 * the two never disagree. Setting plain text alone replaces a rich signature
 * rather than leaving the old HTML to go out beside it.
 *
 * An empty signature is written as '' (none), never NULL: NULL means the user
 * never set one, which reads as `DEFAULT_EMAIL_SIGNATURE`.
 */
export function signaturePatch(input: {
  text?: string | null;
  html?: string | null;
}): { email_signature?: string | null; email_signature_html?: string | null } {
  if (input.html !== undefined) {
    const clean = input.html ? sanitizeSignatureHtml(input.html) : '';
    if (clean) {
      return { email_signature_html: clean, email_signature: signatureTextFromHtml(clean) };
    }
    return { email_signature_html: null, email_signature: input.text?.trim() ?? '' };
  }
  if (input.text !== undefined) {
    return { email_signature: input.text?.trim() ?? '', email_signature_html: null };
  }
  return {};
}
