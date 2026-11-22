/**
 * Telegram renderer — HTML body + inline-keyboard buttons.
 *
 * Pins the contract:
 *   - action cards with URLs become inline-keyboard buttons (one per
 *     row), NOT lines in the body.
 *   - non-action cards (save / task / event / etc.) render as
 *     <b>title</b> — subtitle (meta): <a href="url">url</a>.
 *   - HTML-special chars in user-supplied text are escaped (&, <, >).
 *   - `disable_web_page_preview` is always true — Telegram's auto
 *     preview cards are noisy and duplicate our action cards.
 *   - `text` fallback is plain (no HTML), so a client that fails to
 *     parse HTML still sees readable content.
 */
import { describe, expect, it } from 'vitest';

import { renderTelegram } from '@/services/connectors/renderers/telegram.renderer.js';
import { renderFor } from '@/services/connectors/renderers/index.js';

describe('renderTelegram — action cards', () => {
  it('action card with URL → inline-keyboard button, NOT body line', () => {
    const out = renderTelegram({
      body: "Here's Dos Caminos on the map.",
      cards: [
        {
          kind: 'action',
          title: 'Open in Maps',
          url: 'https://maps.google.com/?q=Dos+Caminos',
        },
      ],
    });
    expect(out.telegram.replyMarkup).toEqual({
      inline_keyboard: [[
        { text: 'Open in Maps', url: 'https://maps.google.com/?q=Dos+Caminos' },
      ]],
    });
    // Body must NOT contain the URL as a line — that's what the button is for.
    expect(out.telegram.html).not.toContain('maps.google.com');
    expect(out.telegram.html).toBe("Here&#39;s Dos Caminos on the map.".replace('&#39;', "'"));
  });

  it('multiple action cards → multiple buttons, one per row', () => {
    const out = renderTelegram({
      body: 'Pick one:',
      cards: [
        { kind: 'action', title: 'OpenTable', url: 'https://opentable.com' },
        { kind: 'action', title: 'DoorDash', url: 'https://doordash.com' },
      ],
    });
    expect(out.telegram.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: 'OpenTable', url: 'https://opentable.com' }],
        [{ text: 'DoorDash', url: 'https://doordash.com' }],
      ],
    });
  });

  it('action card without URL or callback is dropped (no button)', () => {
    const out = renderTelegram({
      body: 'hi',
      cards: [{ kind: 'action', title: 'No URL action' }],
    });
    expect(out.telegram.replyMarkup).toBeUndefined();
  });

  it('action card with callback → inline-keyboard button with callback_data (ADR 0029)', () => {
    const out = renderTelegram({
      body: '📎 I see 2 saves — tap to confirm.',
      cards: [
        {
          kind: 'action',
          title: '✓ Costco list',
          callback: { verb: 'p+', id: 'prop_abc123' },
        },
        {
          kind: 'action',
          title: '✓ Doctor appointment',
          callback: { verb: 'p+', id: 'prop_def456' },
        },
      ],
    });
    expect(out.telegram.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: '✓ Costco list', callback_data: 'p+:prop_abc123' }],
        [{ text: '✓ Doctor appointment', callback_data: 'p+:prop_def456' }],
      ],
    });
  });

  it('mixed URL + callback cards each render as their own button type', () => {
    const out = renderTelegram({
      body: 'pick',
      cards: [
        { kind: 'action', title: 'Sign up', url: 'https://chord.app/signup' },
        {
          kind: 'action',
          title: '✓ Confirm',
          callback: { verb: 'p+', id: 'p1' },
        },
      ],
    });
    expect(out.telegram.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: 'Sign up', url: 'https://chord.app/signup' }],
        [{ text: '✓ Confirm', callback_data: 'p+:p1' }],
      ],
    });
  });

  it('multi-button action card → single row, multiple buttons (ADR 0029)', () => {
    const out = renderTelegram({
      body: 'tap to confirm',
      cards: [
        {
          kind: 'action',
          title: 'Costco list',
          buttons: [
            {
              label: '✓ Costco list',
              callback: { verb: 'p+', id: 'prop_a' },
            },
            { label: '✗', callback: { verb: 'p-', id: 'prop_a' } },
          ],
        },
        {
          kind: 'action',
          title: 'Doctor appt',
          buttons: [
            {
              label: '✓ Doctor appt',
              callback: { verb: 'p+', id: 'prop_b' },
            },
            { label: '✗', callback: { verb: 'p-', id: 'prop_b' } },
          ],
        },
      ],
    });
    expect(out.telegram.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: '✓ Costco list', callback_data: 'p+:prop_a' },
          { text: '✗', callback_data: 'p-:prop_a' },
        ],
        [
          { text: '✓ Doctor appt', callback_data: 'p+:prop_b' },
          { text: '✗', callback_data: 'p-:prop_b' },
        ],
      ],
    });
  });

  it('multi-button card with mixed URL + callback buttons in one row', () => {
    const out = renderTelegram({
      body: 'options',
      cards: [
        {
          kind: 'action',
          title: 'choice',
          buttons: [
            { label: 'Open', url: 'https://example.test' },
            { label: 'Dismiss', callback: { verb: 'p-', id: 'p1' } },
          ],
        },
      ],
    });
    expect(out.telegram.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: 'Open', url: 'https://example.test' },
          { text: 'Dismiss', callback_data: 'p-:p1' },
        ],
      ],
    });
  });

  it('action card with empty buttons array and no url/callback → dropped', () => {
    const out = renderTelegram({
      body: 'hi',
      cards: [{ kind: 'action', title: 'No buttons', buttons: [] }],
    });
    expect(out.telegram.replyMarkup).toBeUndefined();
  });

  it('disable_web_page_preview is always true (buttons + no URL)', () => {
    const out = renderTelegram({
      body: 'click below',
      cards: [{ kind: 'action', title: 'Open', url: 'https://x.com' }],
    });
    expect(out.telegram.disableWebPagePreview).toBe(true);
  });

  it('disable_web_page_preview is always true (body contains a URL)', () => {
    const out = renderTelegram({
      body: 'see also https://wiki.example.com/x',
      cards: [{ kind: 'action', title: 'Open', url: 'https://x.com' }],
    });
    expect(out.telegram.disableWebPagePreview).toBe(true);
  });

  it('disable_web_page_preview is always true (no buttons)', () => {
    const out = renderTelegram({ body: 'hello', cards: [] });
    expect(out.telegram.disableWebPagePreview).toBe(true);
  });
});

