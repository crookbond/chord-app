/**
 * localTimeBlock must include the current year and explicitly tell the
 * LLM to never pick a past year for bare dates. The 2026-05-13 regression
 * showed the LLM picking 2024 for "June 7"; the guidance here is the
 * counter-weight.
 */
import { describe, expect, it } from 'vitest';

import { __testing } from '@/services/bot/context.js';

const { localTimeBlock } = __testing;

describe('localTimeBlock', () => {
  it('declares the current year explicitly', () => {
    const out = localTimeBlock('UTC');
    const currentYear = new Date().getFullYear().toString();
    expect(out).toContain(`Today's year is ${currentYear}`);
  });

  it('coaches the model on parsing bare relative dates (no year given)', () => {
    const out = localTimeBlock('UTC');
    expect(out).toMatch(/bare date|June 7|next Friday|no year/i);
    expect(out).toMatch(/roll to the next occurrence|already passed/i);
  });

  it('carves out an exception so quoted dates from stored records keep their original year', () => {
    // Regression for the ICS-import case: an attachment summary in
    // context contains "September 26, 2016" and the LLM was re-rooting
    // it to 2026 because the year banner said "NEVER a past year".
    // Quoted facts must stay as written; only user-given relatives use
    // the current year.
    const out = localTimeBlock('UTC');
    expect(out).toMatch(/quoting|stored record|historical/i);
    expect(out).toMatch(/attachment|event from the system prompt|memory|saved item/i);
  });

  it('still emits the offset suffix used for datetime fields', () => {
    expect(localTimeBlock('UTC')).toMatch(/\+00:00/);
  });

  it('returns empty string for an invalid timezone (no throw)', () => {
    expect(localTimeBlock('Not/A_Zone')).toBe('');
  });
});
