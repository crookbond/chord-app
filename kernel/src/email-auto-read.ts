/**
 * Which messages of an open thread the reader marks read: message by message,
 * as each one is seen. A message is seen when it is open (not folded to one
 * line) and enough of it is on screen. Reopening a thread and scrolling
 * through it marks every message; one never scrolled to stays unread.
 *
 * This replaced marking the whole thread once on open, which missed a reply
 * that arrived while the email was on screen (it remembered it had marked the
 * thread). A manual "Mark unread" still sticks: messages already sent from
 * this screen are not sent again.
 */

/** Where a message card sits in the scrolled content. */
export interface MessageBox {
  id: string;
  y: number;
  height: number;
}

/** How much of a card must be on screen (or all of it, when shorter). */
export const SEEN_MIN_PX = 60;

/** Ids of the cards with enough of themselves inside the view. */
export function messagesOnScreen(
  boxes: readonly MessageBox[],
  scrollY: number,
  viewportHeight: number,
): string[] {
  if (viewportHeight <= 0) return [];
  const top = scrollY;
  const bottom = scrollY + viewportHeight;
  return boxes
    .filter((b) => {
      const shown = Math.min(b.y + b.height, bottom) - Math.max(b.y, top);
      return shown > 0 && shown >= Math.min(SEEN_MIN_PX, b.height);
    })
    .map((b) => b.id);
}

/** The messages to mark read now: on screen, open, unread, not already sent. */
export function messagesToMarkRead(
  messages: ReadonlyArray<{ id: string; isUnread: boolean }>,
  onScreen: readonly string[],
  isOpen: (id: string) => boolean,
  alreadySent: ReadonlySet<string>,
): string[] {
  const visible = new Set(onScreen);
  return messages
    .filter((m) => m.isUnread && visible.has(m.id) && isOpen(m.id) && !alreadySent.has(m.id))
    .map((m) => m.id);
}
