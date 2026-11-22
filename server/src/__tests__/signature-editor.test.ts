/**
 * The rendered signature editor (kernel/src/signature-editor.ts, ADR 0260
 * addendum 2026-11-13): what the page may say, and how a link is changed
 * without the person seeing HTML.
 */
import { describe, expect, it } from 'vitest';

import {
  parseSignatureEditorMessage,
  setSignatureLinkHref,
  signatureEditorDocument,
  signatureLinkHref,
  signatureLinkInput,
} from '@chord/kernel';

// The shape of the prod Neural signature: the email link that was wrong.
const NEURAL =
  '<a href="https://neuralads.ai/"><img src="https://x.test/logo.png"></a><br><b>John Doe</b><br>' +
  '<a href="mailto:tom@neuralads.ai">john@neuralads.ai</a> | <a href="https://neuralads.ai/">neuralads.ai</a>';

describe('signature links', () => {
  it('reads and changes the address of one link, leaving the others', () => {
    expect(signatureLinkHref(NEURAL, 1)).toBe('mailto:tom@neuralads.ai');
    const fixed = setSignatureLinkHref(NEURAL, 1, 'mailto:john@neuralads.ai');
    expect(signatureLinkHref(fixed, 1)).toBe('mailto:john@neuralads.ai');
    expect(signatureLinkHref(fixed, 0)).toBe('https://neuralads.ai/');
    expect(signatureLinkHref(fixed, 2)).toBe('https://neuralads.ai/');
    expect(fixed.replace('john@neuralads.ai"', 'tom@neuralads.ai"')).toBe(NEURAL);
  });

  it('removes a link and keeps its text', () => {
    const out = setSignatureLinkHref(NEURAL, 1, null);
    expect(out).toContain('<br>john@neuralads.ai | <a href="https://neuralads.ai/">');
    expect(out).not.toContain('tom@');
  });

  it('refuses an address that is not web, mail or phone, and an index with no link', () => {
    expect(setSignatureLinkHref(NEURAL, 1, 'javascript:alert(1)')).toBe(NEURAL);
    expect(setSignatureLinkHref(NEURAL, 9, 'https://ok.test')).toBe(NEURAL);
  });

  it('escapes an address so it cannot break out of the attribute', () => {
    const out = setSignatureLinkHref(NEURAL, 2, 'https://a.test/?q="><script>');
    expect(out).toContain('href="https://a.test/?q=&quot;&gt;&lt;script&gt;"');
  });
});

describe('signatureLinkInput', () => {
  it('turns what a person types into a link address', () => {
    expect(signatureLinkInput('john@neuralads.ai')).toBe('mailto:john@neuralads.ai');
    expect(signatureLinkInput(' neuralads.ai ')).toBe('https://neuralads.ai');
    expect(signatureLinkInput('www.chordapp.ai/x')).toBe('https://www.chordapp.ai/x');
    expect(signatureLinkInput('+1 (773) 555-0100')).toBe('tel:+17735550100');
    expect(signatureLinkInput('https://neuralads.ai/')).toBe('https://neuralads.ai/');
    expect(signatureLinkInput('javascript:alert(1)')).toBeNull();
    expect(signatureLinkInput('hello there')).toBeNull();
  });
});

describe('parseSignatureEditorMessage', () => {
  it('reads the three messages, from the web frame or as phone JSON text', () => {
    expect(parseSignatureEditorMessage({ chordSignature: 'html', html: '<b>x</b>' })).toEqual({ kind: 'html', html: '<b>x</b>' });
    expect(parseSignatureEditorMessage(JSON.stringify({ chordSignature: 'height', height: 81.2 }))).toEqual({ kind: 'height', height: 82 });
    expect(parseSignatureEditorMessage({ chordSignature: 'link', index: 1, href: 'mailto:a@b.c', text: 'a' })).toEqual({
      kind: 'link',
      index: 1,
      href: 'mailto:a@b.c',
      text: 'a',
    });
  });

  it('ignores anything else', () => {
    expect(parseSignatureEditorMessage('not json')).toBeNull();
    expect(parseSignatureEditorMessage({ chordEmail: 'height', height: 3 })).toBeNull();
    expect(parseSignatureEditorMessage({ chordSignature: 'link', index: -1 })).toBeNull();
    expect(parseSignatureEditorMessage({ chordSignature: 'html', html: 'x'.repeat(20_001) })).toBeNull();
  });
});

describe('signatureEditorDocument', () => {
  it('runs only its own nonce script and loads nothing but images', () => {
    const doc = signatureEditorDocument(NEURAL, { nonce: 'abcdefgh1234', apiOrigin: 'http://127.0.0.1:4000/api' });
    expect(doc).toContain("script-src 'nonce-abcdefgh1234'");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('img-src data: https: http://127.0.0.1:4000');
    expect(doc).toContain('contenteditable="true"');
  });
});
