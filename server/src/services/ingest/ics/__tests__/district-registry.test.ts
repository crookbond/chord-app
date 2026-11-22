import { describe, expect, it } from 'vitest';

import { resolveDistrictCalendar } from '../district-registry.js';

describe('resolveDistrictCalendar', () => {
  it('resolves a seeded district by full name', () => {
    const hit = resolveDistrictCalendar('Fairfax County Public Schools');
    expect(hit?.label).toMatch(/Fairfax/);
    expect(hit?.url).toMatch(/^https?:\/\//);
  });

  it('is case- and whitespace-insensitive', () => {
    const a = resolveDistrictCalendar('  fairfax county  ');
    const b = resolveDistrictCalendar('FAIRFAX COUNTY');
    expect(a?.url).toBeDefined();
    expect(a?.url).toBe(b?.url);
  });

  it('matches an abbreviation alias', () => {
    expect(resolveDistrictCalendar('FCPS')?.label).toMatch(/Fairfax/);
    expect(resolveDistrictCalendar('mcps')?.label).toMatch(/Montgomery/);
  });

  it('ignores filler words like "schools" / "district"', () => {
    expect(resolveDistrictCalendar('Fairfax schools')?.label).toMatch(/Fairfax/);
  });

  it('returns null for an unknown district', () => {
    expect(resolveDistrictCalendar('Springfield Elementary')).toBeNull();
  });

  it('returns null for empty / garbage input', () => {
    expect(resolveDistrictCalendar('')).toBeNull();
    expect(resolveDistrictCalendar('   ')).toBeNull();
    expect(resolveDistrictCalendar('!!!')).toBeNull();
  });
});
