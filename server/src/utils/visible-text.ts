/**
 * The words a person would SEE when an HTML email renders, and nothing else
 * (ADR 0268). Every AI pass that turns mail into to-dos, events and lists reads
 * through this, so a sender cannot hide an instruction from the reader and
 * show it to the model: a `display:none` span, a zero-size font, white text on
 * a white table, a class hidden by a `<style>` rule, a comment.
 *
 * Errs towards dropping: hidden text a person never saw is not a fact about
 * their mail, while a dropped button label costs nothing the rest of the email
 * does not repeat. Anything we cannot decide (a background we cannot resolve,
 * a selector too complex to match) counts as visible.
 */
import { parseDocument } from 'htmlparser2';

interface DomNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

/** Dropped with everything inside them. */
const NEVER_SHOWN = new Set([
  'head', 'title', 'script', 'style', 'template', 'noscript', 'iframe', 'object',
  'embed', 'meta', 'link', 'desc',
]);

const BLOCK = new Set([
  'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote',
  'ul', 'ol', 'section', 'article', 'header', 'footer', 'pre', 'hr',
]);
const CELL = new Set(['td', 'th']);

type Decls = Map<string, string>;

function parseDecls(css: string | undefined, into: Decls = new Map()): Decls {
  if (!css) return into;
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).replace(/!important/gi, '').trim().toLowerCase();
    if (prop && value) into.set(prop, value);
  }
  return into;
}

interface SimpleRule {
  tag: string | null;
  cls: string | null;
  id: string | null;
  decls: Decls;
}

/**
 * Rules from `<style>` blocks, simple selectors only (`tag`, `.cls`, `#id`,
 * `tag.cls`, comma lists). `@media` blocks are skipped: they apply to some
 * readers and not others, so they decide nothing for certain.
 */
function styleRules(doc: DomNode): SimpleRule[] {
  const rules: SimpleRule[] = [];
  const visit = (n: DomNode) => {
    if (n.name === 'style') {
      let css = (n.children ?? []).map((c) => c.data ?? '').join('');
      css = css.replace(/\/\*[\s\S]*?\*\//g, '');
      // Drop at-rule blocks, including one level of nested braces.
      css = css.replace(/@[^{};]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').replace(/@[^{};]+;/g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = parseDecls(m[2]);
        if (!decls.size) continue;
        for (const raw of m[1]!.split(',')) {
          const sel = raw.trim().toLowerCase();
          const s = /^([a-z][a-z0-9]*)?(?:\.([a-z0-9_-]+))?(?:#([a-z0-9_-]+))?$/.exec(sel);
          if (!s || (!s[1] && !s[2] && !s[3])) continue;
          rules.push({ tag: s[1] ?? null, cls: s[2] ?? null, id: s[3] ?? null, decls });
        }
      }
      return;
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(doc);
  return rules;
}

function elementDecls(el: DomNode, rules: SimpleRule[]): Decls {
  const decls: Decls = new Map();
  const tag = el.name ?? '';
  const classes = (el.attribs?.class ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const id = (el.attribs?.id ?? '').toLowerCase();
  for (const r of rules) {
    if (r.tag && r.tag !== tag) continue;
    if (r.cls && !classes.includes(r.cls)) continue;
    if (r.id && r.id !== id) continue;
    for (const [k, v] of r.decls) decls.set(k, v);
  }
  // Inline style beats a stylesheet rule.
  return parseDecls(el.attribs?.style, decls);
}

/** Size in px, or null when it cannot be read as one. */
function lengthPx(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?[\d.]+)\s*(px|pt|em|rem|%)?$/.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'pt': return n * 1.333;
    case 'em': case 'rem': return n * 16;
    case '%': return n * 0.16;
    default: return n;
  }
}

type Rgba = [number, number, number, number];

const NAMED: Record<string, Rgba> = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
  red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
  gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], silver: [192, 192, 192, 1],
  whitesmoke: [245, 245, 245, 1], snow: [255, 250, 250, 1], ivory: [255, 255, 240, 1],
};

function parseColor(raw: string | undefined): Rgba | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v]!;
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      const c = [...h].map((x) => parseInt(x + x, 16));
      return [c[0]!, c[1]!, c[2]!, h.length === 4 ? c[3]! / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const c = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
      return [c[0]!, c[1]!, c[2]!, h.length === 8 ? c[3]! / 255 : 1];
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return null;
}

/** The colour a `background` shorthand paints, or undefined when it paints an
 *  image or gradient we cannot see through. */
