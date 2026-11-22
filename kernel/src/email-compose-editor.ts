/**
 * ADR 0339 - an email can be written Plain or Rich.
 *
 * Rich is a page of its own whose body is editable (a sandboxed iframe on
 * web, a WebView on a phone), the same approach as the Settings signature
 * editor (ADR 0260 addendum), so no native module and no new build. The app's
 * toolbar sends the page a command (bold, a list, a link); the page tells the
 * app its HTML and text as they change. The signature sits at the bottom of
 * the page as its own block, drawn as it will be sent. The server cleans the
 * HTML on send, so nothing here is trusted.
 */
import { joinRichSignature, signatureBlock, splitRichSignature } from './email-signature';
import { isSignatureLinkHref } from './signature-editor';

export type ComposeFormat = 'plain' | 'rich';

/** The most HTML the editor reports, the same ceiling the server keeps. */
export const COMPOSE_EDITOR_HTML_MAX = 200_000;

/** The editor frame on web: its script runs, nothing else. */
export const COMPOSE_EDITOR_SANDBOX = 'allow-scripts';

export type ComposeCommand =
  | { cmd: 'bold' | 'italic' | 'underline' | 'ul' | 'ol' | 'clear' }
  | { cmd: 'link'; href: string }
  | { cmd: 'focus' };

export type ComposeEditorMessage =
  | { kind: 'change'; html: string; text: string; mainText: string }
  | { kind: 'height'; height: number }
  | { kind: 'state'; bold: boolean; italic: boolean; underline: boolean; ul: boolean; ol: boolean; link: boolean };

/**
 * Which way a composer opens (owner, 2026-11-13): a reply or forward follows
 * the email it answers (an HTML email opens Rich, a plain-text one Plain); a
 * new message opens Rich. A saved draft opens the way it was written.
 */
export function defaultComposeFormat(opts: {
  kind: 'new' | 'reply' | 'forward';
  original?: { bodyHtml?: string | null } | null;
  draftFormat?: ComposeFormat | null;
}): ComposeFormat {
  if (opts.draftFormat) return opts.draftFormat;
  if (opts.kind === 'new') return 'rich';
  return opts.original?.bodyHtml?.trim() ? 'rich' : 'plain';
}

/** The attribute that marks the signature block inside the editor. */
export const SIGNATURE_BLOCK_ATTR = 'data-chord-signature';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Typed text as editor HTML: one block per line, an empty line kept. */
export function textToEditorHtml(text: string): string {
  if (!text) return '<div><br></div>';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
    .join('');
}

/** The signature as it sits at the bottom of the editor. */
export function signatureEditorBlock(signatureHtml: string): string {
  return `<div ${SIGNATURE_BLOCK_ATTR}="1"><div>-- </div>${signatureHtml}</div>`;
}

/**
 * Plain to Rich. The text above the signature becomes editor lines; the plain
 * signature, when it is the saved one and unchanged, becomes the rich one.
 * An edited signature stays as the text it was edited to.
 */
export function plainToRich(
  body: string,
  signature: string | null | undefined,
  signatureHtml: string | null | undefined,
): string {
  const { main, atEnd } = splitRichSignature(body, signature);
  // A blank line before the signature, as a plain one has: the sent email
  // carries no editor styles.
  if (atEnd && signatureHtml?.trim()) return `${textToEditorHtml(main)}<div><br></div>${signatureEditorBlock(signatureHtml)}`;
  return textToEditorHtml(body);
}

/**
 * Rich to Plain, from what the page reported. With the signature block still
 * there, the text above it plus the plain signature; else the page's text.
 */
export function richToPlain(
  page: { text: string; mainText: string; hasSignature: boolean },
  signature: string | null | undefined,
): string {
  const main = page.mainText.replace(/\s+$/, '');
  if (page.hasSignature && signatureBlock(signature)) return joinRichSignature(main, signature);
  return page.text.replace(/\s+$/, '');
}

/**
 * The text body that goes with a rich message: what is written, then the
 * plain signature when the block is there. Kept in the same shape a plain
 * draft has, so "only the signature" and the AI draft work the same way.
 */
export function richBodyText(page: { text: string; mainText: string; hasSignature: boolean }, signature: string | null | undefined): string {
  return richToPlain(page, signature);
}

