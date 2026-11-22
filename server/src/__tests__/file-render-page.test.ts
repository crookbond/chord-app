import { describe, expect, it } from 'vitest';

import { PDFJS_VERSION, RENDER_LIBS, fileRenderPage, renderPagePolicy, viewerNavigation } from '@chord/kernel';

const NONCE = 'AbCdEfGhIjKlMnOpQrStUvWx';
const B64 = 'JVBERi0xLjQK';

function policyOf(html: string): string {
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  return m ? m[1] : '';
}

function scriptSrc(csp: string): string[] {
  const d = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) ?? '';
  return d.split(/\s+/).slice(1);
}

function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

describe('pdf page (CVE-2024-4367)', () => {
  const html = fileRenderPage('pdfjs', B64, 'application/pdf', NONCE)!;

  it('uses a pdf.js with the font fix, eval off, hash-checked', () => {
    expect(versionAtLeast(PDFJS_VERSION, '4.2.67')).toBe(true);
    expect(html).not.toContain('3.11.174');
    expect(html).toContain('isEvalSupported: false');
    expect(html).toContain(`src="${RENDER_LIBS.pdfjs.src}" integrity="${RENDER_LIBS.pdfjs.integrity}"`);
    expect(html).toContain(`integrity: '${RENDER_LIBS.pdfjsWorker.integrity}'`);
  });

  it('has a content security policy', () => {
    const csp = policyOf(html);
    expect(csp).toContain("default-src 'none'");
    expect(scriptSrc(csp)).toEqual([`'nonce-${NONCE}'`, RENDER_LIBS.pdfjs.src, 'blob:']);
    expect(csp).toContain(`connect-src ${RENDER_LIBS.pdfjsWorker.src}`);
  });
});

describe('every render page', () => {
  const pages = (['pdfjs', 'docx', 'sheet', 'text', 'image'] as const).map((r) => [
    r,
    fileRenderPage(r, B64, 'image/png', NONCE)!,
  ]);

  it.each(pages)('%s runs only nonce-carrying scripts and pinned libraries', (_r, html) => {
    const csp = policyOf(html);
    const src = scriptSrc(csp);
    expect(src).not.toContain("'unsafe-inline'");
    expect(src).not.toContain("'unsafe-eval'");
    // No whole-host source: each library by its exact address.
    for (const s of src) {
      if (s.startsWith("'") || s === 'blob:') continue;
      expect(Object.values(RENDER_LIBS).map((l) => l.src)).toContain(s);
    }
    // Every executable script carries the nonce, every external one a hash.
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      if (tag.includes('type="application/octet-stream"')) continue;
      expect(tag).toContain(`nonce="${NONCE}"`);
      if (tag.includes(' src=')) expect(tag).toMatch(/integrity="sha384-/);
    }
  });

  it('refuses a missing or unsafe nonce', () => {
    expect(() => fileRenderPage('text', B64, '', '')).toThrow();
    expect(() => fileRenderPage('text', B64, '', `${NONCE}' 'unsafe-inline`)).toThrow();
  });

  it('keeps a non-image type out of the image data: URL', () => {
    const html = fileRenderPage('image', B64, "image/png';alert(1);'", NONCE)!;
    expect(html).not.toContain('alert(1)');
  });
});

describe('renderPagePolicy', () => {
  it('blocks network and workers outside a PDF', () => {
    const csp = renderPagePolicy(NONCE, [RENDER_LIBS.sheet]);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe('viewerNavigation', () => {
  const page = 'https://localhost/';
  const file = 'file:///var/mobile/cache/email-m1-a.docx';

  it('lets the page or file load and nothing else in place', () => {
    expect(viewerNavigation(page, [page])).toBe('allow');
    expect(viewerNavigation(`${file}#page=2`, [file])).toBe('allow');
    expect(viewerNavigation('about:blank', [page])).toBe('allow');
  });

  // A link in a .docx used to navigate the viewer to any site.
  it('sends web links outside and refuses everything else', () => {
    expect(viewerNavigation('https://evil.example/phish', [page])).toBe('external');
    expect(viewerNavigation('http://evil.example/', [file])).toBe('external');
    expect(viewerNavigation('file:///data/user/0/ai.chord/files/secret', [file])).toBe('block');
    expect(viewerNavigation('javascript:alert(1)', [page])).toBe('block');
    expect(viewerNavigation('intent://x#Intent;end', [page])).toBe('block');
    expect(viewerNavigation('data:text/html,<script>1</script>', [page])).toBe('block');
  });
});
