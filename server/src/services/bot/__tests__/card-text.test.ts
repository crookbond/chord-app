/**
 * Card-line formatter used to enrich IM-bridge messages with Chord's
 * action / save / task card URLs that text-only channels (Telegram,
 * legacy Slack) can't render natively.
 */
import { describe, expect, it } from 'vitest';

import { appendCardLines, formatCardLine } from '@/services/bot/card-text.js';

describe('formatCardLine', () => {
  it('action card with URL → "Title — subtitle: URL"', () => {
    const line = formatCardLine({
      kind: 'action',
      title: 'Open in Maps',
      subtitle: 'Google Maps',
      url: 'https://maps.google.com/?q=Dos+Caminos',
    });
    expect(line).toBe('Open in Maps — Google Maps: https://maps.google.com/?q=Dos+Caminos');
  });

  it('card with title + meta + URL', () => {
    const line = formatCardLine({
      kind: 'event',
      title: 'Dinner with Alice',
      meta: 'Fri 7pm',
      url: 'https://chord.app/events/e_x',
    });
    expect(line).toBe('Dinner with Alice (Fri 7pm): https://chord.app/events/e_x');
  });

  it('card with no URL falls back to text only', () => {
    const line = formatCardLine({
      kind: 'task',
      title: 'Pick up groceries',
      meta: 'due Sat',
    });
    expect(line).toBe('Pick up groceries (due Sat)');
  });

  it('url-only card surfaces just the URL', () => {
    const line = formatCardLine({
      kind: 'action',
      title: '',
      url: 'https://chord.app',
    });
    expect(line).toBe('https://chord.app');
  });

  it('returns null when card has nothing visible', () => {
    const line = formatCardLine({ kind: 'task', title: '' });
    expect(line).toBeNull();
  });
});

describe('appendCardLines', () => {
  it('no cards → body unchanged', () => {
    expect(appendCardLines('hello', [])).toBe('hello');
  });

  it('appends each card on its own line after a blank line', () => {
    const body = 'Dos Caminos is a Mexican spot in Midtown.';
    const out = appendCardLines(body, [
      {
        kind: 'action',
        title: 'Open in Maps',
        subtitle: 'Google Maps',
        url: 'https://maps.google.com/?q=Dos+Caminos',
      },
    ]);
    expect(out).toBe(
      'Dos Caminos is a Mexican spot in Midtown.\n\n' +
        'Open in Maps — Google Maps: https://maps.google.com/?q=Dos+Caminos',
    );
  });

  it('joins multiple card lines with newlines', () => {
    const out = appendCardLines('', [
      { kind: 'action', title: 'Restaurants', url: 'https://opentable.com' },
      { kind: 'action', title: 'Delivery', url: 'https://doordash.com' },
    ]);
    expect(out).toBe('Restaurants: https://opentable.com\nDelivery: https://doordash.com');
  });

  it('drops cards that render as empty', () => {
    const out = appendCardLines('body', [
      { kind: 'task', title: '' },
      { kind: 'action', title: 'Go', url: 'https://x.com' },
    ]);
    expect(out).toBe('body\n\nGo: https://x.com');
  });
});
