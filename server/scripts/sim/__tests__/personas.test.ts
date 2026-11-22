import { describe, expect, it } from 'vitest';

import { PERSONAS, personasFor } from '../personas.js';

// personasFor lets the load sim scale past the curated pool by appending
// synthetic simuser_N accounts, while keeping the curated personas (and the
// john/alice anchors) at the front for small runs.
describe('personasFor', () => {
  it('returns the curated pool unchanged when count fits', () => {
    expect(personasFor(4)).toEqual(PERSONAS.slice(0, 4));
    expect(personasFor(4)[0]?.username).toBe('john');
    expect(personasFor(4)[1]?.username).toBe('alice');
  });

  it('returns exactly `count` personas when scaling past the curated pool', () => {
    const n = PERSONAS.length + 150;
    const out = personasFor(n);
    expect(out).toHaveLength(n);
    // Curated personas stay at the front (anchors observable in big runs too).
    expect(out.slice(0, PERSONAS.length)).toEqual(PERSONAS);
  });

  it('synthetic fillers have unique, non-empty usernames', () => {
    const n = PERSONAS.length + 300;
    const out = personasFor(n);
    const usernames = out.map((p) => p.username);
    expect(new Set(usernames).size).toBe(n);
    expect(usernames.every((u) => u.length > 0)).toBe(true);
  });
});
