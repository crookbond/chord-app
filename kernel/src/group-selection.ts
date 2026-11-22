/**
 * ADR 0247 — which groups a suggestion goes to, picked on the card.
 *
 * `null` is "Just me": it clears every group. A group tap either adds to the
 * selection (`additive`: every tap on a phone, a Ctrl/⌘-click on the web) or
 * replaces it (a plain click on the web, like a file list). An additive tap on
 * a group already picked takes it back out.
 */
export function nextGroupSelection(
  current: readonly string[],
  id: string | null,
  additive: boolean,
): string[] {
  if (id === null) return [];
  if (!additive) return [id];
  return current.includes(id) ? current.filter((g) => g !== id) : [...current, id];
}
