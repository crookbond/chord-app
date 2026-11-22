import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two secrets (webhook tokens, clientState,
 * verify tokens). Both sides are hashed first so the comparison runs over
 * equal-length buffers whatever was presented: `timingSafeEqual` throws on a
 * length mismatch, and returning early on length would leak it. An empty or
 * missing expected value never matches.
 */
export function secretsEqual(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (expected.length === 0) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