describe('renderTelegram — inline cards (save / task / event)', () => {
  it('save card renders as <b>title</b>: <a href>url</a>', () => {
    const out = renderTelegram({
      body: 'Saved.',
      cards: [
        {
          kind: 'save',
          title: 'Instagram reel',
          url: 'https://instagram.com/reel/x',
        },
      ],
    });
    expect(out.telegram.html).toBe(
      'Saved.\n\n' +
        '<b>Instagram reel</b>: ' +
        '<a href="https://instagram.com/reel/x">https://instagram.com/reel/x</a>',
    );
    expect(out.telegram.replyMarkup).toBeUndefined();
  });

  it('task card with meta but no URL → <b>title</b> (meta)', () => {
    const out = renderTelegram({
      body: 'Added.',
      cards: [{ kind: 'task', title: 'Pick up groceries', meta: 'due Sat' }],
    });
    expect(out.telegram.html).toBe('Added.\n\n<b>Pick up groceries</b> (due Sat)');
  });

  it('event card with subtitle + URL', () => {
    const out = renderTelegram({
      body: '',
      cards: [
        {
          kind: 'event',
          title: 'Dinner',
          subtitle: 'Friday 7pm',
          url: 'https://chord.app/events/e_x',
        },
      ],
    });
    expect(out.telegram.html).toBe(
      '<b>Dinner</b> — Friday 7pm: ' +
        '<a href="https://chord.app/events/e_x">https://chord.app/events/e_x</a>',
    );
  });
});

describe('renderTelegram — HTML escaping', () => {
  it('escapes &, <, > in body and card fields', () => {
    const out = renderTelegram({
      body: 'Marco & Bros <hello>',
      cards: [
        {
          kind: 'save',
          title: 'Cake & <Pastry>',
          url: 'https://example.com/?a=1&b=2',
        },
      ],
    });
    expect(out.telegram.html).toContain('Marco &amp; Bros &lt;hello&gt;');
    expect(out.telegram.html).toContain('<b>Cake &amp; &lt;Pastry&gt;</b>');
    // Attribute value escaped too.
    expect(out.telegram.html).toContain('href="https://example.com/?a=1&amp;b=2"');
  });
});

describe('renderTelegram — text fallback', () => {
  it('always populates a plain-text fallback', () => {
    const out = renderTelegram({
      body: 'Saved.',
      cards: [
        { kind: 'save', title: 'Reel', url: 'https://example.com' },
        { kind: 'action', title: 'Open', url: 'https://x.com' },
      ],
    });
    // Plain fallback does NOT include the action card (it'd duplicate
    // the button). Inline cards still render plain.
    expect(out.text).toBe('Saved.\n\nReel: https://example.com');
  });

  it('empty body + empty cards → empty fallback', () => {
    const out = renderTelegram({ body: '', cards: [] });
    expect(out.text).toBe('');
  });

  it('action-only with no prose → button label fills the body slot (Telegram requires non-empty text)', () => {
    const out = renderTelegram({
      body: '',
      cards: [{ kind: 'action', title: 'Book on OpenTable', url: 'https://ot' }],
    });
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.telegram.html.length).toBeGreaterThan(0);
    expect(out.telegram.replyMarkup).toBeDefined();
  });
});

describe('renderFor dispatcher — Commit C: telegram routes to telegram renderer', () => {
  it('telegram platform produces an HTML slot', () => {
    const out = renderFor('telegram', {
      body: 'hi',
      cards: [{ kind: 'action', title: 'Open', url: 'https://x.com' }],
    });
    expect(out.telegram).toBeDefined();
    expect(out.telegram!.replyMarkup).toBeDefined();
  });

  it('chord/plain/slack/discord still NO telegram slot', () => {
    const input = {
      body: 'hi',
      cards: [{ kind: 'action' as const, title: 'Open', url: 'https://x.com' }],
    };
    expect(renderFor('chord', input).telegram).toBeUndefined();
    expect(renderFor('plain', input).telegram).toBeUndefined();
    expect(renderFor('slack', input).telegram).toBeUndefined();
    expect(renderFor('discord', input).telegram).toBeUndefined();
  });
});

describe('renderTelegram — senderName prefix', () => {
  it('wraps the sender name in <b> and prefixes the HTML body', () => {
    const out = renderTelegram({
      body: 'on my way',
      cards: [],
      senderName: 'John',
    });
    expect(out.telegram.html).toBe('<b>John:</b> on my way');
    expect(out.text).toBe('John: on my way');
  });

  it('escapes HTML metacharacters in the sender name', () => {
    const out = renderTelegram({
      body: 'hi',
      cards: [],
      senderName: 'A<B>C',
    });
    expect(out.telegram.html).toBe('<b>A&lt;B&gt;C:</b> hi');
  });

  it('no prefix when senderName is omitted', () => {
    const out = renderTelegram({ body: 'hi', cards: [] });
    expect(out.telegram.html).toBe('hi');
    expect(out.text).toBe('hi');
  });
});
