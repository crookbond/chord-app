/**
 * Per-platform length caps. The invariant that matters is that the result is
 * ALWAYS within the limit — Twilio (21617) and Telegram (MESSAGE_TOO_LONG)
 * reject an oversized body outright rather than trimming it, so an off-by-one
 * here is a dropped message, not a cosmetic bug.
 */
import { describe, expect, it } from 'vitest';

import { renderTelegram } from '../telegram.renderer';
import { renderWhatsApp } from '../whatsapp.renderer';
import {
  TELEGRAM_LIMIT,
  WHATSAPP_LIMIT,
  clipForPlatform,
} from '../truncate';

const URL = 'https://chordapp.ai/groups/g_abc';

describe('clipForPlatform', () => {
  it('leaves a message under the limit completely alone', () => {
    expect(clipForPlatform('short', 100, URL)).toBe('short');
  });

  it('leaves a message exactly at the limit alone', () => {
    const exact = 'x'.repeat(50);
    expect(clipForPlatform(exact, 50, URL)).toBe(exact);
  });

  it('never exceeds the limit, suffix included', () => {
    const long = 'word '.repeat(2000);
    for (const limit of [80, 200, 1024, WHATSAPP_LIMIT, TELEGRAM_LIMIT]) {
      const out = clipForPlatform(long, limit, URL);
      expect(out.length).toBeLessThanOrEqual(limit);
    }
  });

  it('appends the read-more link when clipping', () => {
    const out = clipForPlatform('word '.repeat(500), 200, URL);
    expect(out).toContain('Read more: ' + URL);
    expect(out.startsWith('word word')).toBe(true);
  });

  it('still clips when there is no link to offer', () => {
    const out = clipForPlatform('word '.repeat(500), 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain('…');
    expect(out).not.toContain('Read more');
  });

  it('cuts on a paragraph boundary rather than mid-sentence', () => {
    const text = `${'a'.repeat(150)}\n\nsecond paragraph that runs past the cap ${'b'.repeat(200)}`;
    const out = clipForPlatform(text, 220, URL);
    // The break is the blank line, so nothing of the second paragraph leaks.
    expect(out.startsWith('a'.repeat(150))).toBe(true);
    expect(out).not.toContain('second paragraph');
  });

  it('does not sacrifice most of the budget for a tidier boundary', () => {
    // A paragraph break sits at char 10; honouring it would waste ~95% of the
    // allowance, so the word-boundary cut near the end should win instead.
    const text = `tiny head\n\n${'filler '.repeat(300)}`;
    const out = clipForPlatform(text, 400, URL);
    expect(out.length).toBeGreaterThan(300);
  });

  it('degrades to the suffix rather than overshooting on an absurd limit', () => {
    const out = clipForPlatform('x'.repeat(500), 10, URL);
    expect(out.length).toBeLessThanOrEqual(10);
  });
});

describe('renderWhatsApp length cap', () => {
  it('clips a briefing to Twilio 1600 and points at the app', () => {
    const body = 'Your Tuesday. '.repeat(400);
    const out = renderWhatsApp({ body, cards: [], moreUrl: URL });
    expect(body.length).toBeGreaterThan(WHATSAPP_LIMIT);
    expect(out.text.length).toBeLessThanOrEqual(WHATSAPP_LIMIT);
    expect(out.text).toContain(URL);
  });

  it('leaves an ordinary reply untouched', () => {
    const out = renderWhatsApp({ body: 'on my way', cards: [], moreUrl: URL });
    expect(out.text).toBe('on my way');
  });

  it('clips the interactive body to its tighter 1024 cap', () => {
    const out = renderWhatsApp({
      body: 'x'.repeat(3000),
      cards: [
        {
          kind: 'action',
          title: 'Confirm?',
          buttons: [
            { label: 'Yes', callback: { verb: 'p+', id: 'p1' } },
            { label: 'No', callback: { verb: 'p-', id: 'p1' } },
          ],
        },
      ],
      moreUrl: URL,
    });
    expect(out.whatsapp?.quickReply).toBeDefined();
    expect(out.whatsapp!.quickReply!.body.length).toBeLessThanOrEqual(1024);
  });
});

describe('renderTelegram length cap', () => {
  it('clips to 4096 and points at the app', () => {
    const body = 'Your Tuesday. '.repeat(1000);
    const out = renderTelegram({ body, cards: [], moreUrl: URL });
    expect(body.length).toBeGreaterThan(TELEGRAM_LIMIT);
    expect(out.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(out.text).toContain(URL);
  });

  it('drops to escaped plain text when the HTML would be cut mid-tag', () => {
    // A sender prefix puts <b>…</b> in the HTML slot. Over the limit we must
    // not hand Telegram a half-open tag, or it rejects the whole send.
    const out = renderTelegram({
      body: 'y'.repeat(6000),
      cards: [],
      senderName: 'Sam',
      moreUrl: URL,
    });
    const html = out.telegram!.html;
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    // Every opened tag is closed — i.e. there is no dangling '<'.
    const opens = (html.match(/</g) ?? []).length;
    const closes = (html.match(/>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('keeps HTML formatting on a message that fits', () => {
    const out = renderTelegram({
      body: 'hello',
      cards: [],
      senderName: 'Sam',
      moreUrl: URL,
    });
    expect(out.telegram!.html).toContain('<b>Sam:</b>');
  });
});
