/**
 * Pure, Google-free helpers for the Gmail reader (ADR 0060). Kept separate from
 * `gmail.service.ts` so history-diff, MIME building, base64url, and thread
 * aggregation are unit-tested without any network. Mirrors `two-way-sync.ts`.
 */

import {
  hasMarkdown,
  markdownToHtml,
  normalizeContentId,
  parseAuthenticationResults,
  type EmailAttachmentRef,
  type SenderAuth,
} from '@chord/kernel';

import { bodyExcerpt, cleanGmailSnippet, modelBodyText } from '../../utils/email-text.js';
import { attachmentDisposition } from '../../utils/content-disposition.js';
import { charsetOf, decodeText } from '../../utils/text-decode.js';

// ── base64url ─────────────────────────────────────────────────────────
export function b64urlDecode(data: string): string {
  const norm = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64').toString('utf8');
}

export function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── raw Gmail resource shapes (subset we consume) ─────────────────────
export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPayload {
  mimeType?: string;
  /** Present on attachment parts. */
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
}

/** A real (non-inline-body) attachment part: named + fetchable by id. */
export interface AttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
  /** Normalized Content-ID, when the part has one (inline `cid:` images). */
  contentId?: string;
}

/**
 * Walk the MIME tree and collect downloadable attachment parts. An inline
 * image with a Content-ID counts even without a filename: the body's
 * `<img src="cid:…">` is the only way it is ever shown, and it needs an id to
 * be fetched by.
 */
export function listAttachmentParts(payload: GmailPayload | undefined): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (node: GmailPayload | undefined): void => {
    if (!node) return;
    const rawCid = node.headers?.find((h) => h.name.toLowerCase() === 'content-id')?.value;
    const contentId = rawCid ? normalizeContentId(rawCid) : undefined;
    if (node.body?.attachmentId && (node.filename || contentId)) {
      out.push({
        filename: node.filename || contentId!,
        mimeType: node.mimeType ?? 'application/octet-stream',
        attachmentId: node.body.attachmentId,
        size: node.body.size ?? 0,
        ...(contentId ? { contentId } : {}),
      });
    }
    for (const part of node.parts ?? []) walk(part);
  };
  walk(payload);
  return out;
}

/** The stored/wire shape of one part (`email_messages.attachments_json`). */
export function toAttachmentRef(p: AttachmentPart): EmailAttachmentRef {
  return {
    id: p.attachmentId,
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
    ...(p.contentId ? { contentId: p.contentId } : {}),
  };
}

export interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** ms-epoch string. */
  internalDate?: string;
  /** Mailbox history cursor at the time this message resource was read. */
  historyId?: string;
  payload?: GmailPayload;
}

/** Normalized message ready to upsert into `email_messages`. */
export interface NormalizedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  fromName: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  internalDate: string; // ISO
  isUnread: boolean;
  labelIds: string[];
  rfc822MessageId: string | null;
  /** References + In-Reply-To for threading a reply, plus the raw Date
   *  header — the only place the sender's UTC offset survives. */
  headers: { references: string | null; inReplyTo: string | null; date: string | null };
  /** JSON EmailAttachmentRef[] when known at upsert time (IMAP knows at sync;
   *  Gmail/Outlook discover on thread open). Undefined = leave column alone. */
  attachmentsJson?: string;
  /** The invite .ics when the source was parsed at sync (IMAP, and Gmail when
   *  the part is inline): '' = parsed, no invite. Undefined = leave column
   *  alone (Outlook probes natively; a Gmail .ics attachment is fetched). */
  icsText?: string | null;
  /** ADR 0109 bulk signals, as the sender wrote them. Undefined = this provider
   *  cannot supply them, which is stored as null and read as "unknown", never
   *  as "not bulk". */
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
  listId?: string | null;
  /** ADR 0110 — the slice of body text sync keeps for the AI passes to read.
   *  Undefined = this fetch had no body to offer (a metadata-format message),
   *  which must leave an already-stored excerpt alone. */
  bodyExcerpt?: string | null;
  /** ADR 0294 — the Reply-To address and the receiving server's verdict
   *  (`Authentication-Results`). Undefined = this fetch did not carry the
   *  headers, which must leave stored values alone; null = they were absent. */
  replyTo?: string | null;
  authResults?: SenderAuth | null;
  /** ADR 0314 — an automatic message (`Auto-Submitted` other than "no", or a
   *  Chord vacation reply). Only `true` is written; anything else leaves the
   *  stored mark alone, so a provider copy without the header cannot clear it. */
  autoReply?: boolean;
}

