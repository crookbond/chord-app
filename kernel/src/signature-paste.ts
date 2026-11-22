/**
 * ADR 0326 - turning a pasted signature into signature HTML.
 *
 * What a mail app puts on the clipboard when a signature is copied is a whole
 * HTML document (Word and Outlook add styles, XML islands and conditional
 * comments), and its pictures are either inside it (`data:`) or references a
 * recipient can never load (`cid:`, `file:`, `blob:`). These rules pick out
 * the signature and say what each picture needs; the app uploads the pictures
 * and the server's allow-list cleans the rest when it is saved.
 */

type StyleRule = { tag: string | null; cls: string | null; specificity: number; order: number; decls: [string, string][] };

/** Declarations worth carrying: Office-only (`mso-`) ones and anything that loads a resource are not. */
function parseDeclarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!important/gi, '').trim();
    if (!prop || !value || prop.startsWith('mso-') || /url\s*\(|expression\s*\(/i.test(value)) continue;
    out.push([prop, value]);
  }
  return out;
}

/** The simple rules (`p`, `.MsoNormal`, `p.MsoNormal`, comma lists) of every `<style>` block. */
function styleRules(html: string): StyleRule[] {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)]
    .map((m) => m[1])
    .join('\n')
    .replace(/<!--|-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: StyleRule[] = [];
  let order = 0;
  // An @-rule block (@media, @font-face, @page) has nested braces; its body is not this page's styling.
  const flat = css.replace(/@[\w-]+[^{;]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').replace(/@[^;{]*;/g, '');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = parseDeclarations(m[2]);
    if (!decls.length) continue;
    for (const raw of m[1].split(',')) {
      const sel = /^\s*([a-z][\w-]*)?(?:\.([\w-]+))?\s*$/i.exec(raw);
      if (!sel || (!sel[1] && !sel[2])) continue;
      const tag = sel[1]?.toLowerCase() ?? null;
      const cls = sel[2]?.toLowerCase() ?? null;
      rules.push({ tag, cls, specificity: (tag ? 1 : 0) + (cls ? 10 : 0), order: order++, decls });
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

const ATTR = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

/** The style an element ends up with: matching rules first, its own `style` last (so it wins). */
function computedStyle(rules: StyleRule[], tag: string, attrs: string): string {
  const classMatch = ATTR('class').exec(attrs);
  const classes = new Set(
    (classMatch ? (classMatch[2] ?? classMatch[3] ?? classMatch[4] ?? '') : '').toLowerCase().split(/\s+/).filter(Boolean),
  );
  const styleMatch = ATTR('style').exec(attrs);
  const own = styleMatch ? decodeAttr(styleMatch[2] ?? styleMatch[3] ?? styleMatch[4] ?? '') : '';
  const merged = new Map<string, string>();
  for (const r of rules) {
    if (r.tag && r.tag !== tag) continue;
    if (r.cls && !classes.has(r.cls)) continue;
    for (const [p, v] of r.decls) merged.set(p, v);
  }
  for (const [p, v] of parseDeclarations(own)) merged.set(p, v);
  return [...merged].map(([p, v]) => `${p}: ${v}`).join('; ');
}

function withStyle(tagHtml: string, style: string): string {
  const cleaned = tagHtml.replace(ATTR('style'), '');
  if (!style) return cleaned;
  const attr = ` style="${style.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  return cleaned.replace(/^<([a-z][\w-]*)/i, (_w, t: string) => `<${t}${attr}`);
}

/**
 * Write the `<style>` block's look onto the elements themselves. Outlook and
 * Word put a signature's font, size and colour in classes (`p.MsoNormal`), and
 * the server keeps only inline styles, so without this the formatting would go.
 */
function inlineStyles(doc: string, part: string): string {
  const rules = styleRules(doc);
  if (!rules.length) return part;
  return part.replace(/<([a-z][\w-]*)\b([^>]*)>/gi, (whole, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (t === 'br') return whole;
    return withStyle(whole, computedStyle(rules, t, attrs));
  });
}

/** The page's own styling (body rules + body style), carried by a wrapper since `<body>` itself is not kept. */
function bodyStyle(doc: string): string {
  const open = /<body\b([^>]*)>/i.exec(doc);
  const rules = styleRules(doc).filter((r) => (r.tag === 'body' || r.tag === 'html') && !r.cls);
  return computedStyle(rules, 'body', open?.[1] ?? '');
}

/** The part of a clipboard HTML document that was actually copied, with its look written inline. */
export function cleanPastedSignatureHtml(html: string): string {
  let s = html;
  const fragment = /<!--\s*StartFragment\s*-->([\s\S]*?)<!--\s*EndFragment\s*-->/i.exec(s);
  if (fragment) s = fragment[1];
  else {
    const body = /<body\b[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(s);
    if (body) s = body[1];
  }
  const cleaned = (
    s
      // Word's VML copy of a picture; the <img> fallback beside it is kept.
      .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
      .replace(/<!\[if[^\]]*\]>|<!\[endif\]>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(head|style|script|title|xml)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(meta|link|base)\b[^>]*>/gi, '')
      // Office namespaced tags (<o:p>, <w:...>): the tag goes, its text stays.
      .replace(/<\/?[a-z]+:[a-z][\w-]*\b[^>]*>/gi, '')
      .trim()
  );
  const styled = inlineStyles(html, cleaned);
  const outer = bodyStyle(html);
  return outer && styled
    ? `<div style="${outer.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${styled}</div>`
    : styled;
}

export type PastedImageNeed =
  /** Already a public https address; left as it is. */
  | 'keep'
  /** The picture is in the HTML; upload it. */
  | 'upload'
  /** A reference only the copying app understood; use the picture copied with it. */
  | 'from_clipboard';

export function pastedImageNeed(src: string): PastedImageNeed {
  const s = src.trim();
  if (/^https:\/\//i.test(s)) return 'keep';
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return 'upload';
  return 'from_clipboard';
}

const IMG = /<img\b[^>]*>/gi;
const SRC = /(\ssrc\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/i;

function decodeAttr(v: string): string {
  return v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Each picture's address, in the order they appear ('' for one with none). */
export function listImageSources(html: string): string[] {
  return (html.match(IMG) ?? []).map((tag) => {
    const m = SRC.exec(tag);
    return m ? decodeAttr(m[3] ?? m[4] ?? m[5] ?? '') : '';
  });
}

/**
 * Give every picture a new address, by its position. `null` removes the
 * picture: one that cannot reach a recipient is not left as a broken image.
 */
export function replaceImageSources(html: string, next: (src: string, index: number) => string | null): string {
  let i = 0;
  return html.replace(IMG, (tag) => {
    const m = SRC.exec(tag);
    const src = m ? decodeAttr(m[3] ?? m[4] ?? m[5] ?? '') : '';
    const out = next(src, i++);
    if (out === null) return '';
    const attr = `"${out.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
    return m
      ? tag.replace(SRC, (_whole, lead: string) => `${lead}${attr}`)
      : tag.replace(/^<img\b/i, () => `<img src=${attr}`);
  });
}

/** Plain text as signature HTML: escaped, line breaks kept. */
export function plainTextToSignatureHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br>');
}

/** Whether a clipboard string is HTML rather than text that mentions a tag. */
export function looksLikeHtml(s: string): boolean {
  return /<(html|body|div|p|span|table|img|a|b|strong|br|font)\b[^>]*>/i.test(s);
}
