import { describe, expect, it } from 'vitest';
import { INTRO_SEEN_KEY, INTRO_SLIDES, KEPT_ON_SIGN_OUT, shouldShowIntro } from '@chord/kernel';

describe('shouldShowIntro', () => {
  const base = { introSeen: false, signedIn: true, consentNeeded: true, native: true };

  it('shows once to someone who has not answered AI consent yet', () => {
    expect(shouldShowIntro(base)).toBe(true);
    expect(shouldShowIntro({ ...base, introSeen: true })).toBe(false);
  });

  it('never shows to someone who already answered consent', () => {
    expect(shouldShowIntro({ ...base, consentNeeded: false })).toBe(false);
  });

  it('is the first thing on a fresh phone, before the sign-in page', () => {
    expect(shouldShowIntro({ ...base, signedIn: false, consentNeeded: false })).toBe(true);
    expect(shouldShowIntro({ ...base, signedIn: false, introSeen: true })).toBe(false);
  });

  it('does not cover the web marketing page when signed out', () => {
    expect(shouldShowIntro({ ...base, signedIn: false, native: false })).toBe(false);
    expect(shouldShowIntro({ ...base, native: false })).toBe(true);
  });
});

describe('intro slides', () => {
  it('have unique keys and text', () => {
    const keys = INTRO_SLIDES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of INTRO_SLIDES) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  it('the seen flag survives sign-out', () => {
    expect(KEPT_ON_SIGN_OUT).toContain(INTRO_SEEN_KEY);
  });
});