/** Does `html` still hold the signature block. */
export function hasSignatureBlock(html: string): boolean {
  return html.includes(`${SIGNATURE_BLOCK_ATTR}="1"`);
}

/**
 * An AI draft (plain text) placed in a rich editor: the written part replaced,
 * the signature block kept.
 */
export function replaceRichMain(html: string, text: string): string {
  const at = html.indexOf(`<div ${SIGNATURE_BLOCK_ATTR}="1"`);
  const sig = at >= 0 ? html.slice(at) : '';
  return textToEditorHtml(text.replace(/\s+$/, '')) + (sig ? `<div><br></div>${sig}` : '');
}

/** The signature block's HTML swapped for another mailbox's (From changed). */
export function swapRichSignature(html: string, signatureHtml: string | null | undefined): string {
  const at = html.indexOf(`<div ${SIGNATURE_BLOCK_ATTR}="1"`);
  const main = at >= 0 ? html.slice(0, at) : html;
  return signatureHtml?.trim() ? main + signatureEditorBlock(signatureHtml) : main;
}

/** What a message from the editor page says, or null for anything else. */
export function parseComposeEditorMessage(data: unknown): ComposeEditorMessage | null {
  let m: unknown = data;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.chordCompose === 'change') {
    if (typeof o.html !== 'string' || o.html.length > COMPOSE_EDITOR_HTML_MAX) return null;
    const text = typeof o.text === 'string' ? o.text.slice(0, 60_000) : '';
    const mainText = typeof o.mainText === 'string' ? o.mainText.slice(0, 60_000) : text;
    return { kind: 'change', html: o.html, text, mainText };
  }
  if (o.chordCompose === 'height') {
    const h = o.height;
    return typeof h === 'number' && Number.isFinite(h) && h > 0 ? { kind: 'height', height: Math.min(Math.ceil(h), 20_000) } : null;
  }
  if (o.chordCompose === 'state') {
    const b = (k: string) => o[k] === true;
    return { kind: 'state', bold: b('bold'), italic: b('italic'), underline: b('underline'), ul: b('ul'), ol: b('ol'), link: b('link') };
  }
  return null;
}

/** A command as the page accepts it, or null when it must not be sent. */
export function composeCommandPayload(c: ComposeCommand): string | null {
  if (c.cmd === 'link' && !isSignatureLinkHref(c.href)) return null;
  return JSON.stringify({ chordComposeCmd: c.cmd, ...(c.cmd === 'link' ? { href: c.href.trim() } : {}) });
}

const NONCE_SHAPE = /^[A-Za-z0-9+/=_-]{8,64}$/;

/**
 * The page script: reports changes (debounced), height and the formatting at
 * the caret; runs a command it is sent. Never navigates; a link click is
 * ignored (the app edits links through its own field). Commands are taken
 * from the parent window only (web) or from the app's injected call (phone).
 */