/** RFC 3834: any `Auto-Submitted` value but "no" marks a machine-sent message. */
export function isAutoSubmitted(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== '' && !v.startsWith('no');
}

// ── header parsing ────────────────────────────────────────────────────
export function headerMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

/**
 * The FIRST header of a name. `headerMap` keeps the last, which is right for
 * single headers but wrong for the stacked trace ones: every relay prepends
 * its own `Authentication-Results`, so only the top one is the user's
 * provider talking — a lower one may be the sender's own claim (ADR 0294).
 */
export function firstHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  const want = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === want)?.value ?? null;
}

/** Parse `Name <addr@x>` / `addr@x` into a name + email (name null when absent). */
export function parseAddress(raw: string | undefined): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    return { name: name || null, email: m[2].trim().toLowerCase() };
  }
  const trimmed = raw.trim();
  return trimmed.includes('@')
    ? { name: null, email: trimmed.toLowerCase() }
    : { name: trimmed || null, email: null };
}

/** Split a comma-separated address header into normalized emails. */
export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => parseAddress(part).email)
    .filter((e): e is string => !!e);
}

/**
 * Postgres `text` cannot hold U+0000, and `email_messages.body_text` feeds a
 * GENERATED tsvector — so one NUL surviving a mis-declared charset would fail
 * the INSERT inside the sync and wedge that mailbox forever, the same shape as
 * the truncation ADR 0110's `left(body_text, 200000)` guards against. Stripped
 * where the bytes are decoded, so every body the mirror stores is storable.
 */
const stripNulls = (s: string): string => s.replace(/\0/g, '');

/** Walk a MIME payload tree collecting the first text/plain + text/html bodies. */
export function extractBodies(payload: GmailPayload | undefined): {
  text: string | null;
  html: string | null;
} {
  let text: string | null = null;
  let html: string | null = null;
  const walk = (node: GmailPayload | undefined): void => {
    if (!node) return;
    const mime = node.mimeType ?? '';
    // The part's own charset is honoured only when the bytes are not UTF-8.
    const decode = (data: string): string =>
      stripNulls(
        decodeText(
          Buffer.from(data, 'base64url'),
          charsetOf(node.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value),
        ),
      );
    if (mime === 'text/plain' && text === null && node.body?.data) {
      text = decode(node.body.data);
    } else if (mime === 'text/html' && html === null && node.body?.data) {
      html = decode(node.body.data);
    }
    for (const part of node.parts ?? []) walk(part);
  };
  walk(payload);
  return { text, html };
}

/** First MIME part that is (or carries) an iCalendar payload. */
export function findIcsPayloadPart(
  payload: GmailPayload | undefined,
): { data?: string; attachmentId?: string } | null {
  let found: { data?: string; attachmentId?: string } | null = null;
  const walk = (node: GmailPayload | undefined): void => {
    if (!node || found) return;
    const mt = (node.mimeType ?? '').toLowerCase();
    const isIcs =
      mt === 'text/calendar' || mt === 'application/ics' || /\.ics$/i.test(node.filename ?? '');
    if (isIcs) {
      if (node.body?.data) {
        found = { data: node.body.data };
        return;
      }
      if (node.body?.attachmentId) {
        found = { attachmentId: node.body.attachmentId };
        return;
      }
    }
    for (const p of node.parts ?? []) walk(p);
  };
  walk(payload);
  return found;
}

