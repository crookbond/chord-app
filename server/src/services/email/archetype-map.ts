/**
 * ADR 0087 — deterministic category-path → tile archetype hint.
 * The LLM already chose the path; we only decide how to render it.
 */
import type { EmailTileArchetype } from '@chord/kernel';

export type PathHint = EmailTileArchetype | 'travel' | null;

/** Title path from root to this node (inclusive). */
export function titlesPath(
  byId: Map<string, { parent_id: string | null; title: string }>,
  id: string,
): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = byId.get(cur);
    if (!row) break;
    out.unshift(row.title);
    cur = row.parent_id;
  }
  return out;
}

/**
 * Preferred render shape for a category path. Travel is resolved later
 * (dated events → timeline, else live status → state board).
 */
export function pathHint(path: string[]): PathHint {
  if (path.length === 0) return null;
  const root = path[0].toLowerCase();
  const hay = path.join(' / ').toLowerCase();
  if (root === 'deliveries') return 'state_board';
  if (root === 'finance' || root === 'receipts') return 'ledger';
  if (root === 'travel') return 'travel';
  if (/\b(school|health|civic|kid|form)/.test(hay)) return 'timeline';
  if (root === 'friends & family' && /\b(playdate|invite|rsvp)/.test(hay)) return 'timeline';
  return null;
}

/** Only convert when extract actually produced facts of that kind. */
export function resolveArchetype(
  hint: PathHint,
  hasTimeline: boolean,
  hasState: boolean,
  hasLedger: boolean,
): EmailTileArchetype | null {
  if (hint === 'travel') {
    if (hasTimeline) return 'timeline';
    if (hasState) return 'state_board';
    return null;
  }
  if (hint === 'timeline' && hasTimeline) return 'timeline';
  if (hint === 'state_board' && hasState) return 'state_board';
  if (hint === 'ledger' && hasLedger) return 'ledger';
  return null;
}
