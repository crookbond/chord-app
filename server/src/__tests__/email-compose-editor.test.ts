/**
 * ADR 0339 - Plain or Rich composing (kernel/src/email-compose-editor.ts).
 * The signature and draft are the Tom Kent reply from the Neural mailbox,
 * prod 2026-11-13: it was written in a plain box that showed the rich
 * signature as text.
 */
import { describe, expect, it } from 'vitest';

import {
  composeCommandPayload,
  composeEditorDocument,
  defaultComposeFormat,
  hasSignatureBlock,
  parseComposeEditorMessage,
  plainToRich,
  replaceRichMain,
  richToPlain,
  signatureEditorBlock,
  swapRichSignature,
  textToEditorHtml,
} from '@chord/kernel';

const SIG =
  'https://neuralads.ai/\nJohn Doe\n\nCo-Founder, Neural Ads\n\njohn@neuralads.ai (john@neuralads.ai) |\n' +
  'neuralads.ai (https://neuralads.ai/) |\nLinkedIn (https://www.linkedin.com/in/john-doe-413a431/)';
const SIG_HTML =
  '<a href="https://neuralads.ai/"><img src="https://neuralads.ai/logo.png"></a><br><b>John Doe</b><br>' +
  '<a href="mailto:john@neuralads.ai">john@neuralads.ai</a>';
const MAIN = 'Hi Tom,\n\nThanks for sharing the deck.\n\nBest,\nJohn';
const DRAFT = `${MAIN}\n\n-- \n${SIG}`;

describe('which way a composer opens', () => {
  it('follows the email it answers, a new message opens rich, a draft keeps its own', () => {
    expect(defaultComposeFormat({ kind: 'reply', original: { bodyHtml: '<div>hi</div>' } })).toBe('rich');
    expect(defaultComposeFormat({ kind: 'reply', original: { bodyHtml: null } })).toBe('plain');
    expect(defaultComposeFormat({ kind: 'forward', original: { bodyHtml: '  ' } })).toBe('plain');
    expect(defaultComposeFormat({ kind: 'new' })).toBe('rich');
    expect(defaultComposeFormat({ kind: 'reply', original: { bodyHtml: '<p>x</p>' }, draftFormat: 'plain' })).toBe('plain');
  });
});

describe('switching between plain and rich', () => {
  it('plain to rich draws the saved signature rich, and the text above as lines', () => {
    const html = plainToRich(DRAFT, SIG, SIG_HTML);
    expect(html).toContain('<div>Hi Tom,</div><div><br></div><div>Thanks for sharing the deck.</div>');
    expect(html).toContain(signatureEditorBlock(SIG_HTML));
    expect(html).not.toContain('john@neuralads.ai (john@');
    expect(hasSignatureBlock(html)).toBe(true);
  });

  it('an edited signature stays the text it was edited to', () => {
    const edited = DRAFT.replace('Co-Founder', 'Founder');
    const html = plainToRich(edited, SIG, SIG_HTML);
    expect(hasSignatureBlock(html)).toBe(false);
    expect(html).toContain('<div>Founder, Neural Ads</div>');
  });

  it('rich to plain puts the plain signature back under what was written', () => {
    expect(richToPlain({ text: 'ignored', mainText: `${MAIN}\n\n`, hasSignature: true }, SIG)).toBe(DRAFT);
    expect(richToPlain({ text: `${MAIN}\n`, mainText: MAIN, hasSignature: false }, SIG)).toBe(MAIN);
  });

  it('typed text is escaped, never markup', () => {
    expect(textToEditorHtml('<script>x</script>\n')).toBe('<div>&lt;script&gt;x&lt;/script&gt;</div><div><br></div>');
  });

  it('an AI draft replaces what was written and keeps the signature', () => {
    const html = plainToRich(DRAFT, SIG, SIG_HTML);
    const out = replaceRichMain(html, 'Hi Tom, yes.');
    expect(out.startsWith('<div>Hi Tom, yes.</div>')).toBe(true);
    expect(out).toContain(signatureEditorBlock(SIG_HTML));
  });

  it('another mailbox swaps the signature block', () => {
    const html = plainToRich(DRAFT, SIG, SIG_HTML);
    expect(swapRichSignature(html, '<i>Other</i>')).toContain(signatureEditorBlock('<i>Other</i>'));
    expect(hasSignatureBlock(swapRichSignature(html, null))).toBe(false);
  });
});

describe('the editor page', () => {
  it('reads only its own messages', () => {
    expect(parseComposeEditorMessage({ chordCompose: 'change', html: '<b>x</b>', text: 'x', mainText: 'x' })).toEqual({
      kind: 'change',
      html: '<b>x</b>',
      text: 'x',
      mainText: 'x',
    });
    expect(parseComposeEditorMessage(JSON.stringify({ chordCompose: 'height', height: 200.4 }))).toEqual({ kind: 'height', height: 201 });
    expect(parseComposeEditorMessage({ chordSignature: 'html', html: 'x' })).toBeNull();
    expect(parseComposeEditorMessage('nope')).toBeNull();
  });

  it('sends a link only to a web, mail or phone address', () => {
    expect(composeCommandPayload({ cmd: 'link', href: 'javascript:alert(1)' })).toBeNull();
    expect(JSON.parse(composeCommandPayload({ cmd: 'link', href: 'https://neuralads.ai' })!)).toEqual({
      chordComposeCmd: 'link',
      href: 'https://neuralads.ai',
    });
    expect(JSON.parse(composeCommandPayload({ cmd: 'bold' })!)).toEqual({ chordComposeCmd: 'bold' });
  });

  it('runs only its own nonce script', () => {
    const doc = composeEditorDocument('<div>x</div>', { nonce: 'abcdefgh1234', placeholder: 'Write "it"' });
    expect(doc).toContain("script-src 'nonce-abcdefgh1234'");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('data-placeholder="Write &quot;it&quot;"');
  });
});