/**
 * `email_messages.ics_text` from a FULL payload (ADR 0080's three states):
 * the calendar text when it is inline, '' when the message has none, and
 * undefined (stored NULL, so the invite probe fetches) when the part is a
 * separate attachment that a sync fetch does not carry.
 */
export function inlineIcsText(payload: GmailPayload | undefined): string | undefined {
  const part = findIcsPayloadPart(payload);
  if (!part) return '';
  if (part.data) return stripNulls(Buffer.from(part.data, 'base64url').toString('utf8'));
  return undefined;
}

const isoFromInternal = (internalDate: string | undefined): string => {
  const ms = Number(internalDate ?? '');
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString();
};

/** Normalize a raw Gmail message (metadata or full) for storage. */
export function normalizeMessage(raw: GmailRawMessage): NormalizedMessage {
  const hm = headerMap(raw.payload?.headers);
  const from = parseAddress(hm['from']);
  const bodies = extractBodies(raw.payload);
  // A metadata fetch returns headers and nothing else, so anything derived
  // from the message body must stay UNDEFINED rather than be stored as empty.
  const isFull = raw.payload?.parts !== undefined || raw.payload?.body?.data !== undefined;
  const labelIds = raw.labelIds ?? [];
  return {
    gmailMessageId: raw.id,
    gmailThreadId: raw.threadId,
    fromName: from.name,
    fromEmail: from.email,
    toEmails: parseAddressList(hm['to']),
    ccEmails: parseAddressList(hm['cc']),
    subject: hm['subject'] ?? '',
    snippet: cleanGmailSnippet(raw.snippet),
    bodyText: bodies.text,
    bodyHtml: bodies.html,
    internalDate: isoFromInternal(raw.internalDate),
    isUnread: labelIds.includes('UNREAD'),
    labelIds,
    rfc822MessageId: hm['message-id'] ?? null,
    headers: {
      references: hm['references'] ?? null,
      inReplyTo: hm['in-reply-to'] ?? null,
      date: hm['date'] ?? null,
    },
    listUnsubscribe: hm['list-unsubscribe'] ?? null,
    listUnsubscribePost: hm['list-unsubscribe-post'] ?? null,
    listId: hm['list-id'] ?? null,
    autoReply: isAutoSubmitted(hm['auto-submitted']),
    // A metadata fetch names its headers (METADATA_HEADERS), and these are
    // not among them: undefined there, so the stored values survive it.
    replyTo: isFull ? (hm['reply-to'] ? parseAddress(hm['reply-to']).email : null) : undefined,
    authResults: isFull
      ? parseAuthenticationResults(firstHeader(raw.payload?.headers, 'authentication-results'))
      : undefined,
    // Only a full-format fetch carries a body; metadata leaves both of these
    // undefined so an upsert cannot wipe what an earlier full fetch captured.
    bodyExcerpt: isFull ? bodyExcerpt(modelBodyText(bodies)) : undefined,
    // ADR 0110 — parts are known at sync now, which is what lets attachment
    // import stop making its own second full fetch of the same message.
    attachmentsJson: isFull
      ? JSON.stringify(
          listAttachmentParts(raw.payload).map(toAttachmentRef),
        )
      : undefined,
    // The invite probe reads this before going back to Gmail for the message.
    icsText: isFull ? inlineIcsText(raw.payload) : undefined,
  };
}

/**
 * The same message, minus the body (ADR 0110).
 *
 * Sync fetches full now, because the AI passes need something to read and the
 * attachment parts come with it. What it KEEPS is the bounded excerpt: the
 * whole body belongs to the reader, which fetches it on thread open (ADR 0060)
 * and would otherwise be storing ~22 KB per message for text nothing reads.
 * One writer each is also what makes it impossible to show a truncated email.
 */
export function withoutBody(nm: NormalizedMessage): NormalizedMessage {
  return { ...nm, bodyText: null, bodyHtml: null };
}

