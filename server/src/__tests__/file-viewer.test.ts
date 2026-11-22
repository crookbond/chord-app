import { describe, expect, it } from 'vitest';

import { bytesMatchFormat, fileFormat, fileViewerPlan, opensInFileViewer, viewerMimeType } from '@chord/kernel';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('fileFormat', () => {
  it('reads a named type', () => {
    expect(fileFormat(DOCX, 'letter')).toBe('docx');
    expect(fileFormat('Application/PDF; name="x"', 'x')).toBe('pdf');
    expect(fileFormat('video/quicktime', 'clip')).toBe('video');
  });

  it('reads the name under a generic type, including zip', () => {
    expect(fileFormat('application/octet-stream', 'Schedule.XLSX')).toBe('xlsx');
    expect(fileFormat('application/zip', 'letter.docx')).toBe('docx');
    expect(fileFormat('', 'notes.txt')).toBe('text');
    expect(fileFormat(undefined, 'deck.pptx')).toBe('pptx');
  });

  it('lets the name refine a named type of the same family', () => {
    expect(fileFormat('application/msword', 'letter.docx')).toBe('docx');
    expect(fileFormat('text/plain', 'roster.csv')).toBe('csv');
    // Windows labels every CSV as Excel.
    expect(fileFormat('application/vnd.ms-excel', 'scores.csv')).toBe('csv');
    expect(fileFormat('application/vnd.ms-excel', 'scores.xls')).toBe('xls');
  });

  it('never lets the name override a named type of another kind', () => {
    expect(fileFormat('text/html', 'trick.docx')).toBeNull();
    expect(fileFormat('image/svg+xml', 'logo.png')).toBeNull();
    expect(fileFormat('image/png', 'photo.pdf')).toBe('image');
    expect(fileFormat('application/octet-stream', 'page.html')).toBeNull();
  });
});

describe('fileViewerPlan', () => {
  it('iPhone draws Office and iWork files natively and text in its own page', () => {
    for (const name of ['a.docx', 'a.doc', 'a.xlsx', 'a.xls', 'a.pptx', 'a.ppt', 'a.pages', 'a.numbers', 'a.key', 'a.rtf', 'a.mp4', 'a.heic']) {
      expect(fileViewerPlan('', name, 'ios')?.renderer).toBe('native');
    }
    expect(fileViewerPlan('', 'a.txt', 'ios')?.renderer).toBe('text');
    expect(fileViewerPlan('', 'a.csv', 'ios')?.renderer).toBe('sheet');
  });

  it('Android draws Word, spreadsheets, text and images itself and leaves the rest', () => {
    expect(fileViewerPlan('', 'a.pdf', 'android')?.renderer).toBe('pdfjs');
    expect(fileViewerPlan(DOCX, 'a', 'android')?.renderer).toBe('docx');
    expect(fileViewerPlan(XLSX, 'a', 'android')?.renderer).toBe('sheet');
    expect(fileViewerPlan('', 'a.xls', 'android')?.renderer).toBe('sheet');
    expect(fileViewerPlan('image/jpeg', 'a', 'android')?.renderer).toBe('image');
    for (const name of ['a.pptx', 'a.doc', 'a.rtf', 'a.pages', 'a.heic', 'a.mp4']) {
      expect(opensInFileViewer('', name, 'android')).toBe(false);
    }
  });

  it('web shows PDFs and media in the browser and renders Office files itself', () => {
    expect(fileViewerPlan('', 'a.pdf', 'web')?.renderer).toBe('native');
    expect(fileViewerPlan('', 'a.docx', 'web')?.renderer).toBe('docx');
    expect(fileViewerPlan('', 'a.mp3', 'web')?.renderer).toBe('native');
    expect(opensInFileViewer('', 'a.pptx', 'web')).toBe(false);
  });

  it('never shows HTML or SVG anywhere', () => {
    for (const p of ['ios', 'android', 'web']) {
      expect(opensInFileViewer('text/html', 'page.html', p)).toBe(false);
      expect(opensInFileViewer('image/svg+xml', 'logo.svg', p)).toBe(false);
    }
  });
});

describe('bytesMatchFormat', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const bytes = (...b: number[]) => new Uint8Array(b);

  it('accepts the real signatures', () => {
    expect(bytesMatchFormat('docx', bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe(true);
    expect(bytesMatchFormat('xls', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0))).toBe(true);
    expect(bytesMatchFormat('image', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(bytesMatchFormat('image', bytes(0x89, 0x50, 0x4e, 0x47))).toBe(true);
    expect(bytesMatchFormat('rtf', enc('{\\rtf1\\ansi'))).toBe(true);
    expect(bytesMatchFormat('pdf', enc('%PDF-1.7'))).toBe(true);
    expect(bytesMatchFormat('text', enc('Pickup at 3'))).toBe(true);
  });

  it('refuses a page dressed up as another format', () => {
    const page = enc('<html><script>alert(1)</script></html>');
    expect(bytesMatchFormat('docx', page)).toBe(false);
    expect(bytesMatchFormat('xls', page)).toBe(false);
    expect(bytesMatchFormat('image', page)).toBe(false);
    expect(bytesMatchFormat('rtf', page)).toBe(false);
    expect(bytesMatchFormat('text', bytes(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe(false);
    expect(bytesMatchFormat('docx', new Uint8Array())).toBe(false);
  });
});

describe('viewerMimeType', () => {
  it('relabels only to types a browser shows without running anything', () => {
    expect(viewerMimeType('pdf')).toBe('application/pdf');
    expect(viewerMimeType('image', 'x.png')).toBe('image/png');
    expect(viewerMimeType('video', 'clip.mov')).toBe('video/quicktime');
    expect(viewerMimeType('docx')).toBeNull();
    expect(viewerMimeType('text')).toBeNull();
  });
});
