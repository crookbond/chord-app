/**
 * The open email flickered once per re-read: every read of a thread mints a
 * new image token, the token is in every image URL, and adopting it rebuilt
 * the body. These pin the rule the reader now uses to keep it still.
 */
import { describe, expect, it } from 'vitest';

import {
  clipForReader,
  EMAIL_BODY_INLINE_MAX_HEIGHT,
  EMAIL_BODY_MIN_HEIGHT,
  EMAIL_READER_HTML_MAX,
  emailBodyBox,
  fitScale,
  holdImageToken,
  IMAGE_TOKEN_KEEP_MS,
} from '@chord/kernel';

describe('holdImageToken', () => {
  const t0 = 1_000_000;

  it('keeps the first token across the re-reads of an open email', () => {
    // The real sequence: prefetch, open, mark-read refresh, read-time check, sync.
    let held = holdImageToken(null, 'th1', 'tok-prefetch', t0);
    for (const [i, next] of ['tok-open', 'tok-read', 'tok-check', 'tok-sync'].entries()) {
      held = holdImageToken(held, 'th1', next, t0 + (i + 1) * 1000);
    }
    expect(held?.token).toBe('tok-prefetch');
  });

  it('takes the new thread\'s token when the screen moves to the next email', () => {
    const held = holdImageToken(null, 'th1', 'tok-a', t0);
    expect(holdImageToken(held, 'th2', 'tok-b', t0 + 10)?.token).toBe('tok-b');
  });

  it('replaces a token held long enough to be near its expiry', () => {
    const held = holdImageToken(null, 'th1', 'tok-a', t0);
    expect(holdImageToken(held, 'th1', 'tok-b', t0 + IMAGE_TOKEN_KEEP_MS)?.token).toBe('tok-b');
  });

  it('adopts a token once one arrives, and holds nothing before', () => {
    expect(holdImageToken(null, 'th1', null, t0)).toBeNull();
    expect(holdImageToken(null, 'th1', 'tok-a', t0)?.token).toBe('tok-a');
  });
});

describe('fitScale', () => {
  it('shrinks a 600px newsletter to a 375px phone', () => {
    expect(fitScale(600, 375)).toBeCloseTo(0.625);
  });

  it('leaves a body that fits, or overflows by rounding, alone', () => {
    expect(fitScale(375, 375)).toBe(1);
    expect(fitScale(376, 375)).toBe(1);
    expect(fitScale(200, 375)).toBe(1);
  });

  it('never divides by an unmeasured width', () => {
    expect(fitScale(600, 0)).toBe(1);
    expect(fitScale(0, 375)).toBe(1);
  });
});

describe('emailBodyBox', () => {
  // A long newsletter (Six Minute Mile, prod 2026-10-20) measured far past
  // 4,000px; the box was capped there and the rest of the email was clipped
  // with nothing saying so, reachable only through Full screen.
  it('gives a long email its whole measured height', () => {
    expect(emailBodyBox(9_437)).toEqual({ height: 9_437, clipped: false });
  });

  it('rounds up a fractional measurement so the last line is not shaved', () => {
    expect(emailBodyBox(1200.4)).toEqual({ height: 1201, clipped: false });
  });

  // A hostile email can be any height; the inline box stops and says so.
  it('stops the inline box at its ceiling and reports that the email goes on', () => {
    expect(emailBodyBox(10_000_000)).toEqual({ height: EMAIL_BODY_INLINE_MAX_HEIGHT, clipped: true });
    expect(emailBodyBox(EMAIL_BODY_INLINE_MAX_HEIGHT)).toEqual({
      height: EMAIL_BODY_INLINE_MAX_HEIGHT,
      clipped: false,
    });
  });

  it('keeps a floor for a tiny body', () => {
    expect(emailBodyBox(3)).toEqual({ height: EMAIL_BODY_MIN_HEIGHT, clipped: false });
  });

  it('ignores a probe message that is not a height', () => {
    expect(emailBodyBox(Number('loaded'))).toBeNull();
    expect(emailBodyBox(0)).toBeNull();
    expect(emailBodyBox(-5)).toBeNull();
  });
});

describe('clipForReader', () => {
  it('leaves an ordinary body alone', () => {
    expect(clipForReader('<p>hi</p>', EMAIL_READER_HTML_MAX, 'html')).toEqual({ body: '<p>hi</p>', clipped: false });
    expect(clipForReader(null, 10, 'text')).toEqual({ body: null, clipped: false });
  });

  it('cuts a huge HTML body before the tag the cut would split', () => {
    const html = `${'<p>row</p>'.repeat(30)}<img src="x.png" alt="y">`;
    const out = clipForReader(html, html.length - 5, 'html');
    expect(out).toEqual({ body: '<p>row</p>'.repeat(30), clipped: true });
  });

  it('cuts plain text at a word break', () => {
    const out = clipForReader(`${'a'.repeat(95)} ${'b'.repeat(20)}`, 100, 'text');
    expect(out).toEqual({ body: 'a'.repeat(95), clipped: true });
  });

  it('bounds a multi-megabyte body', () => {
    const out = clipForReader('<p>spam</p>'.repeat(1_000_000), EMAIL_READER_HTML_MAX, 'html');
    expect(out.clipped).toBe(true);
    expect(out.body!.length).toBeLessThanOrEqual(EMAIL_READER_HTML_MAX);
    // Never ends inside a tag.
    expect(/<[^>]*$/.test(out.body!)).toBe(false);
  });
});