// ── thread aggregation ────────────────────────────────────────────────
export interface ThreadAggregate {
  subject: string;
  snippet: string;
  fromName: string | null;
  fromEmail: string | null;
  lastMessageAt: string;
  messageCount: number;
  isUnread: boolean;
  isArchived: boolean;
  labelIds: string[];
}

/** The subset of message fields thread aggregation needs (satisfied by both
 *  NormalizedMessage and a mapped DB row). */
export interface ThreadMessageView {
  internalDate: string;
  subject: string;
  snippet: string;
  fromName: string | null;
  fromEmail: string | null;
  labelIds: string[];
  isUnread: boolean;
}

/**
 * Derive a thread's display + state fields from its messages. Unread if ANY
 * message is unread; archived (out of inbox) if NO message carries INBOX.
 * Subject/snippet/from come from the most recent message.
 *
 * Trash is per MESSAGE in Gmail: one trashed reply leaves the rest of the
 * thread in the inbox. So when any message is still live, the thread is
 * judged by its live messages only - otherwise the union carried TRASH and the
 * inbox predicate hid a thread Gmail still shows, with the trashed message's
 * snippet on the row. Only a thread trashed throughout reads as trashed.
 */
export function aggregateThread(messages: ThreadMessageView[]): ThreadAggregate {
  const live = messages.filter((m) => !m.labelIds.includes('TRASH'));
  const sorted = [...(live.length > 0 ? live : messages)].sort(
    (a, b) => Date.parse(a.internalDate) - Date.parse(b.internalDate),
  );
  const latest = sorted[sorted.length - 1];
  const firstWithSubject = sorted.find((m) => m.subject.trim().length > 0);
  const anyInbox = sorted.some((m) => m.labelIds.includes('INBOX'));
  const unionLabels = Array.from(new Set(sorted.flatMap((m) => m.labelIds)));
  return {
    subject: (firstWithSubject ?? latest)?.subject ?? '',
    snippet: latest?.snippet ?? '',
    fromName: latest?.fromName ?? null,
    fromEmail: latest?.fromEmail ?? null,
    lastMessageAt: latest?.internalDate ?? new Date(0).toISOString(),
    messageCount: sorted.length,
    isUnread: sorted.some((m) => m.isUnread),
    isArchived: sorted.length > 0 && !anyInbox,
    labelIds: unionLabels,
  };
}

// ── reply MIME ────────────────────────────────────────────────────────
export interface ReplyMimeInput {
  /** The connected account's own address (the From). */
  fromEmail: string;
  to: string[];
  /** Display name used when To is a single recipient (plain reply). */
  toName?: string | null;
  cc?: string[];
  /** Included as a header in the raw message; Gmail delivers to these and strips it. */
  bcc?: string[];
  subject: string;
  /** The Message-ID of the message being replied to. */
  inReplyTo: string | null;
  /** Existing References chain of the message being replied to. */
  references: string | null;
  body: string;
  /** When present, sent as multipart/alternative (plain + html). */
  htmlBody?: string | null;
  /** RFC 3834 — an automatic reply says so. */
  autoSubmitted?: boolean;
  /** Files to send; wraps the whole payload in multipart/mixed (ADR 0111). */
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
}

