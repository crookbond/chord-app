/**
 * ADR 0260 - the signature on outgoing mail.
 *
 * A signature is HTML a person pasted from somewhere, and it goes out under their
 * name, so the cleaner is tested against what it is there to stop; and every send
 * path must ask one function for its bodies, so a test fails if one builds its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  outgoingBodies,
  sanitizeSignatureHtml,
  signaturePatch,
  signatureTextFromHtml,
} from '@/services/email/signature.js';

describe('sanitizeSignatureHtml - keeps what makes a signature', () => {
  it('keeps links, emphasis and line breaks, and marks links noopener', () => {
    const out = sanitizeSignatureHtml(
      '<b>John Doe</b><br><a href="https://chordapp.ai" title="Chord">chordapp.ai</a>',
    );
    expect(out).toContain('<b>John Doe</b>');
    expect(out).toContain('<br />');
    expect(out).toContain('href="https://chordapp.ai"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('keeps a plain https logo, a colour and a simple table', () => {
    const out = sanitizeSignatureHtml(
      '<table><tr><td style="color:#1a1a18;font-size:12px"><img src="https://chordapp.ai/logo.png" width="40" alt="Chord"></td>' +
        '<td><span style="font-weight:bold">John</span></td></tr></table>',
    );
    expect(out).toContain('<img src="https://chordapp.ai/logo.png"');
    expect(out).toContain('color:#1a1a18');
    expect(out).toContain('<table>');
    expect(out).toContain('font-weight:bold');
  });
});

describe('sanitizeSignatureHtml - removes what must never go out', () => {
  const hostile: Array<[string, string, RegExp]> = [
    ['a script', 'Hi<script>alert(1)</script>', /script|alert/i],
    ['an event handler', '<img src="https://x.test/a.png" onerror="alert(1)">', /onerror|alert/i],
    ['a javascript: link', '<a href="javascript:alert(1)">click</a>', /javascript/i],
    ['a data: image', '<img src="data:image/png;base64,AAAA">', /data:/i],
    ['an http image (mixed content)', '<img src="http://x.test/a.png">', /<img/i],
    ['a protocol-relative image', '<img src="//x.test/a.png">', /<img/i],
    ['a cid: image (nothing is attached)', '<img src="cid:logo">', /<img/i],
    ['an iframe', '<iframe src="https://x.test"></iframe>text', /iframe/i],
    ['a form', '<form action="https://x.test"><input name=a></form>text', /form|input/i],
    ['an object/embed', '<object data="https://x.test/a.swf"></object><embed src="https://x.test/a.swf">', /object|embed/i],
    ['a stylesheet link', '<link rel="stylesheet" href="https://x.test/a.css">text', /link|stylesheet/i],
    ['a style block', '<style>body{background:url(https://x.test/track.gif)}</style>text', /style|track/i],
    ['a base tag', '<base href="https://evil.test/">text', /<base/i],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">text', /meta|refresh/i],
    ['an svg', '<svg onload="alert(1)"><circle/></svg>text', /svg|onload/i],
  ];
  for (const [name, input, banned] of hostile) {
    it(`drops ${name}`, () => {
      const out = sanitizeSignatureHtml(input);
      expect(out).not.toMatch(banned);
    });
  }

  it('drops a style that fetches a resource or runs, but keeps its harmless neighbours', () => {
    const out = sanitizeSignatureHtml(
      '<div style="color:red;background-image:url(https://x.test/t.gif);width:expression(alert(1));position:fixed">Hi</div>',
    );
    expect(out).toContain('color:red');
    expect(out).not.toMatch(/url\(|expression|position|background-image/i);
  });

  it('does not let a border smuggle a url()', () => {
    const out = sanitizeSignatureHtml('<td style="border:1px solid url(https://x.test/t.gif)">x</td>');
    expect(out).not.toMatch(/url\(/i);
  });

  it('returns nothing when nothing survives', () => {
    expect(sanitizeSignatureHtml('<script>alert(1)</script>')).toBe('');
    expect(sanitizeSignatureHtml('   ')).toBe('');
    expect(sanitizeSignatureHtml('<div></div>')).toBe('');
  });
});

describe('signatureTextFromHtml', () => {
  it('keeps each link address, so the text half is not a signature with no way to reach you', () => {
    const text = signatureTextFromHtml(
      sanitizeSignatureHtml('<b>John Doe</b><br><a href="https://chordapp.ai/me?a=1&b=2">My site</a>'),
    );
    expect(text).toContain('John Doe');
    expect(text).toContain('My site (https://chordapp.ai/me?a=1&b=2)');
  });

  it('does not say a link twice when its text is its address', () => {
    const text = signatureTextFromHtml(
      sanitizeSignatureHtml('<a href="https://chordapp.ai">https://chordapp.ai</a>'),
    );
    expect(text).toBe('https://chordapp.ai');
  });

  it('writes a mailto address without its scheme', () => {
    const text = signatureTextFromHtml(sanitizeSignatureHtml('<a href="mailto:me@x.com">Email me</a>'));
    expect(text).toBe('Email me (me@x.com)');
  });
});

describe('outgoingBodies - what is in the box is what goes (ADR 0260 addendum)', () => {
  const ROW = { email_signature: 'John\nSent from Chord' };

  it('a body the user deleted the signature from goes out with none', () => {
    // The reported shape: the signature used to be appended at send whatever
    // the box showed, so deleting it there changed nothing.
    expect(outgoingBodies('Count us in.', ROW)).toEqual({
      text: 'Count us in.',
      html: '<div>Count us in.</div>',
    });
  });

  it('a body holding the plain signature goes out exactly as written', () => {
    const body = 'Count us in.\n\n-- \nJohn\nSent from Chord';
    const { text, html } = outgoingBodies(body, ROW);
    expect(text).toBe(body);
    expect(html).toBe('<div>Count us in.<br><br>-- <br>John<br>Sent from Chord</div>');
  });

  it('a markdown link in the signature becomes a link in the HTML half', () => {
    const { html } = outgoingBodies('Hi\n\n-- \n[chordapp.ai](https://chordapp.ai)', {
      email_signature: '[chordapp.ai](https://chordapp.ai)',
    });
    expect(html).toContain('<a href="https://chordapp.ai">chordapp.ai</a>');
  });

  it('an unchanged signature shows as the rich one in the HTML half; the text stays as written', () => {
    const rich = sanitizeSignatureHtml('<b>John</b><br><a href="https://chordapp.ai">chordapp.ai</a>');
    const plain = signatureTextFromHtml(rich);
    const body = `Hello\n\n-- \n${plain}`;
    const { text, html } = outgoingBodies(body, { email_signature: plain, email_signature_html: rich });
    expect(text).toBe(body);
    expect(html).toContain('<div>Hello</div>');
    expect(html).toContain('<div>-- </div>');
    expect(html).toContain(rich);
  });

  it('a signature the user edited goes out as they wrote it, not as the rich one', () => {
    const rich = sanitizeSignatureHtml('<b>John</b>');
    const { html } = outgoingBodies('Hello\n\n-- \nRo (on the road)', {
      email_signature: 'John',
      email_signature_html: rich,
    });
    expect(html).not.toContain('<b>John</b>');
    expect(html).toContain('Ro (on the road)');
  });

  it('a forward note keeps the rich signature above the forwarded message', () => {
    const rich = sanitizeSignatureHtml('<b>John</b>');
    const body = 'FYI\n\n-- \nJohn\n\n---------- Forwarded message ----------\nFrom: Ms. Chen';
    const { html } = outgoingBodies(body, { email_signature: 'John', email_signature_html: rich });
    expect(html.indexOf('<b>John</b>')).toBeLessThan(html.indexOf('Forwarded message'));
    expect(html).toContain('From: Ms. Chen');
  });

  it("a user's formatting in the body is still rendered when there is a rich signature", () => {
    const rich = sanitizeSignatureHtml('<b>John</b>');
    const { html } = outgoingBodies('Bring **snacks**\n\n-- \nJohn', {
      email_signature: 'John',
      email_signature_html: rich,
    });
    expect(html).toContain('<strong>snacks</strong>');
  });
});

describe('signaturePatch - what a write means', () => {
  it('rich HTML is cleaned, stored, and the plain text is derived from it', () => {
    const patch = signaturePatch({ html: '<b>John</b><script>alert(1)</script>' });
    expect(patch.email_signature_html).toBe('<b>John</b>');
    expect(patch.email_signature).toBe('John');
  });

  it('plain text alone replaces a rich signature instead of leaving the old HTML to go out beside it', () => {
    expect(signaturePatch({ text: 'Ro' })).toEqual({ email_signature: 'Ro', email_signature_html: null });
  });

  it('empty clears both; HTML that cleans to nothing falls back to the plain text given', () => {
    expect(signaturePatch({ text: '', html: '' })).toEqual({ email_signature: '', email_signature_html: null });
    expect(signaturePatch({ html: '<script>x</script>', text: 'Ro' })).toEqual({
      email_signature: 'Ro',
      email_signature_html: null,
    });
  });

  it('says nothing when nothing was given', () => {
    expect(signaturePatch({})).toEqual({});
  });
});

describe('every send path asks the same function', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['__tests__', 'node_modules', 'scripts'].includes(e.name)) walk(full, out);
      } else if (e.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  it('no send path builds the signature separator itself', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === 'services/email/signature.ts') continue;
      const text = fs.readFileSync(file, 'utf8');
      // The old copies: "...\n\n-- \n${signature}" (escaped, or on real newlines).
      if (/-- (\\n|\r?\n)\s*\$\{/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
