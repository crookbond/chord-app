/**
 * Smoke coverage for the scenario pool. Recipe scenarios are recent
 * additions and easy to delete by accident — these tests pin the basic
 * shape (inline → expectNoTool, browse → AllRecipes URL host) so a
 * future "tidy up the pool" PR can't silently regress the recipe answer
 * pattern.
 */
import { describe, expect, it } from 'vitest';

import { CHORD_PROMPTS } from '../scenarios.js';

describe('CHORD_PROMPTS — recipe inline scenarios', () => {
  const inline = CHORD_PROMPTS.filter((t) => t.expectNoTool === true);

  it('exists and has at least 4 phrasings', () => {
    expect(inline.length).toBeGreaterThanOrEqual(4);
  });

  it('every inline recipe scenario forbids suggest_external_action and save_media', () => {
    for (const t of inline) {
      expect(t.forbiddenTools).toBeDefined();
      expect(t.forbiddenTools).toContain('suggest_external_action');
      expect(t.forbiddenTools).toContain('save_media');
    }
  });

  it('uses the (none) sentinel as expectTool', () => {
    for (const t of inline) {
      expect(t.expectTool).toBe('(none)');
    }
  });
});

describe('CHORD_PROMPTS — recipe browse scenarios', () => {
  const browse = CHORD_PROMPTS.filter(
    (t) =>
      t.expectTool === 'suggest_external_action' &&
      t.expectUrlHost instanceof RegExp &&
      t.expectUrlHost.test('https://www.allrecipes.com/search?q=x'),
  );

  it('exists with at least one allrecipes-bound prompt', () => {
    expect(browse.length).toBeGreaterThanOrEqual(1);
  });

  it('forbids save_media (browse intent should never silently save)', () => {
    for (const t of browse) {
      expect(t.forbiddenTools).toContain('save_media');
    }
  });

  it('expects an action card kind', () => {
    for (const t of browse) {
      expect(t.expectCardKind).toBe('action');
    }
  });
});
