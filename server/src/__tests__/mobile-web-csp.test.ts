import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RENDER_LIBS } from '@chord/kernel';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../mobile');

function policy(): Map<string, string[]> {
  const html = fs.readFileSync(path.join(MOBILE, 'public/index.html'), 'utf8');
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  expect(m, 'mobile/public/index.html has a Content-Security-Policy meta').toBeTruthy();
  const out = new Map<string, string[]>();
  for (const d of m![1].split(';')) {
    const [name, ...values] = d.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe('web app content security policy', () => {
  // The web app had no policy: sanitized email HTML is rendered in the main
  // document, where a script from anywhere could run.
  it('loads scripts only from this origin and the pinned viewer libraries', () => {
    const scripts = policy().get('script-src') ?? [];
    expect(scripts).not.toContain('*');
    expect(scripts).not.toContain('https:');
    for (const s of scripts) {
      if (s.startsWith("'") || s === 'blob:') continue;
      expect(Object.values(RENDER_LIBS).map((l) => l.src)).toContain(s);
    }
  });

  // The viewer's srcdoc page inherits this policy: a library missing here
  // would silently stop Word/Excel/PDF files drawing on the web.
  it('allows every viewer library the inherited srcdoc page loads', () => {
    const p = policy();
    const scripts = p.get('script-src') ?? [];
    for (const lib of [RENDER_LIBS.pdfjs, RENDER_LIBS.jszip, RENDER_LIBS.docx, RENDER_LIBS.sheet]) {
      expect(scripts).toContain(lib.src);
    }
    expect(p.get('worker-src')).toContain('blob:');
  });

  // Prod 2026-11-02: every email attachment on the web said "This file is no
  // longer open". The viewer (`app/file-viewer.tsx`) reads the file it was
  // handed with fetch(blob:...), and connect-src had no blob:, so the browser
  // refused the read of a file the page had just made itself.
  it('lets the file viewer read the blob it was handed', () => {
    expect(policy().get('connect-src')).toContain('blob:');
  });

  it('blocks plugins, base and form hijacks from elsewhere', () => {
    const p = policy();
    expect(p.get('object-src')).not.toContain('*');
    expect(p.get('object-src')).not.toContain('https:');
    expect(p.get('base-uri')).toEqual(["'self'"]);
    expect(p.get('form-action')).toEqual(["'self'"]);
    expect(p.get('frame-src')).toEqual(["'self'", 'blob:']);
  });
});
