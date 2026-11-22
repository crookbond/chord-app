/**
 * The briefing's greeting is written by code, once every part is known.
 * Failures being fixed: "Morning!" printed third, under the birthdays and the
 * weather; and "Morning! Nothing on the calendar needs attention today."
 * printed above a full email section.
 */
import { describe, expect, it } from 'vitest';

import {
  BRIEFING_GREETING,
  BRIEFING_NOTHING,
  cleanScanText,
  composeBriefing,
} from '@/services/briefing/compose.js';

const BIRTHDAYS = "🎂 Birthdays & anniversaries:\n• Tomorrow — Ben's birthday";
const WEATHER = '🌤 Seattle: 58°, light rain';
const EMAIL = '📬 Email\nWorth a look:\n  • School: Picture day';

describe('cleanScanText', () => {
  it('drops a greeting the model wrote anyway', () => {
    expect(cleanScanText("Morning! Here's what's on your radar:\n⏰ This week: dentist Tuesday")).toBe(
      '⏰ This week: dentist Tuesday',
    );
    expect(cleanScanText('Good morning!\n📋 Heads-up: passport')).toBe('📋 Heads-up: passport');
  });

  it('reads every form of "nothing" as nothing', () => {
    expect(cleanScanText('NOTHING')).toBe('');
    expect(cleanScanText('Morning! Nothing on the calendar needs attention today.')).toBe('');
    expect(cleanScanText('Nothing needs attention today.')).toBe('');
  });

  it('leaves a real briefing alone', () => {
    const s = '⏰ This week: nothing booked for the Vail trip yet';
    expect(cleanScanText(s)).toBe(s);
  });
});

describe('composeBriefing', () => {
  // Owner, 2026-10-24: weather comes before the birthdays.
  it('puts the greeting first, then the weather, then the birthdays', () => {
    const out = composeBriefing({
      celebrations: BIRTHDAYS,
      weather: WEATHER,
      scan: '⏰ This week: dentist Tuesday',
    });
    expect(out.split('\n')[0]).toBe(BRIEFING_GREETING);
    expect(out.indexOf(WEATHER)).toBeLessThan(out.indexOf(BIRTHDAYS));
    expect(out.indexOf(BIRTHDAYS)).toBeLessThan(out.indexOf('⏰ This week'));
  });

  it('does not say nothing needs attention when email or birthdays follow', () => {
    for (const parts of [{ scan: '', email: EMAIL }, { scan: '', celebrations: BIRTHDAYS }]) {
      const out = composeBriefing(parts);
      expect(out.startsWith(BRIEFING_GREETING)).toBe(true);
      expect(out).not.toMatch(/nothing/i);
    }
  });

  it('says nothing needs attention when only the weather is left', () => {
    expect(composeBriefing({ scan: '', weather: WEATHER })).toBe(`${BRIEFING_NOTHING}\n\n${WEATHER}`);
    expect(composeBriefing({ scan: '' })).toBe(BRIEFING_NOTHING);
  });
});
