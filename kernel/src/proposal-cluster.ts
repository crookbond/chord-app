/**
 * Group pending proposals by the email they came from — a view, never a write
 * (ADR 0094's rule for the Lists tab, applied to Action Items).
 *
 * One thread routinely yields several rows: magics contributes at most one, but
 * person extraction adds a person and each of their dates, all stamped with the
 * same `gmail:<threadId>`. Rendered flat, one email reads as a pile of
 * unrelated demands.
 *
 * Clustering is NOT bundling. An ADR 0029 `bundleId` means "these must resolve
 * together" — a trip and its legs, confirmed by one tap. These are independent
 * decisions that merely share a source, so each keeps its own confirm/reject
 * and its own ADR 0097 group choice. Merging them would silently widen one tap
 * into several.
 *
 * Lives in kernel so the grouping rule is testable and can't drift if a second
 * surface (the briefing, the tile sheet) ever needs it.
 */
import type { Proposal } from './types/proposal';

export interface ProposalCluster {
  /** Stable per source — the provenance, or the proposal id when it has none. */
  key: string;
  /** The email's subject, when the server could resolve it. */
  label: string | null;
  /** In-app path to the source (ADR 0059), when resolvable. */
  href: string | null;
  members: Proposal[];
}

/**
 * Clusters in first-appearance order, members in the order given — the caller's
 * sort is the one the user sees, and grouping must not reorder it.
 *
 * A proposal with no provenance is its own cluster: two chat-born proposals are
 * not "from the same place" just because neither names one.
 */
export function clusterProposalsBySource(pending: Proposal[]): ProposalCluster[] {
  const byKey = new Map<string, ProposalCluster>();
  for (const p of pending) {
    const key = p.provenance ?? `id:${p.id}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.members.push(p);
      // Rows from one thread should agree, but a row whose source was deleted
      // resolves to null — so take the first non-null rather than the first.
      seen.label = seen.label ?? p.sourceLabel ?? null;
      seen.href = seen.href ?? p.sourceHref ?? null;
    } else {
      byKey.set(key, {
        key,
        label: p.sourceLabel ?? null,
        href: p.sourceHref ?? null,
        members: [p],
      });
    }
  }
  return Array.from(byKey.values());
}

/**
 * One thing the user decides. A bundle IS one decision — the server confirms
 * or rejects every sibling on any member's tap (ADR 0009/0029) — so showing
 * its members as separate cards offers taps that do nothing and leaves rows
 * behind after the one that did. Everything else stays its own decision.
 */
export type ProposalDecision =
  | { kind: 'single'; key: string; proposal: Proposal }
  | { kind: 'bundle'; key: string; members: Proposal[] };

/** Decisions in first-appearance order; a bundle sits where its first member did. */
export function proposalDecisions(members: Proposal[]): ProposalDecision[] {
  const out: ProposalDecision[] = [];
  const bundles = new Map<string, Proposal[]>();
  for (const p of members) {
    if (!p.bundleId) {
      out.push({ kind: 'single', key: p.id, proposal: p });
      continue;
    }
    const seen = bundles.get(p.bundleId);
    if (seen) {
      seen.push(p);
      continue;
    }
    const list = [p];
    bundles.set(p.bundleId, list);
    out.push({ kind: 'bundle', key: `bundle:${p.bundleId}`, members: list });
  }
  return out;
}

/** Every proposal id a decision resolves — what to clear once it is answered. */
export function decisionProposalIds(d: ProposalDecision): string[] {
  return d.kind === 'single' ? [d.proposal.id] : d.members.map((m) => m.id);
}
