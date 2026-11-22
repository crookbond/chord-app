/** ADR 0342 — what the delete-account box says about the user's plan. */
import { deleteAccountPlanNote } from '@chord/kernel';
import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const LIVE = '2026-12-01T00:00:00Z';

describe('deleteAccountPlanNote', () => {
  it('says nothing without a plan', () => {
    expect(deleteAccountPlanNote(null, NOW)).toBeNull();
    expect(deleteAccountPlanNote({}, NOW)).toBeNull();
  });

  it('says a Stripe plan is cancelled with no refund', () => {
    const note = deleteAccountPlanNote({ plan: 'system', source: 'stripe', periodEnd: LIVE }, NOW);
    expect(note).toMatch(/cancelled when you delete your account/);
    expect(note).toMatch(/no refund/);
  });

  it('sends an App Store subscriber to iPhone Settings, since Chord cannot cancel it', () => {
    const note = deleteAccountPlanNote({ plan: 'system', source: 'apple', periodEnd: LIVE }, NOW);
    expect(note).toMatch(/Chord cannot cancel it/);
    expect(note).toMatch(/Subscriptions/);
  });

  it('tells a family owner the members lose it too, and tells a member nothing', () => {
    const owner = deleteAccountPlanNote(
      { plan: 'family', source: 'stripe', periodEnd: LIVE, family: { role: 'owner' } as never },
      NOW,
    );
    expect(owner).toMatch(/Everyone on your family plan loses it/);
    expect(
      deleteAccountPlanNote({ plan: 'family', source: 'stripe', periodEnd: LIVE, family: { role: 'member' } as never }, NOW),
    ).toBeNull();
  });

  it('says nothing for a plan whose period already ended', () => {
    expect(deleteAccountPlanNote({ plan: 'system', source: 'stripe', periodEnd: '2026-11-01T00:00:00Z' }, NOW)).toBeNull();
  });
});
