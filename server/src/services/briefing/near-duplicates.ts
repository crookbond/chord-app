/**
 * One line per thing in the briefing's email section, judged by MEANING, not
 * by matching words: "Wait for seller response about order cancellation" and
 * "Decide whether to cancel phone order … request cancellation" are the same
 * errand, and share almost no exact phrasing.
 *
 * Meaning alone is not enough, and the numbers say why. With the prod model
 * (text-embedding-3-small, 512 dims) "Pay water bill" / "Pay electric bill"
 * score 0.76 and "Sign Nolan's slip" / "Sign Ben's slip" 0.77 - different
 * things - while "Pay water bill" / "Pay the water bill before Friday" score
 * only 0.73 and the seller pair 0.55. No single cut-off separates them. So the
 * bar depends on where the two came from: two items from the SAME email that
 * mean roughly the same (>= 0.5) are one; items from different emails must be
 * near-identical (>= 0.85). Hiding a real, different to-do is worse than
 * showing one twice, so the cross-email bar is the high one.
 *
 * Identical wording (after case and punctuation) is one line without asking a
 * model, so a repeat still collapses when meaning search is off.
 */
import { sameWordsKey } from './compose.js';
import { cosine } from '../search/vectors.js';

export const SAME_SOURCE_MIN_SIMILARITY = 0.5;
export const ANY_SOURCE_MIN_SIMILARITY = 0.85;

/** Vectors for `texts`, in order; null when meaning search is unavailable. */
export type EmbedTexts = (texts: string[]) => Promise<Float32Array[] | null>;

export async function keepDistinct<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  sourceOf: (item: T) => string | null,
  embed?: EmbedTexts,
): Promise<T[]> {
  // Identical wording first: free, and it shrinks what the model is asked.
  const byWords = new Map<string, T>();
  for (const item of items) {
    const key = sameWordsKey(textOf(item));
    if (!byWords.has(key)) byWords.set(key, item);
  }
  const unique = [...byWords.values()];
  if (unique.length < 2 || !embed) return unique;

  let vectors: Float32Array[] | null = null;
  try {
    vectors = await embed(unique.map(textOf));
  } catch {
    vectors = null;
  }
  if (!vectors || vectors.length !== unique.length) return unique;

  const kept: number[] = [];
  for (let i = 0; i < unique.length; i++) {
    const src = sourceOf(unique[i]);
    const repeat = kept.some((k) => {
      const sameSource = !!src && src === sourceOf(unique[k]);
      const min = sameSource ? SAME_SOURCE_MIN_SIMILARITY : ANY_SOURCE_MIN_SIMILARITY;
      return cosine(vectors[i], vectors[k]) >= min;
    });
    if (!repeat) kept.push(i);
  }
  return kept.map((i) => unique[i]);
}
