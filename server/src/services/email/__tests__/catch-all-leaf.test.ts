/**
 * The classifier keeps inventing a catch-all leaf under every tile — "Personal
 * notes" most often — even though the prompt forbids it by name. Same shape as
 * ADR 0100 and 0102: the instruction is right, and an instruction the model can
 * ignore is not an invariant, so the rule is enforced where paths become tiles.
 *
 * What must NOT regress is the other half — real leaves whose titles merely
 * contain a catch-all word ("School notes") and the one listed leaf that IS a
 * dumping ground on purpose ("Newsletters → Junk").
 */
import { describe, expect, it } from 'vitest';

import { buildTreeFromPaths, trimCatchAllLeaf } from '../classifier-tree.js';

describe('trimCatchAllLeaf', () => {
  it('drops an invented catch-all leaf, leaving the parent tile', () => {
    expect(trimCatchAllLeaf(['Friends & family', 'Personal notes'])).toEqual(['Friends & family']);
    expect(trimCatchAllLeaf(['Finance', 'Other'])).toEqual(['Finance']);
    expect(trimCatchAllLeaf(['Travel', 'Miscellaneous'])).toEqual(['Travel']);
    expect(trimCatchAllLeaf(['Deliveries', 'General'])).toEqual(['Deliveries']);
  });

  it('matches the whole title, never a substring', () => {
    // The exact leaf the illustrative taxonomy lists under Friends & family.
    expect(trimCatchAllLeaf(['Friends & family', 'School notes'])).toEqual([
      'Friends & family',
      'School notes',
    ]);
    expect(trimCatchAllLeaf(['Travel', 'Itineraries & confirmations'])).toEqual([
      'Travel',
      'Itineraries & confirmations',
    ]);
  });

  it('keeps "Newsletters → Junk", which is a listed leaf and not an invention', () => {
    expect(trimCatchAllLeaf(['Newsletters', 'Junk'])).toEqual(['Newsletters', 'Junk']);
  });

  it('never trims to nothing — a bare catch-all top stays classified', () => {
    // Trimming this to [] would unclassify the thread, and an unclassified
    // thread is skipped by the magics pass entirely. Filed beats vanished.
    expect(trimCatchAllLeaf(['Other'])).toEqual(['Other']);
  });

  it('collapses a stack of them', () => {
    expect(trimCatchAllLeaf(['Finance', 'Misc', 'Other'])).toEqual(['Finance']);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(trimCatchAllLeaf(['Finance', '  personal NOTES '])).toEqual(['Finance']);
  });
});

describe('buildTreeFromPaths applies the rule', () => {
  it('never creates a node for the invented leaf, and files the thread on the parent', () => {
    const { categories, assignments } = buildTreeFromPaths([
      { gmailThreadId: 't1', path: ['Friends & family', 'Personal notes'] },
      { gmailThreadId: 't2', path: ['Friends & family', 'School notes'] },
    ]);

    expect(categories.map((c) => c.title).sort()).toEqual(['Friends & family', 'School notes']);
    // t1 lands on the parent tile rather than a leaf of its own.
    const parent = categories.find((c) => c.title === 'Friends & family')!;
    expect(assignments.find((a) => a.gmailThreadId === 't1')!.categoryId).toBe(parent.id);
    expect(assignments.find((a) => a.gmailThreadId === 't2')!.categoryId).not.toBe(parent.id);
  });
});
