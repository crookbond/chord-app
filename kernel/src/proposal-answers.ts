/**
 * ADR 0311 addendum - a ✓ or ✕ on a suggestion made offline waits in the send
 * queue (kind `proposal`). Until the server has it, every list that shows
 * suggestions shows it as answered, so a reload from the saved copy does not
 * bring the card back. Pure so it can be tested; `mobile/` has no harness.
 */

export interface PendingProposalAnswer {
  /** Every suggestion the tap answers (a trip bundle is answered as one). */
  proposalIds: readonly string[];
  status: 'confirmed' | 'rejected';
}

/** Suggestions with their waiting answers applied; the latest answer to one wins. */
export function applyPendingProposalAnswers<P extends { id: string; status: string }>(
  proposals: readonly P[],
  pending: readonly PendingProposalAnswer[],
): P[] {
  if (pending.length === 0) return [...proposals];
  const answered = new Map<string, PendingProposalAnswer['status']>();
  for (const a of pending) for (const id of a.proposalIds) answered.set(id, a.status);
  return proposals.map((p) => {
    const status = answered.get(p.id);
    return status && p.status === 'pending' ? { ...p, status } : p;
  });
}

/** The ids a waiting answer covers, to leave out of lists that show only open suggestions. */
export function pendingAnsweredIds(pending: readonly PendingProposalAnswer[]): Set<string> {
  const ids = new Set<string>();
  for (const a of pending) for (const id of a.proposalIds) ids.add(id);
  return ids;
}

/**
 * The To Do's tabs are kept for offline use whenever the app is online and
 * signed in, not only when a tab is opened; at most once per `minGapMs`.
 */
export function shouldWarmSavedCopies(a: {
  online: boolean;
  signedIn: boolean;
  lastWarmAt: number | null;
  now: number;
  minGapMs: number;
}): boolean {
  if (!a.online || !a.signedIn) return false;
  return a.lastWarmAt === null || a.now - a.lastWarmAt >= a.minGapMs;
}
