import { describe, expect, it } from 'vitest';

import { looksLikePdf, opensInPdfViewer } from '@chord/kernel';

describe('opensInPdfViewer', () => {
  it('opens a file typed as PDF whatever its name', () => {
    expect(opensInPdfViewer('application/pdf', 'scan')).toBe(true);
    expect(opensInPdfViewer('Application/PDF; name="x"', 'x')).toBe(true);
  });

  it('opens a .pdf the sender labelled as generic bytes', () => {
    expect(opensInPdfViewer('application/octet-stream', 'Invoice.PDF')).toBe(true);
    expect(opensInPdfViewer('', 'menu.pdf')).toBe(true);
    expect(opensInPdfViewer(undefined, 'menu.pdf')).toBe(true);
  });

  it('never opens a named non-PDF type, even with a .pdf name', () => {
    expect(opensInPdfViewer('text/html', 'trick.pdf')).toBe(false);
    expect(opensInPdfViewer('image/png', 'photo.pdf')).toBe(false);
  });

  it('leaves other files alone', () => {
    expect(opensInPdfViewer('application/octet-stream', 'notes.docx')).toBe(false);
    expect(opensInPdfViewer('', 'pdf')).toBe(false);
  });
});

describe('looksLikePdf', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('accepts a PDF header at the start or within the first 1024 bytes', () => {
    expect(looksLikePdf(enc('%PDF-1.7\n...'))).toBe(true);
    expect(looksLikePdf(enc(' '.repeat(500) + '%PDF-1.4'))).toBe(true);
  });
  it('rejects anything else', () => {
    expect(looksLikePdf(enc('<html><script>alert(1)</script>'))).toBe(false);
    expect(looksLikePdf(enc(' '.repeat(1100) + '%PDF-1.4'))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });
});
