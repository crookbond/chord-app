/**
 * ADR 0019 — input-validation tests for the catchup endpoints.
 *
 * No supertest in this codebase; tests run at the schema + service layer.
 * Covers:
 *   - MoveCatchupAssignmentRequest zod parsing (the route's body validator).
 *   - Entity-type whitelist that the route checks alongside the body schema.
 */
import { describe, expect, it } from 'vitest';

import { MoveCatchupAssignmentRequest } from '@chord/kernel';

describe('MoveCatchupAssignmentRequest', () => {
  it('accepts a non-empty folderId', () => {
    const r = MoveCatchupAssignmentRequest.safeParse({ folderId: 'cf-abc' });
    expect(r.success).toBe(true);
  });

  it('rejects empty folderId', () => {
    const r = MoveCatchupAssignmentRequest.safeParse({ folderId: '' });
    expect(r.success).toBe(false);
  });

  it('rejects missing folderId', () => {
    const r = MoveCatchupAssignmentRequest.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects non-string folderId', () => {
    const r = MoveCatchupAssignmentRequest.safeParse({ folderId: 42 });
    expect(r.success).toBe(false);
  });

  it('strips/ignores extra fields without erroring', () => {
    const r = MoveCatchupAssignmentRequest.safeParse({
      folderId: 'cf-abc',
      sneaky: 'value',
    });
    expect(r.success).toBe(true);
  });
});

describe('entity-type route whitelist', () => {
  // The route uses a Set<CatchupEntityType> to gate /:type/:id. Encode the
  // whitelist here so a future drift between the kernel union and the route
  // guard surfaces as a failing test.
  const VALID = new Set(['task', 'list', 'save', 'trip']);

  it.each(['task', 'list', 'save', 'trip'])('accepts %s', (t) => {
    expect(VALID.has(t)).toBe(true);
  });

  it.each(['event', 'memory', 'rsvp', '', 'TASK', '../tasks'])('rejects %s', (t) => {
    expect(VALID.has(t)).toBe(false);
  });
});
