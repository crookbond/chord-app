/**
 * Where a signature sits in an email body (ADR 0260 addendum).
 *
 * The signature is part of the text the person types, not something added at
 * send: the composer opens with it under the cursor, what is in the box is what
 * goes, and deleting it means none goes. The app and the server both place it,
 * so the rule lives here once.
 */

/** The line that marks where a message ends and its signature begins. */
export const SIGNATURE_SEPARATOR = '-- ';

/**
 * The shared signature of someone who never set one. Stored as NULL; a
 * signature the user cleared is stored as '' and means none.
 */
export const DEFAULT_EMAIL_SIGNATURE = 'Get Chord at https://www.chordapp.ai';

/** The shared signature as stored, with never-set read as the default. */
export function sharedSignature(stored: string | null | undefined): string {
  return stored === null || stored === undefined ? DEFAULT_EMAIL_SIGNATURE : stored;
}

function cleanSignature(signature: string | null | undefined): string {
  return (signature ?? '').replace(/\r\n/g, '\n').trim();
}

/** The separator line followed by the signature, or '' when there is none. */
export function signatureBlock(signature: string | null | undefined): string {
  const sig = cleanSignature(signature);
  return sig ? `${SIGNATURE_SEPARATOR}\n${sig}` : '';
}

/**
 * Where the user's signature block starts in `body`, or -1. It must stand on its
 * own lines, unchanged; an edited signature is the person's own text and is not
 * found (it goes out as they wrote it).
 */
export function findSignature(body: string, signature: string | null | undefined): number {
  const block = signatureBlock(signature);
  if (!block) return -1;
  const text = body.replace(/\r\n/g, '\n');
  for (let at = text.lastIndexOf(block); at >= 0; at = at === 0 ? -1 : text.lastIndexOf(block, at - 1)) {
    const before = at === 0 || text[at - 1] === '\n';
    const end = at + block.length;
    const after = end === text.length || text[end] === '\n';
    if (before && after) return at;
  }
  return -1;
}

/** `body` with the signature under it, unless it is already there or there is none. */
export function bodyWithSignature(body: string, signature: string | null | undefined): string {
  const block = signatureBlock(signature);
  if (!block || findSignature(body, signature) >= 0) return body;
  const main = body.replace(/\s+$/, '');
  return main ? `${main}\n\n${block}` : `\n\n${block}`;
}

/** Where the last `-- ` separator line starts in `body`, or -1. */
function lastSeparator(text: string): number {
  for (let at = text.lastIndexOf(SIGNATURE_SEPARATOR); at >= 0; at = at === 0 ? -1 : text.lastIndexOf(SIGNATURE_SEPARATOR, at - 1)) {
    const before = at === 0 || text[at - 1] === '\n';
    const end = at + SIGNATURE_SEPARATOR.length;
    if (before && (end === text.length || text[end] === '\n')) return at;
  }
  return -1;
}

/**
 * True when `body` ends with a signature block that is not the saved one: a
 * `-- ` line with text under it that does not match `current`. That is how an
 * older copy looks after the signature was changed in Settings, or one left in
 * a saved draft. The send uses the rich signature only for an exact match, so
 * such a block goes out as typed text - worth saying before Send.
 */
export function hasOutdatedSignature(body: string, current: string | null | undefined): boolean {
  if (!cleanSignature(current) || findSignature(body, current) >= 0) return false;
  const text = body.replace(/\r\n/g, '\n');
  const at = lastSeparator(text);
  return at >= 0 && text.slice(at + SIGNATURE_SEPARATOR.length).trim().length > 0;
}

/** `body` with the signature block at its end replaced by the saved one. */
export function replaceOutdatedSignature(body: string, current: string | null | undefined): string {
  const text = body.replace(/\r\n/g, '\n');
  const at = lastSeparator(text);
  if (at < 0) return bodyWithSignature(body, current);
  const before = text.slice(0, at).replace(/\s+$/, '');
  const block = signatureBlock(current);
  if (!block) return before;
  return before ? `${before}\n\n${block}` : `\n\n${block}`;
}

/**
 * The text above the signature, and whether the signature was there. What an AI
 * draft revises: it should rewrite the message, not the signature under it.
 */
export function splitSignature(
  body: string,
  signature: string | null | undefined,
): { main: string; hadSignature: boolean } {
  const at = findSignature(body, signature);
  if (at < 0) return { main: body, hadSignature: false };
  const text = body.replace(/\r\n/g, '\n');
  const block = signatureBlock(signature);
  const before = text.slice(0, at).replace(/\s+$/, '');
  const after = text.slice(at + block.length).replace(/^\n+/, '').replace(/\s+$/, '');
  const main = before && after ? `${before}\n\n${after}` : before || after;
  return { main, hadSignature: true };
}

