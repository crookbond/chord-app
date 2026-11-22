/**
 * Where a signature sits in a body (kernel/src/email-signature.ts, ADR 0260
 * addendum). The composer opens with it, the user may delete or edit it, and
 * an AI draft rewrites only the text above it.
 */
import { describe, expect, it } from 'vitest';

import {
  aiDraftToRevise,
  bodyWithSignature,
  findSignature,
  isOnlySignature,
  placeAiReply,
  signatureCaret,
  hasOutdatedSignature,
  replaceOutdatedSignature,
  joinRichSignature,
  signatureHtmlForMailbox,
  splitRichSignature,
  splitSignature,
  swapSignature,
} from '@chord/kernel';

import { outgoingBodies } from '../services/email/signature.js';

const SIG = 'John\nSent from Chord';

describe('signatureCaret', () => {
  it('puts the caret above the signature in a box nothing has been written in', () => {
    // The real shape: reply / compose open with "\n\n-- \n<sig>" and the web put
    // the caret at the end, under the signature.
    expect(signatureCaret(bodyWithSignature('', SIG), SIG)).toBe(0);
  });

  it('leaves the caret alone once something is written, or with no signature in the box', () => {
    expect(signatureCaret(bodyWithSignature('Count us in.', SIG), SIG)).toBe(null);
    expect(signatureCaret('', SIG)).toBe(null);
    expect(signatureCaret('\n\n-- \nRo', SIG)).toBe(null);
    expect(signatureCaret(bodyWithSignature('', null), null)).toBe(null);
  });
});

describe('bodyWithSignature', () => {
  it('opens an empty box with the signature under a blank line for typing', () => {
    expect(bodyWithSignature('', SIG)).toBe('\n\n-- \nJohn\nSent from Chord');
  });

  it('puts it under what was written, once', () => {
    const once = bodyWithSignature('Count us in.  \n', SIG);
    expect(once).toBe('Count us in.\n\n-- \nJohn\nSent from Chord');
    expect(bodyWithSignature(once, SIG)).toBe(once);
  });

  it('adds nothing when there is no signature', () => {
    expect(bodyWithSignature('Hi', null)).toBe('Hi');
    expect(bodyWithSignature('Hi', '   ')).toBe('Hi');
  });
});

describe('findSignature / splitSignature', () => {
  it('finds the signature on its own lines, also above a forwarded message', () => {
    const body = 'FYI\n\n-- \nJohn\nSent from Chord\n\n---------- Forwarded message ----------';
    expect(findSignature(body, SIG)).toBe(5);
    expect(splitSignature(body, SIG)).toEqual({
      main: 'FYI\n\n---------- Forwarded message ----------',
      hadSignature: true,
    });
  });

  it('does not find an edited signature, or one the user deleted', () => {
    expect(findSignature('Hi\n\n-- \nJohn (away)\nSent from Chord', SIG)).toBe(-1);
    expect(splitSignature('Hi', SIG)).toEqual({ main: 'Hi', hadSignature: false });
  });

  it('reads a Windows line break the same', () => {
    expect(findSignature('Hi\r\n\r\n-- \r\nJohn\r\nSent from Chord', SIG)).toBeGreaterThan(0);
  });
});

describe('isOnlySignature', () => {
  it('is true for the box as it opened, and for an empty box', () => {
    expect(isOnlySignature(bodyWithSignature('', SIG), SIG)).toBe(true);
    expect(isOnlySignature('  ', SIG)).toBe(true);
  });

  it('is false once anything is written, or once the signature was edited', () => {
    expect(isOnlySignature(bodyWithSignature('Hi', SIG), SIG)).toBe(false);
    expect(isOnlySignature('\n\n-- \nRo', SIG)).toBe(false);
  });
});

/**
 * Suggested reply (ADR 0197). A reply draft saved on Monday was restored into
 * the box when the thread was reopened on Wednesday after two new messages,
 * and Suggested handed back that Monday draft instead of a new reply.
 */
describe('aiDraftToRevise', () => {
  const monday = bodyWithSignature('Tuesday works for us.', SIG);

  it('Suggested never sends a saved draft to be revised', () => {
    expect(aiDraftToRevise(monday, SIG, { fresh: true })).toBeUndefined();
  });

  it('a typed ask still revises what is in the box, without the signature', () => {
    expect(aiDraftToRevise(monday, SIG, { fresh: false })).toBe('Tuesday works for us.');
  });

  it('a box holding only the signature has nothing to revise', () => {
    expect(aiDraftToRevise(bodyWithSignature('', SIG), SIG, { fresh: false })).toBeUndefined();
  });
});

describe('placeAiReply', () => {
  it('replaces the old draft and keeps the signature under the new reply', () => {
    const monday = bodyWithSignature('Tuesday works for us.', SIG);
    const next = placeAiReply(monday, 'Thursday is better now that practice moved.', SIG);
    expect(next).not.toContain('Tuesday works');
    expect(splitSignature(next, SIG)).toEqual({
      main: 'Thursday is better now that practice moved.',
      hadSignature: true,
    });
  });

  it('leaves the signature out when the person had deleted it', () => {
    expect(placeAiReply('Sure, see you then', 'Sounds good.', SIG)).toBe('Sounds good.');
  });
});

