/**
 * Plain renderer snapshot tests. Pin every card kind so future platform
 * renderers (Chord, Telegram) can be diffed against this baseline. If
 * one of these assertions changes, the bridge text changed too — make
 * sure that's intentional before updating the expected string.
 */
import { describe, expect, it } from 'vitest';

import { renderPlain } from '@/services/connectors/renderers/plain.renderer.js';
import { renderFor } from '@/services/connectors/renderers/index.js';

describe('renderPlain — card kinds', () => {
  it('action card with title + subtitle + URL', () => {
    expect(
      renderPlain({
        body: 'Dos Caminos is a Mexican spot in Midtown.',
        cards: [
          {
            kind: 'action',
            title: 'Open in Maps',
            subtitle: 'Google Maps',
            url: 'https://maps.google.com/?q=Dos+Caminos',
          },
        ],
      }),
    ).toEqual({
      text:
        'Dos Caminos is a Mexican spot in Midtown.\n\n' +
        'Open in Maps — Google Maps: https://maps.google.com/?q=Dos+Caminos',
    });
  });

  it('task card with title + meta (no URL)', () => {
    expect(
      renderPlain({
        body: 'Added.',
        cards: [{ kind: 'task', title: 'Pick up groceries', meta: 'due Sat' }],
      }),
    ).toEqual({ text: 'Added.\n\nPick up groceries (due Sat)' });
  });

  it('save card with title + subtitle + URL', () => {
    expect(
      renderPlain({
        body: 'Saved.',
        cards: [
          {
            kind: 'save',
            title: 'Instagram reel',
            subtitle: 'places to eat',
            url: 'https://instagram.com/reel/x',
          },
        ],
      }),
    ).toEqual({
      text:
        'Saved.\n\nInstagram reel — places to eat: https://instagram.com/reel/x',
    });
  });

  it('event card with title + meta', () => {
    expect(
      renderPlain({
        body: '',
        cards: [
          {
            kind: 'event',
            title: 'Dinner with Alice',
            meta: 'Fri 7pm',
            url: 'https://chord.app/events/e_x',
          },
        ],
      }),
    ).toEqual({
      text: 'Dinner with Alice (Fri 7pm): https://chord.app/events/e_x',
    });
  });

  it('url-only action card surfaces just the URL', () => {
    expect(
      renderPlain({
        body: '',
        cards: [{ kind: 'action', title: '', url: 'https://chord.app' }],
      }),
    ).toEqual({ text: 'https://chord.app' });
  });

  it('empty cards array passes body through', () => {
    expect(renderPlain({ body: 'hello', cards: [] })).toEqual({ text: 'hello' });
  });

  it('drops cards that render as empty', () => {
    expect(
      renderPlain({
        body: 'body',
        cards: [
          { kind: 'task', title: '' },
          { kind: 'action', title: 'Go', url: 'https://x.com' },
        ],
      }),
    ).toEqual({ text: 'body\n\nGo: https://x.com' });
  });

  it('joins multiple cards with single newlines', () => {
    expect(
      renderPlain({
        body: '',
        cards: [
          { kind: 'action', title: 'Restaurants', url: 'https://opentable.com' },
          { kind: 'action', title: 'Delivery', url: 'https://doordash.com' },
        ],
      }),
    ).toEqual({
      text: 'Restaurants: https://opentable.com\nDelivery: https://doordash.com',
    });
  });
});

describe('renderFor dispatcher — bridge platforms route to plain', () => {
  // chord and telegram have their own renderers with distinct contracts;
  // those are covered in chord.renderer.test.ts and telegram.renderer.test.ts.
  // Here we pin that plain/slack/discord still use the plain renderer.
  const sample = {
    body: 'Saved.',
    cards: [
      { kind: 'save' as const, title: 'Reel', url: 'https://example.com' },
    ],
  };
  const expected = renderPlain(sample);

  it('plain → plain renderer', () => {
    expect(renderFor('plain', sample)).toEqual(expected);
  });

  it('slack → plain renderer', () => {
    expect(renderFor('slack', sample)).toEqual(expected);
  });

  it('discord → plain renderer', () => {
    expect(renderFor('discord', sample)).toEqual(expected);
  });
});

describe('renderPlain — senderName prefix', () => {
  it('prefixes body with sender name when set', () => {
    expect(
      renderPlain({
        body: 'on my way',
        cards: [],
        senderName: 'John',
      }),
    ).toEqual({ text: 'John: on my way' });
  });

  it('keeps card lines below the prefixed body', () => {
    expect(
      renderPlain({
        body: 'check this',
        cards: [{ kind: 'save', title: 'Reel', url: 'https://x.com' }],
        senderName: 'Alice',
      }),
    ).toEqual({ text: 'Alice: check this\n\nReel: https://x.com' });
  });

  it('no prefix when senderName is omitted', () => {
    expect(renderPlain({ body: 'hello', cards: [] })).toEqual({ text: 'hello' });
  });
});