/** Ensure exactly one leading "Re: ". */
export function replySubject(subject: string): string {
  const base = subject.trim();
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** Minimal plain-text → HTML: escape, then newlines become <br>. */
export function textToHtml(text: string): string {
  // ADR 0131. Every caller is an outgoing, user-authored body, so one that
  // uses formatting gets it rendered. One that does not is escaped exactly as
  // before, byte for byte - the posture ADR 0111 took for a message with no
  // attachments.
  if (hasMarkdown(text)) return markdownToHtml(text);
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<div>${escaped.replace(/\r?\n/g, '<br>')}</div>`;
}

/**
 * Build a raw RFC-2822 reply message (returned already base64url-encoded, ready
 * for `messages.send { raw }`). Threading headers reuse the parent's Message-ID
 * (In-Reply-To) and append it to the References chain. With `htmlBody` the
 * payload is multipart/alternative (plain part first; clients prefer the html).
 */
/**
 * A filename safe to put in a header.
 *
 * CR and LF are the load-bearing part: a filename carrying one would end the
 * Content-Disposition line and let the rest be read as headers of its own,
 * which is header injection through a file picker. Quotes would end the quoted
 * string for the same reason. This is the ASCII stand-in only: the real name
 * travels beside it as `filename*=` (see `attachmentDisposition`), so
 * "Résumé – final.pdf" no longer arrives as "R_sum_ _ final.pdf".
 */
function headerSafeFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return cleaned.slice(0, 200) || 'attachment';
}

/** base64 in 76-character lines, as RFC 2045 requires. Some servers reject a
 *  single enormous line outright, so this is correctness, not neatness. */
function base64Lines(buf: Buffer): string {
  return (buf.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * Free text made safe for a header value.
 *
 * A header carries ASCII only. Raw UTF-8 there is read as Latin-1 by whoever
 * receives it, so "–" arrives as "â€“" - and because a reply reuses the
 * thread's subject, each further reply garbles it again. Anything non-ASCII
 * goes out as RFC 2047 encoded words instead: at most 75 characters each,
 * split between characters (never inside one), folded onto continuation lines.
 *
 * Line breaks are dropped first, for the reason `headerSafeFilename` gives: a
 * value carrying one would end its header and start another.
 */
export function encodeHeaderText(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  // 45 bytes is 60 base64 characters; with `=?UTF-8?B?` and `?=` that is 72.
  const MAX_BYTES = 45;
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
    chunk = '';
    chunkBytes = 0;
  };
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (chunkBytes + n > MAX_BYTES) flush();
    chunk += ch;
    chunkBytes += n;
  }
  flush();
  return words.join('\r\n ');
}

/** A line may be at most 998 bytes before its CRLF (RFC 5322 §2.1.1). */
const MAX_LINE_BYTES = 998;

/**
 * One text part: its headers, the blank line, its content.
 *
 * Sent as written whenever that is legal, so an ordinary message goes out
 * byte for byte as it always has. A part with a line too long to send - the
 * html of a long message is ONE line - is base64-encoded instead of being left
 * for whichever server relays it to break the line where it likes.
 */
function textPart(type: 'text/plain' | 'text/html', content: string): string[] {
  const head = `Content-Type: ${type}; charset="UTF-8"`;
  const tooLong = content
    .split(/\r?\n/)
    .some((l) => Buffer.byteLength(l, 'utf8') > MAX_LINE_BYTES);
  if (!tooLong) return [head, '', content];
  return [head, 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(content, 'utf8'))];
}

/** `Name <address>`, with the name encoded when it needs to be. */
function namedAddress(name: string, address: string): string {
  const encoded = encodeHeaderText(name);
  // Still plain ASCII: characters that mean something in an address list
  // ("Doe, John" is two addresses unquoted) need a quoted string.
  const display =
    encoded === name.replace(/[\r\n]+/g, ' ') && /[()<>[\]:;@\\,."]/.test(encoded)
      ? `"${encoded.replace(/[\\"]/g, '\\$&')}"`
      : encoded;
  return `${display} <${address}>`;
}

