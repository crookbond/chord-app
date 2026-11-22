/**
 * Where the quote starts (ADR 0121). The rule these all serve: a split that
 * cannot be trusted collapses nothing, because hiding mail is worse than
 * showing a quote.
 */
import { describe, expect, it } from 'vitest';

import { splitQuotedHtml, splitQuotedText } from '@chord/kernel';

describe('splitQuotedText', () => {
  it('splits at a Gmail attribution line', () => {
    const body = [
      'Yes, works for me.',
      '',
      'On Mon, 4 Aug 2026 at 09:12, Jo <jo@x.example> wrote:',
      '> Can you make Tuesday?',
      '> - Jo',
    ].join('\n');

    const { visible, quoted } = splitQuotedText(body);

    expect(visible).toBe('Yes, works for me.');
    expect(quoted).toContain('Can you make Tuesday?');
  });

  it('splits when Gmail wrapped the attribution onto a second line', () => {
    const body = [
      'Sounds good.',
      '',
      'On Mon, 4 Aug 2026 at 09:12, Josephine Someone-Long <jo@x.example>',
      'wrote:',
      '> the original',
      '> and more of it',
    ].join('\n');

    expect(splitQuotedText(body).visible).toBe('Sounds good.');
  });

  it('splits at a bare run of > lines with no attribution', () => {
    const body = ['Agreed.', '', '> first quoted line', '> second quoted line'].join('\n');

    expect(splitQuotedText(body).visible).toBe('Agreed.');
  });

  it('leaves a single > line alone - that is someone quoting a phrase', () => {
    const body = ['She said > this < and I disagree', 'so here is my reasoning at length'].join(
      '\n',
    );

    expect(splitQuotedText(body).quoted).toBeNull();
  });

  it('splits at an Outlook header block, which quotes without >', () => {
    const body = [
      'Forwarding for your records.',
      '',
      'From: Someone <s@x.example>',
      'Sent: Monday, 4 August 2026 09:12',
      'To: Me <me@x.example>',
      'Subject: The thing',
      '',
      'The original message text.',
    ].join('\n');

    const { visible, quoted } = splitQuotedText(body);

    expect(visible).toBe('Forwarding for your records.');
    expect(quoted).toContain('The original message text.');
  });

  it('splits at the Outlook separator rule', () => {
    const body = ['Here you go.', '', '________________________________', 'Older thread text'].join(
      '\n',
    );

    expect(splitQuotedText(body).visible).toBe('Here you go.');
  });

  it('collapses nothing when the whole message is quoted', () => {
    // A top-post with no new text: splitting leaves an empty message, so the
    // reader gets the quote instead of a blank card.
    const body = ['On Mon Jo wrote:', '> everything', '> is quoted'].join('\n');

    expect(splitQuotedText(body).quoted).toBeNull();
  });

  it('collapses nothing for a quote too short to be worth a control', () => {
    const body = ['My reply.', '', '> ok'].join('\n');

    expect(splitQuotedText(body).quoted).toBeNull();
  });

  it('copes with nothing', () => {
    expect(splitQuotedText(null)).toEqual({ visible: '', quoted: null });
    expect(splitQuotedText('')).toEqual({ visible: '', quoted: null });
  });
});

describe('splitQuotedHtml', () => {
  it('splits at the gmail_quote container, keeping the attribution quoted', () => {
    const html =
      '<div dir="ltr">Yes, that works.</div>' +
      '<div class="gmail_quote">On Mon Jo wrote:' +
      '<blockquote class="gmail_quote">the original message</blockquote></div>';

    const { visible, quoted } = splitQuotedHtml(html);

    expect(visible).toBe('<div dir="ltr">Yes, that works.</div>');
    expect(quoted).toContain('On Mon Jo wrote:');
  });

  it('splits at a bare blockquote when no client marker is present', () => {
    const html = '<p>Short answer: yes.</p><blockquote>the whole original message</blockquote>';

    expect(splitQuotedHtml(html).visible).toBe('<p>Short answer: yes.</p>');
  });

  it('recognises Outlook and Yahoo containers', () => {
    for (const marker of ['id="divRplyFwdMsg"', 'class="yahoo_quoted_1234"']) {
      const html = `<p>My reply here.</p><div ${marker}>the original message text</div>`;

      expect(splitQuotedHtml(html).quoted).toContain('the original message text');
    }
  });

  it('collapses nothing when the visible half has no text', () => {
    // Quote-first layouts exist; splitting them would hide the message.
    const html = '<div></div><blockquote>everything is in here, all of it</blockquote>';

    expect(splitQuotedHtml(html).quoted).toBeNull();
  });

  it('collapses nothing when the message opens with the quote', () => {
    const html = '<blockquote>the original message, quoted first</blockquote><p>My reply.</p>';

    expect(splitQuotedHtml(html).quoted).toBeNull();
  });

  it('copes with nothing', () => {
    expect(splitQuotedHtml(null)).toEqual({ visible: '', quoted: null });
  });
});
