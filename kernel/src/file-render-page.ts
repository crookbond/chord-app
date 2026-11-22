/**
 * The pages Chord draws a file in when the platform cannot (ADR 0310):
 * a PDF on Android (pdf.js), Word (docx-preview), spreadsheets and CSV
 * (SheetJS), text, and images. The file's bytes are written into the page,
 * so nothing is fetched but the pinned library itself, checked against its
 * hash, and the page may load nothing else (its content security policy).
 *
 * The policy names each library by its exact address and runs Chord's own
 * inline script by a nonce the caller makes per page, so no other script
 * can run - not one a document smuggles in, not another file on the same
 * CDN. A link in the document never navigates the page: a click is handed
 * to the app (`open:<url>`), which opens http(s) in the browser.
 *
 * Every page posts `loaded` when the first thing is on screen and
 * `error:<why>` when it cannot draw the file. On a phone that arrives through
 * the web view's bridge; on web, through `postMessage` from a sandboxed iframe.
 */
import type { FileRenderer } from './file-viewer';

/** pdf.js 4.2.67 fixed CVE-2024-4367 (script run from a crafted font). */
export const PDFJS_VERSION = '4.10.38';
const PDFJS = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

export const RENDER_LIBS = {
  pdfjs: {
    src: `${PDFJS}/pdf.min.mjs`,
    integrity: 'sha384-+0ti2moQlmLN7WZHE2RHIf5lV8hHxhxEalN0il3YZceG26fUPyOkR0hp9daxk1i7',
  },
  pdfjsWorker: {
    src: `${PDFJS}/pdf.worker.min.mjs`,
    integrity: 'sha384-ToeVvShCxKc6CEvhHeMt0Q8A06pSPDbAlngO9nokrDmh914gk/pYd0N7D0a4Lz2o',
  },
  jszip: {
    src: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
  },
  docx: {
    src: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.5/dist/docx-preview.min.js',
    integrity: 'sha384-XETEC39BEI+1nILZ5N2gFQcu6ii4k3avoqyi4YwQMbs29xkt01EKMqd9rFvic0Wu',
  },
  // SheetJS's own CDN: the copies on npm/cdnjs stop at 0.18.5, which has
  // known security fixes missing.
  sheet: {
    src: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    integrity: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT',
  },
} as const;

type Lib = { src: string; integrity: string };

/** Rows and columns a sheet shows; a bigger one says how much was left out. */
const SHEET_MAX_ROWS = 2000;
const SHEET_MAX_COLS = 60;

/** A nonce is base64/base64url; anything else would break out of the policy. */
const NONCE_SHAPE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

function script(lib: Lib, nonce: string, module = false): string {
  return `<script${module ? ' type="module"' : ''} nonce="${nonce}" src="${lib.src}" integrity="${lib.integrity}" crossorigin="anonymous"></script>`;
}

