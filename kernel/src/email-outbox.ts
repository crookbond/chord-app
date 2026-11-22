/**
 * ADR 0311 (email outbox addendum) - the email-only rules of the shared send
 * queue. Pure so they can be tested; `mobile/` has no harness.
 */

export type OutboxKind = 'new' | 'reply' | 'forward';

/** The call a queued email is sent with: the same one the composer makes online. */
export type OutboxSendPath = 'send' | 'reply' | 'forward';

export function outboxSendPath(p: { kind: OutboxKind }): OutboxSendPath {
  return p.kind === 'new' ? 'send' : p.kind;
}

/** Ready to send at all: somewhere to go and something to say. Null = fine. */
export function outboxItemProblem(p: {
  kind: OutboxKind;
  to: readonly string[];
  body: string;
  threadId?: string | null;
}): string | null {
  if (p.kind !== 'new' && !p.threadId) return 'The email it answers is missing.';
  if (p.kind !== 'reply' && p.to.length === 0) return 'Add at least one recipient.';
  if (p.kind !== 'forward' && !p.body.trim()) return 'The message is empty.';
  return null;
}
