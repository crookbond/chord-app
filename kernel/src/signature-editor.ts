/**
 * ADR 0260 addendum (2026-11-13) - a rich signature is edited as it looks,
 * not as HTML. Settings draws it in a page of its own (a sandboxed iframe on
 * web, a WebView on a phone) whose body is editable; the page tells the app
 * the new HTML as it changes and which link was tapped. The server cleans the
 * HTML on save, as it does a pasted one, so nothing here is trusted.
 */

/** The most HTML the editor reports, the same ceiling the server keeps. */
export const SIGNATURE_EDITOR_HTML_MAX = 20_000;

/** The editor frame on web: its script runs, nothing else (no same-origin, no popups). */
export const SIGNATURE_EDITOR_SANDBOX = 'allow-scripts';

export type SignatureEditorMessage =
  | { kind: 'html'; html: string }
  | { kind: 'height'; height: number }
  | { kind: 'link'; index: number; href: string; text: string };

const NONCE_SHAPE = /^[A-Za-z0-9+/=_-]{8,64}$/;

/** A link address the editor may set: web, mail or phone. */
export function isSignatureLinkHref(href: unknown): boolean {
  return typeof href === 'string' && href.length <= 2000 && /^(https?:\/\/|mailto:|tel:)\S+$/i.test(href.trim());
}

/**
 * A link address as a person types it, made into one: an email address gets
 * `mailto:`, a bare `www.` site `https://`, a phone number `tel:`. Null when it
 * is none of those.
 */
export function signatureLinkInput(typed: string): string | null {
  const t = typed.trim();
  if (!t) return null;
  if (isSignatureLinkHref(t)) return t;
  if (/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(t)) return `mailto:${t}`;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(t)) return `https://${t}`;
  if (/^\+?[\d\s().-]{7,20}$/.test(t)) return `tel:${t.replace(/[^\d+]/g, '')}`;
  return null;
}

/** What a message from the editor page says, or null for anything else. A phone sends it as JSON text. */
export function parseSignatureEditorMessage(data: unknown): SignatureEditorMessage | null {
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
  if (o.chordSignature === 'html') {
    return typeof o.html === 'string' && o.html.length <= SIGNATURE_EDITOR_HTML_MAX ? { kind: 'html', html: o.html } : null;
  }
  if (o.chordSignature === 'height') {
    const h = o.height;
    return typeof h === 'number' && Number.isFinite(h) && h > 0 ? { kind: 'height', height: Math.min(Math.ceil(h), 2000) } : null;
  }
  if (o.chordSignature === 'link') {
    const i = o.index;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > 500) return null;
    const href = typeof o.href === 'string' ? o.href.slice(0, 2000) : '';
    const text = typeof o.text === 'string' ? o.text.slice(0, 200) : '';
    return { kind: 'link', index: i, href, text };
  }
  return null;
}

const A_TAG = /<a\b[^>]*>/gi;

/** The address of the `index`th link in `html`, or null. */
export function signatureLinkHref(html: string, index: number): string | null {
  const tags = html.match(A_TAG) ?? [];
  const tag = tags[index];
  if (!tag) return null;
  const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return null;
  return decodeAttr(m[2] ?? m[3] ?? m[4] ?? '');
}

/**
 * `html` with the `index`th link pointed at `href`, or, with `href` null, the
 * link removed and its text kept. Unchanged when there is no such link or the
 * address is not a web, mail or phone one.
 */
export function setSignatureLinkHref(html: string, index: number, href: string | null): string {
  if (href !== null && !isSignatureLinkHref(href)) return html;
  let n = -1;
  let opened = -1;
  const out = html.replace(A_TAG, (tag, offset: number) => {
    n += 1;
    if (n !== index) return tag;
    opened = offset;
    if (href === null) return '\u0000';
    const value = `href="${escapeAttr(href.trim())}"`;
    return /\bhref\s*=/i.test(tag)
      ? tag.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, value)
      : tag.replace(/^<a\b/i, `<a ${value}`);
  });
  if (href !== null || opened < 0) return out;
  // Removing: drop the opening tag (marked) and its closing tag after it.
  const at = out.indexOf('\u0000');
  const close = /<\/a\s*>/i.exec(out.slice(at));
  const end = close ? at + close.index : -1;
  if (end < 0) return out.replace('\u0000', '');
  return out.slice(0, at) + out.slice(at + 1, end) + out.slice(end + close![0].length);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * The script the editor page runs: it reports the HTML (debounced), its
 * height, and a tapped link. Never navigates. Works as an injected script on
 * a phone and as a nonce'd one in the web frame.
 */
export const SIGNATURE_EDITOR_SCRIPT = `
(function(){
  var root = document.getElementById('chord-sig');
  if (!root) return;
  var rn = window.ReactNativeWebView && window.ReactNativeWebView.postMessage ? window.ReactNativeWebView : null;
  function send(m){
    try { if (rn) rn.postMessage(JSON.stringify(m)); else window.parent.postMessage(m, '*'); } catch (e) {}
  }
  var lastH = -1, timer = null;
  function height(){
    var h = Math.ceil(root.getBoundingClientRect().height) + 2;
    if (h !== lastH) { lastH = h; send({ chordSignature: 'height', height: h }); }
  }
  function changed(){
    height();
    if (timer) clearTimeout(timer);
    timer = setTimeout(function(){ send({ chordSignature: 'html', html: root.innerHTML }); }, 200);
  }
  root.addEventListener('input', changed);
  root.addEventListener('click', function(e){
    var t = e.target;
    var a = t && t.closest ? t.closest('a') : null;
    if (!a) return;
    e.preventDefault();
    var links = root.querySelectorAll('a');
    var i = Array.prototype.indexOf.call(links, a);
    send({ chordSignature: 'link', index: i, href: a.getAttribute('href') || '', text: (a.textContent || '').slice(0, 200) });
  });
  var imgs = document.images;
  for (var k = 0; k < imgs.length; k++) imgs[k].addEventListener('load', height);
  window.addEventListener('resize', height);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(height).observe(root);
  height();
})();
true;
`;

/**
 * The editor page around `html`. Its policy loads images (the person chose
 * them) and runs only the editor script (`nonce` on web; a phone injects it).
 * Written for a white page, like an email body, in either app theme.
 */
export function signatureEditorDocument(html: string, opts: { nonce?: string; apiOrigin?: string } = {}): string {
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
  const script = nonce ? `<script nonce="${nonce}">${SIGNATURE_EDITOR_SCRIPT}</script>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>html,body{margin:0;padding:0;background:#fff;color:#1A1A18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;overflow:hidden}
#chord-sig{padding:10px;outline:none;min-height:40px;overflow-wrap:anywhere}#chord-sig img{max-width:100%}#chord-sig a{color:#1a5fb4;cursor:pointer}</style>
</head><body><div id="chord-sig" contenteditable="true">${html.slice(0, SIGNATURE_EDITOR_HTML_MAX)}</div>${script}</body></html>`;
}
