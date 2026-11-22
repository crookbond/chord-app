/**
 * ADR 0311 addendum - a ✓ or ✕ on a suggestion goes through the shared send
 * queue (kind `proposal`): sent at once when the server answers, else kept and
 * sent when it does. Until then every read of suggestions shows it answered
 * (`setPendingProposalAnswers` in `api.ts`), so the card does not come back
 * from a saved copy. A refusal (already answered elsewhere, expired) stays in
 * the queue as failed, with its reason, for Retry or Discard.
 *
 * An invitation's Yes / Maybe / No is NOT queued: it is answered to the
 * organizer first (ADR 0104), and an unanswered invitation must keep looking
 * like one.
 */
import { useMemo } from 'react';
import type { PendingProposalAnswer, QueuedSend, RouteSuggestion } from '@chord/kernel';

import { confirmProposal, rejectProposal, setPendingProposalAnswers } from './api';
import { currentSendQueue, registerSender, sendOrQueue, useSendQueue } from './send-queue';

export interface ProposalAnswerPayload {
  /** The suggestion the server is told about; for a trip bundle, its anchor. */
  proposalId: string;
  /** Every suggestion this answer resolves (the bundle's members, else just the one). */
  memberIds: string[];
  action: 'confirm' | 'reject';
  targetGroupIds?: string[];
  calendarId?: string;
  /** ADR 0343 — "Move it": the existing event to move instead of adding one. */
  replaceEventId?: string;
  /** ADR 0348 — invite the card's guests too (the box on the card). */
  sendInvites?: boolean;
  /** What the card said, for the "not sent" list. */
  label: string;
}

const answeredListeners = new Set<() => void>();
/** The routing offer (ADR 0150) of the answer just sent, read by `answerProposal`. */
let lastRouteSuggestion: RouteSuggestion | undefined;

async function sendAnswer(p: ProposalAnswerPayload, sendId: string): Promise<void> {
  if (p.action === 'confirm') {
    const res = await confirmProposal(
      p.proposalId,
      p.targetGroupIds && p.targetGroupIds.length > 0 ? p.targetGroupIds : undefined,
      p.calendarId,
      sendId,
      p.replaceEventId,
      p.sendInvites,
    );
    lastRouteSuggestion = res.routeSuggestion;
  } else {
    await rejectProposal(p.proposalId, sendId);
  }
  for (const fn of answeredListeners) fn();
}

registerSender<ProposalAnswerPayload>('proposal', sendAnswer);

function waiting(queue: readonly QueuedSend[]): QueuedSend<ProposalAnswerPayload>[] {
  return queue.filter(
    (m): m is QueuedSend<ProposalAnswerPayload> => m.kind === 'proposal' && m.status === 'queued',
  );
}

function pendingFrom(queue: readonly QueuedSend[]): PendingProposalAnswer[] {
  return waiting(queue).map((m) => ({
    proposalIds: m.payload.memberIds,
    status: m.payload.action === 'confirm' ? 'confirmed' : 'rejected',
  }));
}

setPendingProposalAnswers(() => pendingFrom(currentSendQueue()));

/**
 * Answer a suggestion. Sent now, it carries the server's routing offer when
 * there was one; `queued` means it waits for the network. A refusal while
 * online is thrown, as before, for the card to show.
 */
export async function answerProposal(
  payload: ProposalAnswerPayload,
): Promise<{ queued: boolean; routeSuggestion?: RouteSuggestion }> {
  lastRouteSuggestion = undefined;
  const how = await sendOrQueue<ProposalAnswerPayload>('proposal', payload, sendAnswer);
  const routeSuggestion = how === 'sent' ? lastRouteSuggestion : undefined;
  lastRouteSuggestion = undefined;
  return { queued: how === 'queued', ...(routeSuggestion ? { routeSuggestion } : {}) };
}

/** Answers still waiting, to lay over what a screen shows. */
export function usePendingProposalAnswers(): PendingProposalAnswer[] {
  const queue = useSendQueue();
  return useMemo(() => pendingFrom(queue), [queue]);
}

/** Answers the server refused, waiting for Retry or Discard. */
export function useFailedProposalAnswers(): QueuedSend<ProposalAnswerPayload>[] {
  return useSendQueue().filter(
    (m): m is QueuedSend<ProposalAnswerPayload> => m.kind === 'proposal' && m.status === 'failed',
  );
}

/** Called after each answer the server took, so a screen can reload. */
export function onProposalAnswered(fn: () => void): () => void {
  answeredListeners.add(fn);
  return () => {
    answeredListeners.delete(fn);
  };
}
