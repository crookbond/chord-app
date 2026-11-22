/**
 * ADR 0294 — the two `email_messages` columns the sender checks read, written
 * the same way from every provider.
 */
import type { SenderAuth } from '@chord/kernel';

export function senderHeaderColumns(h: { replyTo: string | null; authResults: SenderAuth | null }): {
  reply_to: string | null;
  auth_results: string | null;
} {
  return {
    reply_to: h.replyTo,
    auth_results: h.authResults ? JSON.stringify(h.authResults) : null,
  };
}