function backgroundOf(decls: Decls, attribs: Record<string, string> | undefined): Rgba | null | undefined {
  const bg = decls.get('background-color') ?? decls.get('background');
  if (decls.has('background-image') || (bg && /url\(|gradient/.test(bg))) return undefined;
  if (bg) {
    const direct = parseColor(bg);
    if (direct) return direct;
    for (const tok of bg.split(/\s+(?![^(]*\))/)) {
      const c = parseColor(tok);
      if (c) return c;
    }
    return undefined;
  }
  if (attribs?.background) return undefined;
  if (attribs?.bgcolor) return parseColor(attribs.bgcolor) ?? undefined;
  return null;
}

function sameColor(a: Rgba, b: Rgba): boolean {
  return Math.abs(a[0] - b[0]) <= 8 && Math.abs(a[1] - b[1]) <= 8 && Math.abs(a[2] - b[2]) <= 8;
}

interface Inherited {
  /** Font size in px, or null when not known. */
  fontPx: number | null;
  hiddenVisibility: boolean;
  color: Rgba | null;
  /** Nearest painted background; undefined = cannot tell. */
  background: Rgba | undefined;
}

/** Hiding that removes the element and everything in it, whatever a child says. */
function hidesSubtree(el: DomNode, d: Decls): boolean {
  if (el.attribs && 'hidden' in el.attribs) return true;
  if (d.get('display') === 'none') return true;
  if (d.get('mso-hide') === 'all') return true;
  const opacity = d.get('opacity');
  if (opacity !== undefined && parseFloat(opacity) < 0.1) return true;
  const overflowHidden = /hidden|clip/.test(d.get('overflow') ?? '');
  const zero = (p: string) => {
    const px = lengthPx(d.get(p));
    return px !== null && px <= 1;
  };
  if (overflowHidden && (zero('max-height') || zero('height') || zero('width') || zero('max-width'))) return true;
  const indent = lengthPx(d.get('text-indent'));
  if (indent !== null && indent <= -999) return true;
  if (/absolute|fixed/.test(d.get('position') ?? '')) {
    for (const p of ['left', 'top', 'right']) {
      const px = lengthPx(d.get(p));
      if (px !== null && px <= -999) return true;
    }
  }
  if (/^rect\(\s*0/.test(d.get('clip') ?? '')) return true;
  if (/inset\(\s*50%/.test(d.get('clip-path') ?? '')) return true;
  if (/scale\(\s*0(\.0+)?\s*[,)]/.test(d.get('transform') ?? '')) return true;
  return false;
}

function textIsHidden(s: Inherited): boolean {
  if (s.hiddenVisibility) return true;
  if (s.fontPx !== null && s.fontPx <= 1) return true;
  if (s.color) {
    if (s.color[3] < 0.1) return true;
    if (s.background && s.background[3] >= 0.9 && sameColor(s.color, s.background)) return true;
  }
  return false;
}

/**
 * Visible text of an HTML body, unnormalised (callers clean whitespace and
 * invisible characters). Block ends become line breaks so an itinerary keeps
 * its rows; table cells are separated by a space.
 */
export function visibleHtmlText(html: string): string {
  const doc = parseDocument(html, { decodeEntities: true }) as unknown as DomNode;
  const rules = styleRules(doc);
  const out: string[] = [];

  const walk = (node: DomNode, inh: Inherited) => {
    if (node.type === 'text') {
      if (!textIsHidden(inh)) out.push(node.data ?? '');
      return;
    }
    // Comments, CDATA and processing instructions are never shown.
    if (node.type === 'comment' || node.type === 'cdata' || node.type === 'directive') return;
    if (!node.name) {
      for (const c of node.children ?? []) walk(c, inh);
      return;
    }
    const tag = node.name.toLowerCase();
    if (NEVER_SHOWN.has(tag)) return;
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    const d = elementDecls(node, rules);
    if (hidesSubtree(node, d)) return;

    const next: Inherited = { ...inh };
    const vis = d.get('visibility');
    if (vis) next.hiddenVisibility = vis === 'hidden' || vis === 'collapse';
    const fs = d.get('font-size');
    if (fs !== undefined) {
      const v = fs.trim();
      const base = inh.fontPx ?? 16;
      if (/^[\d.]+%$/.test(v)) next.fontPx = (base * parseFloat(v)) / 100;
      else if (/^[\d.]+em$/.test(v)) next.fontPx = base * parseFloat(v);
      else next.fontPx = lengthPx(v);
    }
    const color = d.get('color') ?? (tag === 'font' ? node.attribs?.color : undefined);
    if (color !== undefined) next.color = parseColor(color);
    const bg = backgroundOf(d, node.attribs);
    if (bg !== null) next.background = bg;

    for (const c of node.children ?? []) walk(c, next);
    if (BLOCK.has(tag)) out.push('\n');
    else if (CELL.has(tag)) out.push(' ');
  };

  walk(doc, { fontPx: null, hiddenVisibility: false, color: null, background: [255, 255, 255, 1] });
  return out.join('');
}