export const COMPOSE_EDITOR_SCRIPT = `
(function(){
  var root = document.getElementById('chord-compose');
  if (!root) return;
  var rn = window.ReactNativeWebView && window.ReactNativeWebView.postMessage ? window.ReactNativeWebView : null;
  function send(m){ try { if (rn) rn.postMessage(JSON.stringify(m)); else window.parent.postMessage(m, '*'); } catch (e) {} }
  var lastH = -1, timer = null, saved = null;
  function sigBlock(){ return root.querySelector('[${SIGNATURE_BLOCK_ATTR}="1"]'); }
  function mainText(){
    var sig = sigBlock();
    if (!sig) return root.innerText;
    var clone = root.cloneNode(true);
    var s = clone.querySelector('[${SIGNATURE_BLOCK_ATTR}="1"]');
    if (s) s.parentNode.removeChild(s);
    var holder = document.createElement('div');
    holder.style.position = 'absolute'; holder.style.left = '-99999px';
    holder.appendChild(clone); document.body.appendChild(holder);
    var t = clone.innerText; document.body.removeChild(holder);
    return t;
  }
  function height(){ var h = Math.ceil(root.getBoundingClientRect().height) + 2; if (h !== lastH) { lastH = h; send({ chordCompose: 'height', height: h }); } }
  function report(){ send({ chordCompose: 'change', html: root.innerHTML, text: root.innerText, mainText: mainText() }); }
  function changed(){ height(); if (timer) clearTimeout(timer); timer = setTimeout(report, 150); }
  function inside(node){ while (node) { if (node === root) return true; node = node.parentNode; } return false; }
  function state(){
    var sel = document.getSelection();
    if (sel && sel.rangeCount && inside(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
    var a = sel && sel.anchorNode; var link = false;
    while (a && a !== root) { if (a.nodeName === 'A') { link = true; break; } a = a.parentNode; }
    send({ chordCompose: 'state', bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), underline: document.queryCommandState('underline'), ul: document.queryCommandState('insertUnorderedList'), ol: document.queryCommandState('insertOrderedList'), link: link });
  }
  function restore(){ if (!saved) return; root.focus(); var sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(saved); }
  function run(m){
    if (!m || typeof m.chordComposeCmd !== 'string') return;
    var c = m.chordComposeCmd;
    if (c === 'focus') { root.focus(); return; }
    restore();
    if (c === 'bold' || c === 'italic' || c === 'underline') document.execCommand(c);
    else if (c === 'ul') document.execCommand('insertUnorderedList');
    else if (c === 'ol') document.execCommand('insertOrderedList');
    else if (c === 'clear') { document.execCommand('removeFormat'); document.execCommand('unlink'); }
    else if (c === 'link' && typeof m.href === 'string' && /^(https?:\\/\\/|mailto:|tel:)\\S+$/i.test(m.href)) {
      var sel = document.getSelection();
      if (sel && sel.isCollapsed) { document.execCommand('insertHTML', false, '<a href="' + m.href.replace(/"/g, '&quot;') + '">' + m.href.replace(/[<&]/g, '') + '</a>'); }
      else document.execCommand('createLink', false, m.href);
    }
    changed(); state();
  }
  window.chordComposeRun = function(json){ try { run(JSON.parse(json)); } catch (e) {} };
  window.addEventListener('message', function(e){ if (!rn && e.source === window.parent) run(e.data && typeof e.data === 'object' ? e.data : null); });
  root.addEventListener('input', changed);
  root.addEventListener('click', function(e){ var t = e.target; if (t && t.closest && t.closest('a')) e.preventDefault(); });
  document.addEventListener('selectionchange', state);
  root.addEventListener('keyup', state);
  var imgs = document.images; for (var k = 0; k < imgs.length; k++) imgs[k].addEventListener('load', height);
  window.addEventListener('resize', height);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(height).observe(root);
  height();
})();
true;
`;

/**
 * The editor page around `html`. Its policy loads images (the person's own
 * signature, a picture they pasted) and runs only the editor script.
 * Written for a white page, like the email it becomes.
 */
export function composeEditorDocument(
  html: string,
  opts: { nonce?: string; apiOrigin?: string; placeholder?: string; minHeight?: number } = {},
): string {
  const nonce = opts.nonce && NONCE_SHAPE.test(opts.nonce) ? opts.nonce : null;
  const origin = /^https?:\/\/[^/?#\s'";]+/i.exec((opts.apiOrigin ?? '').trim())?.[0] ?? '';
  const csp = [
    "default-src 'none'",
    `img-src data: https:${origin ? ` ${origin}` : ''}`,
    ...(nonce ? [`script-src 'nonce-${nonce}'`] : []),
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const script = nonce ? `<script nonce="${nonce}">${COMPOSE_EDITOR_SCRIPT}</script>` : '';
  const min = Math.max(80, Math.min(opts.minHeight ?? 160, 2000));
  const placeholder = escapeHtml(opts.placeholder ?? '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>html,body{margin:0;padding:0;background:#fff;color:#1A1A18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;overflow:hidden}
#chord-compose{padding:10px 12px;outline:none;min-height:${min}px;overflow-wrap:anywhere}
#chord-compose:empty:before{content:attr(data-placeholder);color:#9C9A90}
#chord-compose img{max-width:100%}#chord-compose a{color:#1a5fb4}</style>
</head><body><div id="chord-compose" contenteditable="true" data-placeholder="${placeholder}">${html.slice(0, COMPOSE_EDITOR_HTML_MAX)}</div>${script}</body></html>`;
}

