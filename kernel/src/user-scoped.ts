/**
 * What the phone keeps for one signed-in person (the send queue, drafts kept
 * on the phone, to-do sync notices) must never reach another: not shown to
 * them, not merged into their saved copy, not sent with their session. Each
 * entry carries the id of the person it was made for. Pure so it can be
 * tested; `mobile/` has no harness.
 */

export interface UserTagged {
  /** Who it was made for. Absent only on entries saved before this field existed. */
  uid?: string | null;
}

/**
 * What a store holds once it has read `uid`'s saved copy: that copy (saved in
 * their own folder, so theirs, tagged or not) plus whatever is held in memory
 * for the same person. Anything held for someone else, or for nobody, is left
 * behind.
 */
export function mergeForUser<T extends UserTagged>(a: {
  uid: string;
  stored: readonly T[];
  held: readonly T[];
  key: (t: T) => string;
  /** Which copy wins when both have the same key. */
  prefer: 'stored' | 'held';
}): T[] {
  const stored = a.stored.map((t) => ({ ...t, uid: a.uid }));
  const held = a.held.filter((t) => t.uid === a.uid);
  const [first, second] = a.prefer === 'stored' ? [stored, held] : [held, stored];
  const known = new Set(first.map(a.key));
  return [...first, ...second.filter((t) => !known.has(a.key(t)))];
}

/** Only the entries made for `uid` (none when nobody is signed in). */
export function onlyForUser<T extends UserTagged>(items: readonly T[], uid: string | null): T[] {
  if (!uid) return [];
  return items.filter((t) => t.uid === uid);
}