/**
 * What an AI ask sends as the text to revise. A typed ask revises what is in
 * the box; Suggested (`fresh`) never does - a saved draft may answer an older
 * message, and Continue draft is how a person picks that up.
 */
export function aiDraftToRevise(
  box: string,
  signature: string | null | undefined,
  opts: { fresh: boolean },
): string | undefined {
  if (opts.fresh) return undefined;
  const { main } = splitSignature(box, signature);
  return main.trim() ? main : undefined;
}

/**
 * The box after an AI reply lands: the signature stays under it unless the
 * person had deleted it from a box they were writing in.
 */
export function placeAiReply(box: string, written: string, signature: string | null | undefined): string {
  return !box.trim() || splitSignature(box, signature).hadSignature
    ? bodyWithSignature(written, signature)
    : written;
}

/** True when the box holds nothing but the signature: nothing written yet. */
export function isOnlySignature(body: string, signature: string | null | undefined): boolean {
  if (!body.trim()) return true;
  const { main, hadSignature } = splitSignature(body, signature);
  return hadSignature && !main.trim();
}

/**
 * Where the caret goes in a composer box: 0 (above the signature) while
 * nothing has been written yet, else null - leave it where the person put it.
 * A browser puts the caret at the END of a box's text on focus and whenever
 * the text is set while focused, which is under the signature.
 */
export function signatureCaret(body: string, signature: string | null | undefined): number | null {
  if (findSignature(body, signature) < 0) return null;
  return isOnlySignature(body, signature) ? 0 : null;
}

/**
 * The key a per-mailbox signature is stored under: 'primary' for the login's
 * Gmail (which has no account row, ADR 0080), else the attached account's id.
 */
export function mailboxSignatureKey(accountId: string | null | undefined): string {
  return accountId || 'primary';
}

export interface MailboxSignatureValue {
  text: string | null;
  html: string | null;
}

/**
 * The signature mail from one mailbox carries: that mailbox's own when it has
 * one, else the signature shared by every mailbox.
 */
export function signatureForMailbox(
  shared: string | null | undefined,
  perMailbox: Record<string, MailboxSignatureValue> | null | undefined,
  accountId: string | null | undefined,
): string | null {
  const own = perMailbox?.[mailboxSignatureKey(accountId)];
  const text = own ? own.text : shared;
  return text?.trim() || null;
}

/**
 * `body` with one signature replaced by another, for when the From changes in
 * a composer. Only an unchanged signature is swapped: an edited one is the
 * person's own text, and one they deleted stays deleted. An empty box gets
 * the new signature, the way a fresh composer opens.
 */
export function swapSignature(
  body: string,
  from: string | null | undefined,
  to: string | null | undefined,
): string {
  if (cleanSignature(from) === cleanSignature(to)) return body;
  if (!body.trim()) return bodyWithSignature('', to);
  const at = findSignature(body, from);
  if (at < 0) return body;
  const text = body.replace(/\r\n/g, '\n');
  const before = text.slice(0, at).replace(/\s+$/, '');
  const after = text.slice(at + signatureBlock(from).length);
  const block = signatureBlock(to);
  if (!block) return before + (after.trim() ? `\n\n${after.replace(/^\n+/, '')}` : '');
  return `${before}\n\n${block}${after}`;
}

/**
 * The rich (HTML) signature mail from one mailbox carries, or null. Same rule
 * as `signatureForMailbox`: a mailbox's own entry wins, even when it has none.
 */
export function signatureHtmlForMailbox(
  sharedHtml: string | null | undefined,
  perMailbox: Record<string, MailboxSignatureValue> | null | undefined,
  accountId: string | null | undefined,
): string | null {
  const own = perMailbox?.[mailboxSignatureKey(accountId)];
  const html = own ? own.html : sharedHtml;
  return html?.trim() || null;
}

/**
 * ADR 0338 - the composer shows a rich signature as it will look. When `body`
 * ends in the saved signature, unchanged, `main` is what the person writes
 * (the box) and the signature is drawn under it. Lossless: `joinRichSignature`
 * puts back exactly what was split, trailing spaces included, so typing in
 * the box never moves the caret.
 */
export function splitRichSignature(
  body: string,
  signature: string | null | undefined,
): { main: string; atEnd: boolean } {
  const block = signatureBlock(signature);
  const text = body.replace(/\r\n/g, '\n');
  const at = findSignature(text, signature);
  if (!block || at < 0 || text.slice(at + block.length).trim()) return { main: body, atEnd: false };
  const before = text.slice(0, at);
  const main = before.endsWith('\n\n') ? before.slice(0, -2) : before.endsWith('\n') ? before.slice(0, -1) : before;
  return { main, atEnd: true };
}

/** The draft body for what is in the box with the signature under it. */
export function joinRichSignature(main: string, signature: string | null | undefined): string {
  const block = signatureBlock(signature);
  return block ? `${main}\n\n${block}` : main;
}
