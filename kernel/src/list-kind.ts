/**
 * Pure helper for the catchup Lists view: infer a display "kind" from a
 * list's name so the card can show an icon/label. Lives in the kernel so
 * it's testable without a React-Native runtime.
 *
 * Note: lists render one-card-per-list (ADR 0058). There is intentionally
 * no cross-list/store consolidation or grocery bucketing — users keep
 * separate lists per store and want them shown that way.
 */

export type ListKindLabel = 'grocery' | 'packing' | 'todo' | 'list';

/**
 * Infer a kind label from a list's name. We don't persist a kind column;
 * the name pattern is stable enough for the demo. Used only for the card
 * icon — it does not group or merge lists.
 */
export function listKindLabel(name: string): ListKindLabel {
  const n = name.toLowerCase();
  if (/(grocer|market|pantry|costco|trader|whole\s?foods|safeway|walmart)/.test(n)) {
    return 'grocery';
  }
  if (/(pack|luggage|suitcase|trip kit)/.test(n)) return 'packing';
  if (/(todo|to-?do|tasks?)/.test(n)) return 'todo';
  return 'list';
}