/** The page's policy: only these libraries, only scripts carrying the nonce. */
export function renderPagePolicy(nonce: string, libs: Lib[], opts: { pdf?: boolean } = {}): string {
  const scripts = [`'nonce-${nonce}'`, ...libs.map((l) => l.src)];
  // pdf.js runs its worker from a blob the page makes of the fetched,
  // hash-checked worker file (or, if a worker cannot start, imports it).
  if (opts.pdf) scripts.push('blob:');
  return [
    "default-src 'none'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src data: blob:',
    opts.pdf ? `connect-src ${RENDER_LIBS.pdfjsWorker.src}` : "connect-src 'none'",
    opts.pdf ? 'worker-src blob:' : "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ');
}

function shell(opts: {
  nonce: string;
  libs: Lib[];
  pdf?: boolean;
  head?: string;
  style: string;
  body: string;
  dark?: boolean;
}): string {
  const csp = renderPagePolicy(opts.nonce, opts.libs, { pdf: opts.pdf });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
<style>
  html, body { margin: 0; }
  #msg:empty { display: none; }
  #msg { font: 15px -apple-system, Roboto, sans-serif; padding: 16px; color: ${opts.dark ? '#fff' : '#b00020'}; }
  ${opts.style}
</style>${opts.head ?? ''}</head>
<body><div id="msg"></div>${opts.body}</body></html>`;
}

/** The bridge both platforms share; also decodes the embedded file, and
 *  hands a link click to the app instead of navigating. */
const PRELUDE = `
const post = (m) => {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(m);
  else if (window.parent !== window) window.parent.postMessage({ chordViewer: m }, '*');
};
const fail = (e) => post('error:' + (e && e.message ? e.message : String(e || 'unknown')));
const fileBytes = () => {
  const raw = atob(document.getElementById('file').textContent);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};
window.addEventListener('error', (e) => fail(e.error || e.message));
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.charAt(0) === '#') return;
  e.preventDefault();
  if (/^https?:/i.test(a.href)) post('open:' + a.href);
}, true);
`;

function inline(nonce: string, code: string, module = false): string {
  return `<script${module ? ' type="module"' : ''} nonce="${nonce}">${PRELUDE}${code}</script>`;
}

function fileTag(base64: string): string {
  // Base64 has no characters that could end the element early, and a
  // non-script type is never run.
  return `<script id="file" type="application/octet-stream">${base64}</script>`;
}

function pdfPage(base64: string, nonce: string): string {
  const { pdfjs, pdfjsWorker } = RENDER_LIBS;
  return shell({
    nonce,
    libs: [pdfjs],
    pdf: true,
    dark: true,
    // pdf.js 4 needs Promise.withResolvers, which older Android web views lack.
    head:
      `<script nonce="${nonce}">if (!Promise.withResolvers) Promise.withResolvers = function () { let a, b; const p = new Promise((r, j) => { a = r; b = j; }); return { promise: p, resolve: a, reject: b }; };</script>` +
      script(pdfjs, nonce, true),
    style: `html, body { background: #525659; }
  canvas { display: block; width: 100%; height: auto; margin: 0 0 8px; background: #fff; }`,
    // Module scripts run in order, so pdf.js (above) has set pdfjsLib.
    body: `${fileTag(base64)}${inline(
      nonce,
      `
(async () => {
  try {
    const pdfjsLib = globalThis.pdfjsLib;
    const res = await fetch('${pdfjsWorker.src}', { integrity: '${pdfjsWorker.integrity}', mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('The PDF reader could not load.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'text/javascript' }));
    const doc = await pdfjsLib.getDocument({ data: fileBytes(), isEvalSupported: false, enableXfa: false }).promise;
    const ratio = window.devicePixelRatio || 1;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (window.innerWidth / base.width) * ratio });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      document.body.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (n === 1) post('loaded');
    }
  } catch (e) { fail(e); }
})();
`,
      true,
    )}`,
  });
}

function docxPage(base64: string, nonce: string): string {
  const { jszip, docx } = RENDER_LIBS;
  return shell({
    nonce,
    libs: [jszip, docx],
    head: script(jszip, nonce) + script(docx, nonce),
    style: `html, body { background: #f1f1f1; }
  #doc .docx-wrapper { padding: 12px; background: #f1f1f1; }
  #doc .docx-wrapper > section.docx { margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
  @media (max-width: 800px) {
    #doc .docx-wrapper { padding: 0; }
    #doc .docx-wrapper > section.docx { padding: 20px 16px !important; width: auto !important; min-height: 0 !important; }
  }`,
    body: `<div id="doc"></div>${fileTag(base64)}${inline(
      nonce,
      `
(async () => {
  try {
    const narrow = window.innerWidth < 800;
    await docx.renderAsync(fileBytes(), document.getElementById('doc'), null, {
      inWrapper: true, ignoreWidth: narrow, ignoreHeight: narrow, breakPages: !narrow,
      useBase64URL: true, renderChanges: false, experimental: false,
    });
    post('loaded');
  } catch (e) { fail(e); }
})();
`,
    )}`,
  });
}