export function buildReplyRaw(input: ReplyMimeInput): string {
  const toHeader =
    input.to.length === 1 && input.toName
      ? namedAddress(input.toName, input.to[0]!)
      : input.to.join(', ');
  const refs = [input.references, input.inReplyTo].filter(Boolean).join(' ').trim();
  const lines = [`From: ${input.fromEmail}`, `To: ${toHeader}`];
  if (input.cc?.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.join(', ')}`);
  // Verbatim. Whether a subject wants "Re: " is the CALLER's business — the
  // builder serves compose as well as reply, and it used to force the prefix on
  // both, so a composed message went out as "Re: <whatever the user typed>".
  lines.push(`Subject: ${encodeHeaderText(input.subject)}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (refs) lines.push(`References: ${refs}`);
  if (input.autoSubmitted) lines.push('Auto-Submitted: auto-replied');
  lines.push('MIME-Version: 1.0');

  // The message proper, without its top-level Content-Type: either an
  // alternative pair or a bare text part. With attachments this becomes the
  // FIRST part of a multipart/mixed rather than the message itself.
  const alt = 'chord-alt-8f4c2a91';
  const body = input.htmlBody
    ? [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        `--${alt}`,
        ...textPart('text/plain', input.body),
        `--${alt}`,
        ...textPart('text/html', input.htmlBody),
        `--${alt}--`,
      ]
    : textPart('text/plain', input.body);

  if (input.attachments?.length) {
    const mixed = 'chord-mix-3b7e0d52';
    lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`);
    lines.push(...body);
    for (const att of input.attachments) {
      const name = headerSafeFilename(att.filename);
      lines.push(
        `--${mixed}`,
        `Content-Type: ${att.mimeType}; name="${name}"`,
        `Content-Disposition: ${attachmentDisposition(att.filename.slice(0, 200))}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(att.content),
      );
    }
    lines.push(`--${mixed}--`);
  } else {
    lines.push(...body);
  }
  return b64urlEncode(lines.join('\r\n'));
}
// ── iTIP reply MIME ───────────────────────────────────────────────────

export interface ItipReplyInput {
  fromEmail: string;
  fromName: string | null;
  organizerEmail: string;
  /** The invitation's UID — how the organizer matches this to their event. */
  icalUid: string;
  /** RFC 5545 PARTSTAT: ACCEPTED | DECLINED | TENTATIVE. */
  partstat: string;
  summary: string;
  sequence: number;
}

