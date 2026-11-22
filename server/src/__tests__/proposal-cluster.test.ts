/**
 * Action Items groups pending proposals by the email behind them (bug 12).
 * A view, never a write: each proposal keeps its own confirm/reject, so this
 * must not reorder, merge, or invent membership.
 */
import { describe, expect, it } from 'vitest';

import {
  clusterProposalsBySource,
  decisionProposalIds,
  proposalDecisions,
  type Proposal,
} from '@chord/kernel';

const p = (over: Partial<Proposal> & { id: string }): Proposal =>
  ({
    groupId: 'g1',
    proposedByUserId: 'u1',
    proposedByMessageId: null,
    toolName: 'add_person',
    argsJson: '{}',
    provenance: null,
    targetGroupId: null,
    status: 'pending',
    resolvedByUserId: null,
    resolvedByMessageId: null,
    resolvedAt: null,
    bundleId: null,
    expiresAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-24T00:00:00.000Z',
    ...over,
  }) as Proposal;

describe('clusterProposalsBySource', () => {
  it('gathers proposals sharing a thread and keeps every member', () => {
    const clusters = clusterProposalsBySource([
      p({ id: 'a', provenance: 'gmail:t1', sourceLabel: 'Class list', sourceHref: '/email/e1' }),
      p({ id: 'b', provenance: 'gmail:t1' }),
      p({ id: 'c', provenance: 'gmail:t1' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(clusters[0].label).toBe('Class list');
    expect(clusters[0].href).toBe('/email/e1');
  });

  it('preserves caller order for both clusters and members', () => {
    const clusters = clusterProposalsBySource([
      p({ id: 'a', provenance: 'gmail:t2' }),
      p({ id: 'b', provenance: 'gmail:t1' }),
      p({ id: 'c', provenance: 'gmail:t2' }),
    ]);
    expect(clusters.map((c) => c.key)).toEqual(['gmail:t2', 'gmail:t1']);
    expect(clusters[0].members.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('takes the first NON-NULL label — a deleted source resolves to null', () => {
    const clusters = clusterProposalsBySource([
      p({ id: 'a', provenance: 'gmail:t1' }),
      p({ id: 'b', provenance: 'gmail:t1', sourceLabel: 'Soccer sign-up', sourceHref: '/email/e1' }),
    ]);
    expect(clusters[0].label).toBe('Soccer sign-up');
    expect(clusters[0].href).toBe('/email/e1');
  });

  it('never merges proposals that just both lack a provenance', () => {
    const clusters = clusterProposalsBySource([p({ id: 'a' }), p({ id: 'b' })]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.key)).toEqual(['id:a', 'id:b']);
  });

  it('leaves a lone proposal as a one-member cluster', () => {
    const clusters = clusterProposalsBySource([p({ id: 'a', provenance: 'gmail:t1' })]);
    expect(clusters).toEqual([
      expect.objectContaining({ key: 'gmail:t1', members: [expect.objectContaining({ id: 'a' })] }),
    ]);
  });

  it('is empty for no input', () => {
    expect(clusterProposalsBySource([])).toEqual([]);
  });
});

describe('proposalDecisions', () => {
  // Prod 2026-10-30: one Chase booking email (Southwest WN 921 / WN 982,
  // 2EYATQ) staged a trip bundle of three proposals. Action Items showed three
  // cards; confirming one confirmed the bundle and left two dead cards behind.
  const src = 'gmail:ema_jkPXgnLuMHPM:AQQkADAwATExAGI4Ny00YzQwLTE5NmYtMDACLTAwCgAQAPIsfht7nPZFqlbiwD7oVBU=';
  const chase = [
    p({ id: 'prop_5VrX3XN2riDl', toolName: 'create_trip', provenance: src, bundleId: 'bundle_ukOb-xT1IKDM' }),
    p({ id: 'prop_4fBbIa8tjfeL', toolName: 'add_travel_leg', provenance: src, bundleId: 'bundle_ukOb-xT1IKDM' }),
    p({ id: 'prop_M1Dvs7ThlyTA', toolName: 'add_travel_leg', provenance: src, bundleId: 'bundle_ukOb-xT1IKDM' }),
  ];

  it('makes one trip email one decision that clears every part', () => {
    const [cluster] = clusterProposalsBySource(chase);
    const decisions = proposalDecisions(cluster!.members);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.kind).toBe('bundle');
    expect(decisionProposalIds(decisions[0]!)).toEqual([
      'prop_5VrX3XN2riDl',
      'prop_4fBbIa8tjfeL',
      'prop_M1Dvs7ThlyTA',
    ]);
  });

  it('keeps unbundled suggestions from the same email as their own decisions, in order', () => {
    const person = p({ id: 'pp', toolName: 'add_person', provenance: src });
    const decisions = proposalDecisions([chase[0]!, person, chase[1]!, chase[2]!]);
    expect(decisions.map((d) => d.kind)).toEqual(['bundle', 'single']);
    expect(decisions.map((d) => decisionProposalIds(d))).toEqual([
      ['prop_5VrX3XN2riDl', 'prop_4fBbIa8tjfeL', 'prop_M1Dvs7ThlyTA'],
      ['pp'],
    ]);
  });

  it('keeps two bundles from two emails apart', () => {
    const other = p({ id: 'prop_jemu_jjYZjIY', toolName: 'create_trip', provenance: 'gmail:x', bundleId: 'bundle_C5dKgSyl-_Ww' });
    expect(proposalDecisions([...chase, other]).map((d) => d.key)).toEqual([
      'bundle:bundle_ukOb-xT1IKDM',
      'bundle:bundle_C5dKgSyl-_Ww',
    ]);
  });
});
