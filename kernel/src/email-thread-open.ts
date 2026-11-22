/**
 * Where an opened thread starts (ADR 0250). A thread with unread mail opens
 * at that mail: every unread message is unfolded and the reader lands on the
 * earliest of them, so a run of new replies reads in order. A thread with
 * nothing unread opens on its newest message (ADR 0121's default).
 *
 * Decided from the unread state as it was when the thread was OPENED: opening
 * marks it read, and re-deciding after that would fold the messages back.
 */
export interface ThreadOpenPlan {
  /** Messages unfolded when the thread opens. */
  open: string[];
  /** The message to scroll to, or null to start at the top. */
  scrollTo: string | null;
}

export function threadOpenPlan(messages: Array<{ id: string; isUnread: boolean }>): ThreadOpenPlan {
  if (messages.length === 0) return { open: [], scrollTo: null };
  const unread = messages.filter((m) => m.isUnread).map((m) => m.id);
  if (unread.length === 0) {
    const newest = messages[messages.length - 1]!.id;
    // A single message is the whole thread; it is already at the top.
    return { open: [newest], scrollTo: messages.length > 1 ? newest : null };
  }
  const first = unread[0]!;
  return { open: unread, scrollTo: first === messages[0]!.id ? null : first };
}