/** `YYYYMMDDTHHMMSSZ`, the only DTSTAMP form worth emitting. */
function icsStamp(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/**
 * Escape a TEXT value: backslash, semicolon, comma and newline are delimiters
 * in iCalendar, so a summary containing one would otherwise truncate or split
 * the property (RFC 5545 §3.3.11).
 */
function icsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * A PARAMETER value (`CN=`), which has different rules from a TEXT value: no
 * backslash escapes exist there. A value holding `:`, `;` or `,` is wrapped in
 * double quotes instead, and a double quote itself cannot appear at all
 * (RFC 5545 §3.2). Escaped the TEXT way, "Doe, John" ended the parameter at
 * the comma and the organizer's calendar read the name as `Doe\`.
 */
function icsParam(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

/** Fold a content line at 75 octets, between characters (RFC 5545 §3.1). */
function icsFold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    // A continuation line spends one octet on its leading space.
    if (bytes + n > (out.length === 0 ? 75 : 74)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * An iTIP `METHOD:REPLY` (RFC 5546 §3.2.3) telling an organizer how we are
 * answering. A REPLY carries exactly ONE attendee — the responder — and no
 * event detail beyond what identifies it: the organizer already owns the
 * meeting, and echoing our own idea of its time back at them is how a reply
 * ends up "correcting" an event nobody asked us to change.
 *
 * The calendar part is sent as a sibling of the human-readable text so a
 * client that does not speak iTIP still shows something, and the `method=REPLY`
 * parameter on the Content-Type is what makes a calendar client act on it
 * rather than file it as an attachment.
 */
export function buildItipReplyRaw(input: ItipReplyInput): string {
  return b64urlEncode(buildItipReplyMime(input));
}

/** The same REPLY as plain RFC 822 text, for providers that take MIME as is. */
export function buildItipReplyMime(input: ItipReplyInput): string {
  const verb =
    input.partstat === 'ACCEPTED'
      ? 'has accepted'
      : input.partstat === 'DECLINED'
        ? 'has declined'
        : 'has tentatively accepted';
  const who = input.fromName ? `${input.fromName} <${input.fromEmail}>` : input.fromEmail;
  const ics = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Chord//Chord Calendar//EN',
    'VERSION:2.0',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${input.icalUid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `ORGANIZER:mailto:${input.organizerEmail}`,
    `ATTENDEE;PARTSTAT=${input.partstat};CN=${icsParam(input.fromName ?? input.fromEmail)}:mailto:${input.fromEmail}`,
    `SUMMARY:${icsText(input.summary)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(icsFold)
    .join('\r\n');

  const boundary = 'chord-itip-4b1e77c0';
  const lines = [
    `From: ${input.fromName ? namedAddress(input.fromName, input.fromEmail) : input.fromEmail}`,
    `To: ${input.organizerEmail}`,
    `Subject: ${encodeHeaderText(`${input.partstat === 'DECLINED' ? 'Declined' : input.partstat === 'TENTATIVE' ? 'Tentative' : 'Accepted'}: ${input.summary}`)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    `${who} ${verb} this invitation.`,
    `--${boundary}`,
    'Content-Type: text/calendar; charset="UTF-8"; method=REPLY',
    '',
    ics,
    `--${boundary}--`,
  ];
  return lines.join('\r\n');
}

// ── iTIP request / cancel MIME (ADR 0328) ─────────────────────────────

export interface ItipRequestInput {
  method: 'REQUEST' | 'CANCEL';
  fromEmail: string;
  fromName: string | null;
  /** Everyone invited, organizer excluded. */
  attendees: Array<{ email: string; name?: string | null }>;
  /** Chord's key for the event; every later update and the replies use it. */
  icalUid: string;
  /** Raised on every change the guests are told about (RFC 5546 §2.1.4). */
  sequence: number;
  summary: string;
  location?: string | null;
  description?: string | null;
  /** As stored on the event: an instant with an offset, or a floating
   *  `YYYY-MM-DDT00:00:00` for an all-day entry. */
  startsAt: string;
  endsAt?: string | null;
  allDay: boolean;
}

/** `YYYYMMDD` of a stored date-time's own calendar date. */
function icsDate(stored: string): string {
  return stored.slice(0, 10).replace(/-/g, '');
}

function nextIcsDate(stored: string): string {
  const d = new Date(`${stored.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** The VCALENDAR body of a request or cancellation, without the MIME. */
export function buildItipRequestIcs(input: ItipRequestInput, now: Date = new Date()): string {
  const timing: string[] = [];
  if (input.allDay) {
    timing.push(`DTSTART;VALUE=DATE:${icsDate(input.startsAt)}`);
    timing.push(
      `DTEND;VALUE=DATE:${input.endsAt && icsDate(input.endsAt) > icsDate(input.startsAt) ? icsDate(input.endsAt) : nextIcsDate(input.startsAt)}`,
    );
  } else {
    const start = new Date(input.startsAt);
    const end = input.endsAt ? new Date(input.endsAt) : new Date(start.getTime() + 3_600_000);
    timing.push(`DTSTART:${icsStamp(start)}`);
    timing.push(`DTEND:${icsStamp(end)}`);
  }
  const organizerCn = icsParam(input.fromName ?? input.fromEmail);
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Chord//Chord Calendar//EN',
    'VERSION:2.0',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${input.icalUid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsStamp(now)}`,
    ...timing,
    `SUMMARY:${icsText(input.summary)}`,
    ...(input.location ? [`LOCATION:${icsText(input.location)}`] : []),
    ...(input.description ? [`DESCRIPTION:${icsText(input.description)}`] : []),
    `ORGANIZER;CN=${organizerCn}:mailto:${input.fromEmail}`,
    ...input.attendees.map(
      (a) =>
        `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${icsParam(a.name || a.email)}:mailto:${a.email}`,
    ),
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n');
}

/**
 * A calendar invitation (or its cancellation) as an RFC 822 message, for an
 * organizer whose events live only in Chord: the mail is the only way their
 * family's calendars hear about it. Same shape as the REPLY above: a text part
 * for people, a `text/calendar; method=...` part for calendars.
 */
export function buildItipRequestMime(input: ItipRequestInput, now: Date = new Date()): string {
  const ics = buildItipRequestIcs(input, now);
  const boundary = 'chord-itip-7d2a91e4';
  const when = input.allDay
    ? input.startsAt.slice(0, 10)
    : new Date(input.startsAt).toUTCString();
  const subject = input.method === 'CANCEL' ? `Cancelled: ${input.summary}` : `Invitation: ${input.summary}`;
  const text =
    input.method === 'CANCEL'
      ? `${input.summary} (${when}) has been cancelled.`
      : `You are invited to ${input.summary} (${when})${input.location ? ` at ${input.location}` : ''}.`;
  const lines = [
    `From: ${input.fromName ? namedAddress(input.fromName, input.fromEmail) : input.fromEmail}`,
    `To: ${input.attendees.map((a) => a.email).join(', ')}`,
    `Subject: ${encodeHeaderText(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    `--${boundary}`,
    `Content-Type: text/calendar; charset="UTF-8"; method=${input.method}`,
    '',
    ics,
    `--${boundary}--`,
  ];
  return lines.join('\r\n');
}

export function buildItipRequestRaw(input: ItipRequestInput, now: Date = new Date()): string {
  return b64urlEncode(buildItipRequestMime(input, now));
}

// ── Gmail history diff ────────────────────────────────────────────────
export interface GmailHistoryRecord {
  id?: string;
  messagesAdded?: { message: { id: string; threadId: string } }[];
  messagesDeleted?: { message: { id: string; threadId: string } }[];
  labelsAdded?: { message: { id: string; threadId: string }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; threadId: string }; labelIds: string[] }[];
}

export interface HistoryDiff {
  /** Message ids to fetch + upsert. */
  addedMessageIds: string[];
  /** Message ids removed from the mailbox. */
  deletedMessageIds: string[];
  /** Per-message label add/remove, applied to local rows. */
  labelChanges: { messageId: string; add: string[]; remove: string[] }[];
  /** Thread ids touched (need re-aggregation). */
  touchedThreadIds: string[];
}

/** Collapse a page of history records into a single applyable diff. */
export function diffHistory(records: GmailHistoryRecord[]): HistoryDiff {
  const added = new Set<string>();
  const deleted = new Set<string>();
  const threads = new Set<string>();
  const labelByMsg = new Map<string, { add: Set<string>; remove: Set<string> }>();
  const ensure = (id: string) => {
    let e = labelByMsg.get(id);
    if (!e) {
      e = { add: new Set(), remove: new Set() };
      labelByMsg.set(id, e);
    }
    return e;
  };
  for (const rec of records) {
    for (const a of rec.messagesAdded ?? []) {
      added.add(a.message.id);
      deleted.delete(a.message.id);
      threads.add(a.message.threadId);
    }
    for (const d of rec.messagesDeleted ?? []) {
      deleted.add(d.message.id);
      added.delete(d.message.id);
      threads.add(d.message.threadId);
    }
    for (const la of rec.labelsAdded ?? []) {
      const e = ensure(la.message.id);
      for (const l of la.labelIds) {
        e.add.add(l);
        e.remove.delete(l);
      }
      threads.add(la.message.threadId);
    }
    for (const lr of rec.labelsRemoved ?? []) {
      const e = ensure(lr.message.id);
      for (const l of lr.labelIds) {
        e.remove.add(l);
        e.add.delete(l);
      }
      threads.add(lr.message.threadId);
    }
  }
  return {
    addedMessageIds: [...added],
    deletedMessageIds: [...deleted],
    labelChanges: [...labelByMsg.entries()].map(([messageId, e]) => ({
      messageId,
      add: [...e.add],
      remove: [...e.remove],
    })),
    touchedThreadIds: [...threads],
  };
}

/** Apply a label add/remove set to an existing label-id array. */
export function applyLabelDelta(current: string[], add: string[], remove: string[]): string[] {
  const set = new Set(current);
  for (const l of remove) set.delete(l);
  for (const l of add) set.add(l);
  return [...set];
}
