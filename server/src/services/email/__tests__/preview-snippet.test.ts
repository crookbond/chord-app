import { EDGE_SCROLL_MAX, EDGE_SCROLL_ZONE, edgeScrollStep } from '@chord/kernel';
import { describe, expect, it } from 'vitest';

import { previewSnippet } from '../classification.service.js';

describe('previewSnippet', () => {
  it('keeps a short snippet whole and drops an empty one', () => {
    expect(previewSnippet('  Pickup moved to 3pm.\n  See you there. ')).toBe(
      'Pickup moved to 3pm. See you there.',
    );
    expect(previewSnippet('')).toBeUndefined();
    expect(previewSnippet(null)).toBeUndefined();
  });

  it('cuts a long snippet to whole sentences', () => {
    const long =
      'Your order has shipped. It should arrive Thursday. ' +
      'Track it any time from your account page, where you can also change the delivery address or ask us to hold it at a pickup point near you, which is often easier when nobody is home during the day.';
    expect(previewSnippet(long)).toBe('Your order has shipped. It should arrive Thursday.');
  });

  it('cuts one long sentence at a word, with an ellipsis', () => {
    const out = previewSnippet('word '.repeat(80))!;
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('word…')).toBe(true);
  });
});

describe('edgeScrollStep', () => {
  const H = 600;

  it('does nothing away from the edges', () => {
    expect(edgeScrollStep(300, H)).toBe(0);
    expect(edgeScrollStep(EDGE_SCROLL_ZONE + 1, H)).toBe(0);
  });

  it('scrolls up near the top and down near the bottom, faster closer in', () => {
    const gentleUp = edgeScrollStep(EDGE_SCROLL_ZONE - 5, H);
    const fastUp = edgeScrollStep(2, H);
    expect(gentleUp).toBeLessThan(0);
    expect(fastUp).toBeLessThan(gentleUp);
    expect(edgeScrollStep(H - 5, H)).toBeGreaterThan(edgeScrollStep(H - EDGE_SCROLL_ZONE + 5, H));
    expect(edgeScrollStep(H - EDGE_SCROLL_ZONE + 5, H)).toBeGreaterThan(0);
  });

  it('caps the speed when the finger is past the edge', () => {
    expect(edgeScrollStep(-200, H)).toBe(-EDGE_SCROLL_MAX);
    expect(edgeScrollStep(H + 200, H)).toBe(EDGE_SCROLL_MAX);
    expect(edgeScrollStep(10, 0)).toBe(0);
  });
});
