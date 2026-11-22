/**
 * ADR 0019 — regex classifier unit tests.
 */
import { describe, expect, it } from 'vitest';

import { classifyEntity } from '@/services/catchup/classifier.service.js';

describe('classifyEntity', () => {
  it('routes Costco-style lists to shopping', () => {
    expect(classifyEntity({ type: 'list', primary: 'Costco list' })).toBe('shopping');
    expect(classifyEntity({ type: 'list', primary: 'Target run' })).toBe('shopping');
    expect(classifyEntity({ type: 'list', primary: 'Trader Joes' })).toBe('shopping');
    expect(classifyEntity({ type: 'list', primary: 'Grocery list' })).toBe('shopping');
  });

  it('routes recipe saves to recipes', () => {
    expect(
      classifyEntity({
        type: 'save',
        primary: 'Brown butter pasta',
        secondary: 'https://nytcooking.com/recipe/12345 recipe',
      }),
    ).toBe('recipes');
    expect(
      classifyEntity({ type: 'save', primary: 'Allrecipes link', secondary: 'allrecipes.com' }),
    ).toBe('recipes');
  });

  it('routes school-related to school', () => {
    expect(classifyEntity({ type: 'task', primary: 'Sign permission slip for field trip' })).toBe(
      'school',
    );
    expect(classifyEntity({ type: 'task', primary: 'PTA meeting' })).toBe('school');
  });

  it('routes doctor/dentist to health', () => {
    expect(classifyEntity({ type: 'task', primary: 'Book dentist appointment' })).toBe('health');
    expect(classifyEntity({ type: 'task', primary: 'Annual checkup' })).toBe('health');
  });

  it('trips always go to trips bucket', () => {
    expect(classifyEntity({ type: 'trip', primary: 'Random' })).toBe('trips');
    expect(classifyEntity({ type: 'trip', primary: 'Costco run' })).toBe('trips');
  });

  it('returns null when nothing matches', () => {
    expect(classifyEntity({ type: 'task', primary: 'do the thing' })).toBeNull();
    expect(classifyEntity({ type: 'list', primary: 'Random list' })).toBeNull();
  });
});
