/**
 * A reply the bot drafted (`reply_to_email` proposal), moved into the email's
 * own reply box so the user can edit it (ADR 0197 addendum).
 *
 * The proposal is closed BEFORE the composer opens: otherwise the same reply
 * could go out twice — once from the edited composer and once from a later ✓
 * on the card still sitting in chat. From then on the text is an ordinary
 * reply draft, autosaved like anything typed there.
 */
import { router } from 'expo-router';
import type { Proposal } from '@chord/kernel';

import { composeEmailReply, rejectProposal } from '@/api';
import { onSignOut } from '@/sign-out';

export interface ReplyDraft {
  threadId: string;
  body: string;
  replyAll: boolean;
}

export function replyDraftOf(p: Proposal): ReplyDraft | null {
  if (p.toolName !== 'reply_to_email') return null;
  try {
    const a = JSON.parse(p.argsJson) as { threadId?: unknown; body?: unknown; replyAll?: unknown };
    if (typeof a.threadId !== 'string' || !a.threadId) return null;
    return {
      threadId: a.threadId,
      body: typeof a.body === 'string' ? a.body : '',
      replyAll: a.replyAll === true,
    };
  } catch {
    return null;
  }
}

const pending = new Map<string, { body: string; replyAll: boolean }>();
onSignOut(() => pending.clear());

/** Close the proposal, then open the thread with its text in the reply box.
 *  Throws (and opens nothing) when the proposal could not be closed. */
export async function editReplyDraft(p: Proposal): Promise<void> {
  const draft = replyDraftOf(p);
  if (!draft) return;
  await rejectProposal(p.id);
  pending.set(draft.threadId, { body: draft.body, replyAll: draft.replyAll });
  router.push(`/email/${draft.threadId}` as Parameters<typeof router.push>[0]);
}

/**
 * ADR 0346 - draft a reply to this email from an instruction ("I can't make
 * it, here are other times") and open it in the email's reply box. Nothing is
 * sent; the draft is the user's to edit.
 */
export async function openDraftedReply(threadId: string, instruction: string): Promise<void> {
  const { body } = await composeEmailReply(threadId, { instruction });
  pending.set(threadId, { body, replyAll: false });
  router.push(`/email/${threadId}` as Parameters<typeof router.push>[0]);
}

/** The thread screen claims its hand-off once; a second read gets nothing. */
export function takeReplyDraft(threadId: string): { body: string; replyAll: boolean } | null {
  const d = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return d;
}
