/**
 * The briefing's email section listed the same thing twice:
 *   Waiting on you:
 *     ✨ Wait for seller response about order cancellation
 *     ✨ Decide whether to cancel phone order for use in India and request cancellation if needed
 *   Worth a look:
 *     • Microsoft: We've verified your profile (… 7177760) and you may start exploring Partner Center
 *     • Microsoft: We've verified your profile (… 7177760) and you may start exploring Partner Center
 *
 * The embed stub below returns vectors with the similarities the prod model
 * actually gives these pairs (measured 2026-10-23, text-embedding-3-small/512).
 */
import { describe, expect, it } from 'vitest';

import { keepDistinct, type EmbedTexts } from '@/services/briefing/near-duplicates.js';

/** Unit vectors whose pairwise cosine with the first is `sims[i]`. */
function vectorsWith(sims: number[]): Float32Array[] {
  return sims.map((s, i) => {
    const v = new Float32Array(sims.length + 1);
    if (i === 0) {
      v[0] = 1;
      return v;
    }
    v[0] = s;
    v[i] = Math.sqrt(1 - s * s);
    return v;
  });
}
const embedAs = (sims: number[]): EmbedTexts => async () => vectorsWith(sims);

type Item = { text: string; thread: string };
const texts = (items: Item[]) => items.map((i) => i.text);
const run = (items: Item[], embed?: EmbedTexts) =>
  keepDistinct(items, (i) => i.text, (i) => i.thread, embed);

describe('keepDistinct', () => {
  it('two suggestions from one email about the same errand are one line (0.55)', async () => {
    const items = [
      { text: 'Wait for seller response about order cancellation', thread: 'g1' },
      { text: 'Decide whether to cancel phone order for use in India and request cancellation if needed', thread: 'g1' },
    ];
    expect(texts(await run(items, embedAs([1, 0.551])))).toEqual([items[0]!.text]);
  });

  it('the same pair from two different emails is kept (below the cross-email bar)', async () => {
    const items = [
      { text: 'Wait for seller response about order cancellation', thread: 'g1' },
      { text: 'Decide whether to cancel phone order for use in India and request cancellation if needed', thread: 'g2' },
    ];
    expect(await run(items, embedAs([1, 0.551]))).toHaveLength(2);
  });

  it("Nolan's slip and Ben's slip are different to-dos, though close (0.77)", async () => {
    const items = [
      { text: 'Sign Nolan permission slip for field trip', thread: 'g1' },
      { text: 'Sign Ben permission slip for field trip', thread: 'g2' },
    ];
    expect(await run(items, embedAs([1, 0.767]))).toHaveLength(2);
  });

  it('a near-identical item from another email is one line (0.86)', async () => {
    const items = [
      { text: 'RSVP to Ben soccer party', thread: 'g1' },
      { text: 'Reply to the invitation for Ben’s soccer party', thread: 'g2' },
    ];
    expect(await run(items, embedAs([1, 0.857]))).toHaveLength(1);
  });

  it('identical wording is one line with meaning search off', async () => {
    const line = 'Microsoft: We’ve verified your profile (Family Grocery Trip Chat Agent LLC dba ChordApp.ai, 7177760) and you may start exploring Partner Center';
    const items = [
      { text: line, thread: 'g1' },
      { text: line, thread: 'g2' },
    ];
    expect(await run(items)).toHaveLength(1);
  });

  it('keeps everything distinct when the embedding call fails', async () => {
    const items = [
      { text: 'Wait for seller response about order cancellation', thread: 'g1' },
      { text: 'Decide whether to cancel phone order', thread: 'g1' },
    ];
    const failing: EmbedTexts = async () => {
      throw new Error('provider down');
    };
    expect(await run(items, failing)).toHaveLength(2);
  });
});
