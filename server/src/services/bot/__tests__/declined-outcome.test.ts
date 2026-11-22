/**
 * `declinedOutcome` is the generic check behind the tool-pill fix: a tool
 * call that ran without throwing but whose own result says nothing
 * happened (`created: false`, `updated: false`, …) must broadcast
 * `status: 'declined'`, not `'ok'` — see `iterative-loop.integration.test.ts`
 * for the end-to-end version pinning the real prod shape (a hallucinated,
 * self-contradictory `repeat` on `create_event`).
 */
import { describe, expect, it } from 'vitest';

import { declinedOutcome } from '@/services/bot/bot.service.js';

describe('declinedOutcome', () => {
  it('flags any recognized outcome key set to false', () => {
    expect(declinedOutcome({ created: false })).toBe(true);
    expect(declinedOutcome({ updated: false })).toBe(true);
    expect(declinedOutcome({ deleted: false })).toBe(true);
    expect(declinedOutcome({ cancelled: false })).toBe(true);
    expect(declinedOutcome({ merged: false })).toBe(true);
    expect(declinedOutcome({ sent: false })).toBe(true);
    expect(declinedOutcome({ added: false })).toBe(true);
  });

  it('does not flag a genuine success', () => {
    expect(declinedOutcome({ created: true, id: 'evt_1' })).toBe(false);
  });

  it('does not flag data with no recognized outcome key (a pure read, or an unrelated shape)', () => {
    expect(declinedOutcome({ items: [] })).toBe(false);
    expect(declinedOutcome({})).toBe(false);
  });

  it('does not flag non-object data', () => {
    expect(declinedOutcome(undefined)).toBe(false);
    expect(declinedOutcome(null)).toBe(false);
    expect(declinedOutcome('ok')).toBe(false);
  });

  it('flags a declined outcome even alongside other truthy fields', () => {
    // The actual bad_repeat shape: `created: false` sits beside `reason`,
    // `message` and `instruction` - the check must not be thrown off by them.
    expect(
      declinedOutcome({
        created: false,
        reason: 'bad_repeat',
        message: 'monthlyWeek only applies to a monthly repeat',
        instruction: 'Tell the user...',
      }),
    ).toBe(true);
  });
});