describe('an outdated signature in the box (prod, Hunter reply 2026-11-13)', () => {
  // The Neural mailbox's saved signature, and the copy left in the reply draft:
  // made before the email link was corrected from tom@ to john@.
  const SAVED =
    'https://neuralads.ai/\nJohn Doe\n\nCo-Founder, Neural Ads\n\njohn@neuralads.ai (john@neuralads.ai) |\nneuralads.ai (https://neuralads.ai/) |\nLinkedIn (https://www.linkedin.com/in/john-doe-413a431/)';
  const OLD = SAVED.replace('(john@neuralads.ai)', '(tom@neuralads.ai)');
  const RICH = '<table><tr><td><b>John Doe</b></td></tr></table>';
  const box = bodyWithSignature('Hi Hunter,\n\nThanks! I have signed.\n\nthanks,\nJohn', OLD);

  it('the old copy does not get the rich signature at send', () => {
    expect(outgoingBodies(box, { email_signature: SAVED, email_signature_html: RICH }).html).not.toContain('<table');
  });

  it('is recognised as outdated, and replacing it brings the rich signature back', () => {
    expect(hasOutdatedSignature(box, SAVED)).toBe(true);
    const fixed = replaceOutdatedSignature(box, SAVED);
    expect(hasOutdatedSignature(fixed, SAVED)).toBe(false);
    expect(fixed.startsWith('Hi Hunter,\n\nThanks! I have signed.\n\nthanks,\nJohn\n\n-- \n')).toBe(true);
    expect(outgoingBodies(fixed, { email_signature: SAVED, email_signature_html: RICH }).html).toContain('<table');
  });

  it('is not flagged for the saved signature, no signature, or no saved one', () => {
    expect(hasOutdatedSignature(bodyWithSignature('Hi', SAVED), SAVED)).toBe(false);
    expect(hasOutdatedSignature('Hi Hunter, thanks', SAVED)).toBe(false);
    expect(hasOutdatedSignature('Hi\n\n-- \n', SAVED)).toBe(false);
    expect(hasOutdatedSignature(box, null)).toBe(false);
  });

  it('swapSignature updates an untouched copy when the saved one changes while the box is open', () => {
    expect(findSignature(swapSignature(box, OLD, SAVED), SAVED)).toBeGreaterThan(0);
  });
});

// ADR 0338: the Tom Kent draft from prod, 2026-11-13. The composer showed the
// plain copy of the rich Neural signature; it now draws the rich one under the
// box, and the body (what is saved and sent) must not change while typing.
describe('the composer box with a rich signature under it', () => {
  const NEURAL_SIG =
    'https://neuralads.ai/\nJohn Doe\n\nCo-Founder, Neural Ads\n\njohn@neuralads.ai (john@neuralads.ai) |\n' +
    'neuralads.ai (https://neuralads.ai/) |\nLinkedIn (https://www.linkedin.com/in/john-doe-413a431/)';
  const MAIN =
    'Hi Tom,\n\nThanks for sharing the deck and for the great conversation earlier. ' +
    'I’ll reach out to Rusty at Swell Capital and keep you posted.\n\nBest,  \nJohn';
  const TOM_DRAFT = `${MAIN}\n\n-- \n${NEURAL_SIG}`;

  it('shows only what was written, and puts back exactly the saved draft', () => {
    expect(splitRichSignature(TOM_DRAFT, NEURAL_SIG)).toEqual({ main: MAIN, atEnd: true });
    expect(joinRichSignature(MAIN, NEURAL_SIG)).toBe(TOM_DRAFT);
  });

  it('keeps a trailing space while typing', () => {
    const body = joinRichSignature('Hi ', NEURAL_SIG);
    expect(splitRichSignature(body, NEURAL_SIG).main).toBe('Hi ');
    expect(findSignature(body, NEURAL_SIG)).toBeGreaterThan(0);
  });

  it('opens on an empty box over a fresh composer', () => {
    expect(splitRichSignature(bodyWithSignature('', NEURAL_SIG), NEURAL_SIG)).toEqual({ main: '', atEnd: true });
  });

  it('leaves an edited or older signature in the box', () => {
    const old = TOM_DRAFT.replace('john@neuralads.ai (john@', 'john@neuralads.ai (tom@');
    expect(splitRichSignature(old, NEURAL_SIG)).toEqual({ main: old, atEnd: false });
    expect(splitRichSignature(`${TOM_DRAFT}\n\nP.S. more`, NEURAL_SIG).atEnd).toBe(false);
  });

  it("a mailbox's own entry decides its rich signature", () => {
    expect(signatureHtmlForMailbox('<b>shared</b>', { acc1: { text: 'x', html: '<b>own</b>' } }, 'acc1')).toBe('<b>own</b>');
    expect(signatureHtmlForMailbox('<b>shared</b>', { acc1: { text: 'x', html: null } }, 'acc1')).toBeNull();
    expect(signatureHtmlForMailbox('<b>shared</b>', null, null)).toBe('<b>shared</b>');
  });
});
