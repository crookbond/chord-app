/**
 * Bulk-ness is a property of how mail was SENT, not what it is about (ADR 0109)
 * - a third axis beside the category tree and the ADR 0086 action. Money Stuff
 * genuinely is about finance AND is a blast; making one axis carry both is what
 * filed a ski sale under Newsletters > Recipes & food.
 *
 * Stored as a SIGNAL, never a verdict. Nothing acts on `bulk` alone, because
 * the negative is weak in both directions: transactional mass mail carries no
 * unsubscribe header by design, and Evite / Eventbrite / ParentSquare all set
 * one. Every consumer pairs it with a second condition.
 */

/** Per-message facts the rule reads. A null means the provider had no header to
 *  give (Outlook exposes none), never "the sender omitted it". */
export interface BulkSignals {
  listUnsubscribe: string | null;
  listId: string | null;
  labelIds: string[];
}

/**
 * One message, bulk-sent?
 *
 * `List-Unsubscribe` is the strong signal - Gmail and Yahoo have required it of
 * high-volume senders since Feb 2024 (RFC 8058), so the large senders set it.
 * `List-Id` (RFC 2919) is rarer and just as conclusive: only list software
 * writes it. `CATEGORY_PROMOTIONS` is Gmail's own verdict, and is what covers
 * the small senders who set no header at all.
 *
 * `Precedence: bulk` is deliberately NOT read. It can only ever corroborate a
 * decision one of the three above has already made, so storing it would be
 * storing a field that changes no outcome.
 */
export function isBulkSender(m: BulkSignals): boolean {
  if (m.listUnsubscribe?.trim()) return true;
  if (m.listId?.trim()) return true;
  return m.labelIds.includes('CATEGORY_PROMOTIONS');
}

/**
 * A thread is bulk only when EVERY message in it is.
 *
 * One ordinary message makes the thread a conversation, and a conversation is
 * never demoted - the user's own reply to a newsletter is engagement, and a
 * person writing into a list thread is a person waiting. Under-marking is the
 * safe direction: a bulk thread carried at full weight is noise, a conversation
 * treated as bulk is a message that never surfaces.
 */
export function isBulkThread(messages: BulkSignals[]): boolean {
  return messages.length > 0 && messages.every(isBulkSender);
}