function sheetPage(base64: string, nonce: string): string {
  const { sheet } = RENDER_LIBS;
  return shell({
    nonce,
    libs: [sheet],
    head: script(sheet, nonce),
    style: `html, body { background: #fff; font: 13px -apple-system, Roboto, sans-serif; color: #202124; }
  #tabs { position: sticky; top: 0; display: flex; gap: 6px; overflow-x: auto; padding: 8px; background: #f1f3f4; border-bottom: 1px solid #dadce0; }
  #tabs button { flex: none; border: 1px solid #dadce0; background: #fff; border-radius: 14px; padding: 4px 12px; font: inherit; }
  #tabs button.on { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  #wrap { overflow: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #e0e0e0; padding: 4px 8px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; text-align: left; vertical-align: top; }
  th { background: #f8f9fa; color: #5f6368; font-weight: 500; position: sticky; left: 0; }
  #note { padding: 8px; color: #5f6368; }`,
    body: `<div id="tabs"></div><div id="wrap"></div><div id="note"></div>${fileTag(base64)}${inline(
      nonce,
      `
(() => {
  try {
    const book = XLSX.read(fileBytes(), { type: 'array', cellDates: true, dense: true });
    const tabs = document.getElementById('tabs');
    const wrap = document.getElementById('wrap');
    const note = document.getElementById('note');
    const show = (name) => {
      for (const b of tabs.children) b.classList.toggle('on', b.dataset.name === name);
      const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
      const table = document.createElement('table');
      const cols = Math.min(${SHEET_MAX_COLS}, rows.reduce((m, r) => Math.max(m, r.length), 0));
      rows.slice(0, ${SHEET_MAX_ROWS}).forEach((r, i) => {
        const tr = table.insertRow();
        const th = document.createElement('th');
        th.textContent = String(i + 1);
        tr.appendChild(th);
        for (let c = 0; c < cols; c++) tr.insertCell().textContent = r[c] == null ? '' : String(r[c]);
      });
      wrap.replaceChildren(table);
      const cut = [];
      if (rows.length > ${SHEET_MAX_ROWS}) cut.push('the first ${SHEET_MAX_ROWS} of ' + rows.length + ' rows');
      if (rows.some((r) => r.length > ${SHEET_MAX_COLS})) cut.push('the first ${SHEET_MAX_COLS} columns');
      note.textContent = rows.length ? (cut.length ? 'Showing ' + cut.join(' and ') + '.' : '') : 'This sheet is empty.';
    };
    for (const name of book.SheetNames) {
      const b = document.createElement('button');
      b.textContent = name;
      b.dataset.name = name;
      b.onclick = () => show(name);
      tabs.appendChild(b);
    }
    if (book.SheetNames.length < 2) tabs.style.display = 'none';
    if (!book.SheetNames.length) throw new Error('This file has no sheets.');
    show(book.SheetNames[0]);
    post('loaded');
  } catch (e) { fail(e); }
})();
`,
    )}`,
  });
}

function textPage(base64: string, nonce: string): string {
  return shell({
    nonce,
    libs: [],
    style: `html, body { background: #fff; color: #202124; }
  pre { margin: 0; padding: 12px 16px; font: 13px/1.45 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }`,
    body: `<pre id="text"></pre>${fileTag(base64)}${inline(
      nonce,
      `
(() => {
  try {
    const bytes = fileBytes();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('windows-1252').decode(bytes); }
    document.getElementById('text').textContent = text.replace(/^\\uFEFF/, '');
    post('loaded');
  } catch (e) { fail(e); }
})();
`,
    )}`,
  });
}

/** Only a plain image type may be written into the page's data: URL. */
const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/i;

function imagePage(base64: string, mimeType: string, nonce: string): string {
  const type = IMAGE_TYPE.test(mimeType) ? mimeType : 'application/octet-stream';
  return shell({
    nonce,
    libs: [],
    dark: true,
    style: `html, body { background: #000; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; }
  img { max-width: 100%; max-height: 100vh; object-fit: contain; }`,
    body: `<img id="img" alt="">${inline(
      nonce,
      `
const img = document.getElementById('img');
img.onload = () => post('loaded');
img.onerror = () => fail('This image could not be shown.');
img.src = 'data:${type};base64,${base64}';
`,
    )}`,
  });
}

/** The page for a renderer Chord draws itself; null for `native`. `nonce`
 *  must be fresh random base64 for every page. */
export function fileRenderPage(renderer: FileRenderer, base64: string, mimeType: string, nonce: string): string | null {
  if (!NONCE_SHAPE.test(nonce)) throw new Error('fileRenderPage: a random base64 nonce is required');
  switch (renderer) {
    case 'pdfjs':
      return pdfPage(base64, nonce);
    case 'docx':
      return docxPage(base64, nonce);
    case 'sheet':
      return sheetPage(base64, nonce);
    case 'text':
      return textPage(base64, nonce);
    case 'image':
      return imagePage(base64, mimeType, nonce);
    case 'native':
      return null;
  }
}

/** Above this the file is not written into a page; Share / Download instead. */
export const RENDER_PAGE_MAX_BYTES = 15 * 1024 * 1024;

export type ViewerNavigation = 'allow' | 'external' | 'block';

/**
 * What a viewer web view does with a load it did not start itself. Only the
 * page or file it was given (and the blank page around it) loads; an
 * http(s) link opens in the browser; anything else (another local file,
 * javascript:, intent:, a custom scheme) is refused.
 */
export function viewerNavigation(url: string, own: string[]): ViewerNavigation {
  if (!url || url === 'about:blank' || url.startsWith('about:srcdoc')) return 'allow';
  const base = (u: string) => u.split('#')[0];
  if (own.some((o) => o && base(o) === base(url))) return 'allow';
  if (/^data:|^blob:/i.test(url)) return 'block';
  if (/^https?:\/\//i.test(url)) return 'external';
  return 'block';
}
