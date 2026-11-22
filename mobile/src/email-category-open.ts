/**
 * Opening an email from a category in the AI view (Feed, Cards, Sections):
 * "next" and removing an email stay inside that category's unread mail, and
 * the walk returns to the view it started from after the last one.
 */
import { router } from 'expo-router';
import {
  categoryNavOrder,
  withoutRemoved,
  type CategoryNavThread,
  type EmailThreadSummary,
} from '@chord/kernel';

import { listEmailThreads, threadPageCursor } from '@/api';
import { useEmailThreadNav } from '@/email-thread-nav';

/** Pages read per category; a category with more unread than this ends early. */
const MAX_PAGES = 4;

let seq = 0;

async function categoryThreads(categoryId: string): Promise<CategoryNavThread[]> {
  const out: CategoryNavThread[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows: EmailThreadSummary[] = await listEmailThreads({
      mode: 'category',
      category: categoryId,
      ...(cursor ? { cursor } : {}),
    });
    for (const r of rows) out.push({ id: r.id, isUnread: r.isUnread, lastMessageAt: r.lastMessageAt });
    if (rows.length < 50) break;
    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = threadPageCursor(last);
  }
  return out;
}

export function openFromCategory(categoryIds: string[], threadId: string): void {
  const mine = ++seq;
  // The tapped email alone until the category arrives, so the reader never
  // borrows the Traditional list's order meanwhile.
  useEmailThreadNav.getState().setNav([threadId], false, null, 'category');
  router.push(`/email/${threadId}`);
  const askedAt = Date.now();
  void Promise.all(categoryIds.map(categoryThreads))
    .then((lists) => {
      const nav = useEmailThreadNav.getState();
      // A later open (or the Traditional list) has taken over since.
      if (mine !== seq || nav.scope !== 'category') return;
      // Emails put away from here are left out - including ones whose write
      // was still in flight when this listing was asked for, which a
      // previous walk through the same category leaves behind.
      const ids = withoutRemoved(
        categoryNavOrder(threadId, lists.flat()),
        (id) => id,
        nav,
        askedAt,
      );
      nav.setNav(ids, false, null, 'category');
    })
    .catch(() => {});
}
