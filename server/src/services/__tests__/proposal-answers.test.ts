/**
 * ADR 0311 addendum - suggestions answered offline stay answered on screen
 * until the server has the answer, and the To Do's copies are refreshed while
 * online whichever tab is open.
 */
import {
  applyPendingProposalAnswers,
  pendingAnsweredIds,
  shouldWarmSavedCopies,
} from '@chord/kernel';
import { describe, expect, it } from 'vitest';

const p = (id: string, status = 'pending') => ({ id, status });

describe('applyPendingProposalAnswers', () => {
  it('shows a waiting ✓ or ✕ as answered', () => {
    const out = applyPendingProposalAnswers(
      [p('a'), p('b'), p('c')],
      [
        { proposalIds: ['a'], status: 'confirmed' },
        { proposalIds: ['b'], status: 'rejected' },
      ],
    );
    expect(out.map((x) => x.status)).toEqual(['confirmed', 'rejected', 'pending']);
  });

  it('answers every member of a trip bundle at once', () => {
    const out = applyPendingProposalAnswers(
      [p('trip'), p('leg1'), p('leg2'), p('other')],
      [{ proposalIds: ['trip', 'leg1', 'leg2'], status: 'confirmed' }],
    );
    expect(out.filter((x) => x.status === 'confirmed').map((x) => x.id)).toEqual(['trip', 'leg1', 'leg2']);
  });

  it('leaves a suggestion the server already answered as the server says', () => {
    const out = applyPendingProposalAnswers(
      [p('a', 'expired')],
      [{ proposalIds: ['a'], status: 'confirmed' }],
    );
    expect(out[0]!.status).toBe('expired');
  });

  it('the latest answer to the same suggestion wins', () => {
    const out = applyPendingProposalAnswers(
      [p('a')],
      [
        { proposalIds: ['a'], status: 'confirmed' },
        { proposalIds: ['a'], status: 'rejected' },
      ],
    );
    expect(out[0]!.status).toBe('rejected');
  });

  it('names the ids a waiting answer covers', () => {
    expect([...pendingAnsweredIds([{ proposalIds: ['x', 'y'], status: 'rejected' }])]).toEqual(['x', 'y']);
  });
});

describe('shouldWarmSavedCopies', () => {
  const base = { online: true, signedIn: true, lastWarmAt: null, now: 1_000_000, minGapMs: 300_000 };

  it('refreshes at launch, whichever tab is open', () => {
    expect(shouldWarmSavedCopies(base)).toBe(true);
  });

  it('waits while offline or signed out', () => {
    expect(shouldWarmSavedCopies({ ...base, online: false })).toBe(false);
    expect(shouldWarmSavedCopies({ ...base, signedIn: false })).toBe(false);
  });

  it('refreshes at most once per gap', () => {
    expect(shouldWarmSavedCopies({ ...base, lastWarmAt: base.now - 60_000 })).toBe(false);
    expect(shouldWarmSavedCopies({ ...base, lastWarmAt: base.now - 300_000 })).toBe(true);
  });
});
