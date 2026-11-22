/**
 * ADR 0061 — the dev fixture classifier's pure pieces (no DB).
 */
import { describe, expect, it } from 'vitest';

import { buildSnapshot, classifyThread } from '@/services/email/mock-classifier.js';
import { validateSnapshot } from '@/services/email/classification.service.js';

describe('classifyThread', () => {
  it('routes common mail into nested paths', () => {
    expect(classifyThread('no-reply@united.com', 'Your trip to SFO — check in now')).toEqual([
      'Travel',
      'Flights',
    ]);
    expect(classifyThread('no-reply@chase.com', 'Your April statement is ready')).toEqual([
      'Finance',
      'Credit card statements',
    ]);
    expect(classifyThread('ship@amazon.com', 'Your package is arriving today')).toEqual([
      'Deliveries',
      'Shipping updates',
    ]);
    expect(classifyThread('grandma@example.com', 'Sunday dinner?')).toEqual([
      'Friends & family',
      'Playdates & invites',
    ]);
  });

  it('leaves unmatchable mail unclassified', () => {
    expect(classifyThread('someone@nowhere.com', 'hey')).toBeNull();
  });
});

describe('buildSnapshot', () => {
  it('emits only used paths + ancestors and a valid tree', () => {
    const snap = buildSnapshot('u1', [
      { gmailThreadId: 't1', fromEmail: 'no-reply@united.com', subject: 'flight check in' },
      { gmailThreadId: 't2', fromEmail: 'ship@amazon.com', subject: 'order shipped' },
      { gmailThreadId: 't3', fromEmail: 'x@y.com', subject: 'nothing to match' },
    ]);
    expect(validateSnapshot(snap)).toEqual({ ok: true });
    // Travel + Flights + Deliveries + Shipping updates = 4 nodes; t3 dropped.
    expect(snap.categories).toHaveLength(4);
    expect(snap.assignments).toHaveLength(2);
    const roots = snap.categories.filter((c) => c.parentId === null).map((c) => c.title);
    expect(new Set(roots)).toEqual(new Set(['Travel', 'Deliveries']));
    // Top tiles carry a color; leaves don't.
    const travel = snap.categories.find((c) => c.title === 'Travel')!;
    expect(travel.color).toBeTruthy();
  });
});
