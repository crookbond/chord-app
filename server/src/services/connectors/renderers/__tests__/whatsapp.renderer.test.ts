/**
 * WhatsApp renderer (ADR 0053 §7): callback action cards → quick-reply slot
 * (button payload = the `verb:id` the shared callback handler expects);
 * everything else degrades to plain text.
 */
import { describe, expect, it } from 'vitest';

import type { BotCard } from '@chord/kernel';

import { renderWhatsApp } from '@/services/connectors/renderers/whatsapp.renderer.js';

function proposalCard(id: string): BotCard {
  return {
    kind: 'action',
    title: 'Confirm?',
    buttons: [
      { label: 'Yes', callback: { verb: 'p+', id } },
      { label: 'No', callback: { verb: 'p-', id } },
    ],
  };
}

describe('whatsapp renderer (ADR 0053 §7)', () => {
  it('renders callback buttons as a quick-reply slot with verb:id payloads', () => {
    const r = renderWhatsApp({
      body: 'Add event to the Family calendar?',
      cards: [proposalCard('prop_1')],
    });
    expect(r.whatsapp?.quickReply?.body).toBe('Add event to the Family calendar?');
    expect(r.whatsapp?.quickReply?.buttons).toEqual([
      { id: 'p+:prop_1', title: 'Yes' },
      { id: 'p-:prop_1', title: 'No' },
    ]);
  });

  it('plain reply (no cards) → no quick-reply slot, just text', () => {
    const r = renderWhatsApp({ body: 'Added milk to your list.', cards: [] });
    expect(r.whatsapp).toBeUndefined();
    expect(r.text).toContain('Added milk');
  });

  // Flipped by ADR 0139. This asserted the old behaviour (a lone URL card fell
  // through to text) which was a Twilio Content API constraint, not a WhatsApp
  // one — Meta takes `cta_url` as an ordinary in-session message.
  it('a single URL action card becomes a cta_url button', () => {
    const r = renderWhatsApp({
      body: 'Sign up:',
      cards: [{ kind: 'action', title: 'Sign up for Chord', url: 'https://chordapp.ai/welcome/abc' }],
    });
    expect(r.whatsapp?.ctaUrl).toEqual({
      body: 'Sign up:',
      displayText: 'Sign up for Chord',
      url: 'https://chordapp.ai/welcome/abc',
    });
    // `text` still carries the URL: the Twilio connector reads only
    // `quickReply`, so it falls through to this and must not lose the link.
    expect(r.text).toContain('https://chordapp.ai/welcome/abc');
  });

  it('two URL cards stay plain text rather than promoting one', () => {
    const r = renderWhatsApp({
      body: 'Two options:',
      cards: [
        { kind: 'action', title: 'Track UA 512', url: 'https://flightaware.com/live/flight/UAL512' },
        { kind: 'action', title: 'Open in Maps', url: 'https://maps.google.com/?q=SFO' },
      ],
    });
    expect(r.whatsapp).toBeUndefined();
    expect(r.text).toContain('UAL512');
    expect(r.text).toContain('maps.google.com');
  });

  it('callback buttons win over a URL card in the same turn', () => {
    const r = renderWhatsApp({
      body: 'Add it?',
      cards: [
        proposalCard('prop_9'),
        { kind: 'action', title: 'Track UA 512', url: 'https://flightaware.com/live/flight/UAL512' },
      ],
    });
    expect(r.whatsapp?.quickReply?.buttons).toHaveLength(2);
    expect(r.whatsapp?.ctaUrl).toBeUndefined();
    // The URL is not lost — it rides the text body as a linkified bare URL.
    expect(r.text).toContain('UAL512');
  });

  it('clips a long cta_url display_text to <= 20 chars', () => {
    const r = renderWhatsApp({
      body: 'b',
      cards: [
        {
          kind: 'action',
          title: 'Track this extremely long flight label',
          url: 'https://flightaware.com/live/flight/UAL512',
        },
      ],
    });
    expect(r.whatsapp!.ctaUrl!.displayText.length).toBeLessThanOrEqual(20);
  });

  it('a cta_url turn with no prose still gets a non-empty body', () => {
    const r = renderWhatsApp({
      body: '',
      cards: [{ kind: 'action', title: 'Open', url: 'https://chordapp.ai/x' }],
    });
    expect(r.whatsapp!.ctaUrl!.body.length).toBeGreaterThan(0);
  });

  it('an href-only card (in-app nav) has no URL to promote', () => {
    const r = renderWhatsApp({
      body: 'Found it:',
      cards: [{ kind: 'task', title: 'Renew passport', href: '/catchup/tasks' }],
    });
    expect(r.whatsapp).toBeUndefined();
  });

  it('more than 3 callback buttons degrades to plain text (in-session cap)', () => {
    const card: BotCard = {
      kind: 'action',
      title: 'Pick',
      buttons: [0, 1, 2, 3].map((i) => ({
        label: `B${i}`,
        callback: { verb: 'x', id: String(i) },
      })),
    };
    expect(renderWhatsApp({ body: 'choose', cards: [card] }).whatsapp).toBeUndefined();
  });

  it('clips long button titles to <= 20 chars', () => {
    const card: BotCard = {
      kind: 'action',
      title: 'x',
      buttons: [
        { label: 'A very very long button label that overflows', callback: { verb: 'p+', id: '1' } },
      ],
    };
    const title = renderWhatsApp({ body: 'b', cards: [card] }).whatsapp!.quickReply!.buttons[0].title;
    expect(title.length).toBeLessThanOrEqual(20);
  });

  it('buttons-only turn (no prose) still gets a non-empty body', () => {
    const r = renderWhatsApp({ body: '', cards: [proposalCard('p1')] });
    expect(r.whatsapp!.quickReply!.body.length).toBeGreaterThan(0);
  });
});

/**
 * ADR 0140 — the 1600 cap is Twilio's, not WhatsApp's. One renderer serves two
 * transports, so the connector states the limit and the default stays the
 * smaller one (clipping early is a degraded send; overshooting Twilio is none).
 */
describe('text limit is the transport\'s, not a constant', () => {
  const long = 'x'.repeat(3000);

  it('defaults to Twilio\'s 1600', () => {
    const r = renderWhatsApp({ body: long, cards: [] });
    expect(r.text.length).toBeLessThanOrEqual(1600);
  });

  it('carries 4096 when the connector says Meta', () => {
    const r = renderWhatsApp({ body: long, cards: [], textLimit: 4096 });
    expect(r.text).toBe(long);
  });

  it('still clips at the Meta limit for a body past 4096', () => {
    const r = renderWhatsApp({ body: 'y'.repeat(5000), cards: [], textLimit: 4096 });
    expect(r.text.length).toBeLessThanOrEqual(4096);
    expect(r.text.length).toBeGreaterThan(1600);
  });
});
