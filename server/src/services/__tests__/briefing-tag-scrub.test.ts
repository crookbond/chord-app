/**
 * ADR 0110 — the tags in the scan context are notes to the model, not text for
 * the user. Prod shipped "Onam tomorrow [INFO_ONLY]." and "Raksha Bandhan on
 * 8/28 [INFO_ONLY]."
 *
 * The prompt now forbids printing them; this is the half that does not depend
 * on the model complying (ADR 0100/0102).
 */
import { describe, expect, it } from 'vitest';

import { stripContextTags } from '@/services/proactive.service.js';

describe('stripContextTags', () => {
  it('removes the tags that reached prod', () => {
    expect(stripContextTags('- Onam tomorrow [INFO_ONLY].')).toBe('- Onam tomorrow.');
    expect(stripContextTags('- Raksha Bandhan on 8/28 [INFO_ONLY].')).toBe(
      '- Raksha Bandhan on 8/28.',
    );
  });

  it('removes the rest of the vocabulary, payload and all', () => {
    expect(stripContextTags('- Passport renewal [OVERDUE]')).toBe('- Passport renewal');
    expect(stripContextTags('- 3 to-dos [STALE] to review')).toBe('- 3 to-dos to review');
    // A dangling `OVERLAPS_WITH:` with its value left behind reads worse than
    // the whole tag did.
    expect(stripContextTags('- Dentist 2pm OVERLAPS_WITH:e_123 today')).toBe(
      '- Dentist 2pm today',
    );
    expect(stripContextTags('- Flight Friday DURING_TRIP:"Detroit" — pack')).toBe(
      '- Flight Friday — pack',
    );
  });

  it('leaves the user’s own brackets alone', () => {
    // Why this is matched by NAME rather than by shape: a general [...] strip
    // would eat this.
    expect(stripContextTags('- Dinner [rescheduled] to Thursday')).toBe(
      '- Dinner [rescheduled] to Thursday',
    );
    expect(stripContextTags('- Read [The Overstory] before book club')).toBe(
      '- Read [The Overstory] before book club',
    );
  });

  it('passes ordinary briefings through untouched', () => {
    const briefing = 'Morning! Here’s what’s on your radar:\n⏰ This week: dentist Tuesday';
    expect(stripContextTags(briefing)).toBe(briefing);
  });

  it('keeps null meaning null, and never returns an empty string', () => {
    // A body that was nothing but a tag is not a briefing; the caller's
    // "render returned empty" path must still fire.
    expect(stripContextTags(null)).toBeNull();
    expect(stripContextTags('[INFO_ONLY]')).toBeNull();
  });
});
