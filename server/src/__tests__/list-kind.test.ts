/**
 * `listKindLabel` (catchup Lists card icon) and `normalizeText` (free-text
 * de-dup) live in @chord/kernel so they're testable without an RN runtime.
 * Lists render one-card-per-list (ADR 0058) — there is no cross-list/store
 * consolidation to test.
 */
import { describe, expect, it } from 'vitest';

import { listKindLabel, normalizeText } from '@chord/kernel';

describe('listKindLabel', () => {
  it('classifies grocery-ish names (stores, pantry, market)', () => {
    expect(listKindLabel('Walmart')).toBe('grocery');
    expect(listKindLabel('Costco list')).toBe('grocery');
    expect(listKindLabel("Trader Joe's")).toBe('grocery');
    expect(listKindLabel('Whole Foods')).toBe('grocery');
    expect(listKindLabel('grocery')).toBe('grocery');
    expect(listKindLabel('Pantry')).toBe('grocery');
  });

  it('classifies packing / todo / generic lists', () => {
    expect(listKindLabel('Packing list')).toBe('packing');
    expect(listKindLabel('Todo')).toBe('todo');
    expect(listKindLabel('To-do this week')).toBe('todo');
    expect(listKindLabel('Errands')).toBe('list');
    expect(listKindLabel('Date Spots')).toBe('list');
  });
});

describe('normalizeText', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeText('  Milk ')).toBe('milk');
    expect(normalizeText('Oat   Milk')).toBe('oat milk');
    expect(normalizeText('EGGS')).toBe('eggs');
  });
});
