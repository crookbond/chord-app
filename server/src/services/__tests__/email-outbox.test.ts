/**
 * ADR 0311 (email outbox addendum) - the email-only rules of the shared send
 * queue. Kernel has no harness of its own, so they are tested here. Ordering
 * and failure handling are the queue's and tested with it.
 */
import { describe, expect, it } from 'vitest';

import { outboxItemProblem, outboxSendPath } from '@chord/kernel';

describe('outboxSendPath', () => {
  it('sends each kind the way the composer does when online', () => {
    expect(outboxSendPath({ kind: 'new' })).toBe('send');
    expect(outboxSendPath({ kind: 'reply' })).toBe('reply');
    expect(outboxSendPath({ kind: 'forward' })).toBe('forward');
  });
});

describe('outboxItemProblem', () => {
  it('a reply needs its thread but not recipients', () => {
    expect(outboxItemProblem({ kind: 'reply', to: [], body: 'Yes', threadId: 't1' })).toBeNull();
    expect(outboxItemProblem({ kind: 'reply', to: [], body: 'Yes', threadId: null })).not.toBeNull();
  });

  it('a forward needs recipients but not a note', () => {
    expect(outboxItemProblem({ kind: 'forward', to: ['a@b.co'], body: '', threadId: 't1' })).toBeNull();
    expect(outboxItemProblem({ kind: 'forward', to: [], body: '', threadId: 't1' })).not.toBeNull();
  });

  it('a new message needs recipients and words', () => {
    expect(outboxItemProblem({ kind: 'new', to: ['a@b.co'], body: 'Hi' })).toBeNull();
    expect(outboxItemProblem({ kind: 'new', to: [], body: 'Hi' })).not.toBeNull();
    expect(outboxItemProblem({ kind: 'new', to: ['a@b.co'], body: '  ' })).not.toBeNull();
  });
});
