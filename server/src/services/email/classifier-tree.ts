/**
 * Shared path → CategoryNode helpers for mock + LLM classifiers.
 * Stable slug ids (`mk:travel/flights`) keep tiles from churning across runs.
 */
import type { CategoryNode, EmailAction, ThreadAssignment } from '@chord/kernel';

/** Top-tile tints — mirror the illustrative taxonomy in the email-reader plan. */
export const TOP_COLOR: Record<string, string> = {
  Finance: '#378ADD',
  Travel: '#1D9E75',
  Deliveries: '#D85A30',
  'Friends & family': '#D4537E',
  'Social & professional': '#20648B',
  'Events & invites': '#B34A78',
  Receipts: '#BA7517',
  Coupons: '#7F77DD',
  Newsletters: '#5F5E5A',
  'Recipes / forwards': '#639922',
};

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Classifier-stable id for a title path (e.g. Travel/Flights → mk:travel/flights). */
export function categoryIdForPath(path: string[]): string {
  return `mk:${path.map(slug).join('/')}`;
}

/**
 * Ensure every segment of `path` exists in `categories`; return the leaf id.
 * Mutates the map in place.
 */
export function ensurePath(
  categories: Map<string, CategoryNode>,
  path: string[],
): string {
  let parentId: string | null = null;
  let id = '';
  for (let depth = 0; depth < path.length; depth++) {
    id = categoryIdForPath(path.slice(0, depth + 1));
    if (!categories.has(id)) {
      categories.set(id, {
        id,
        parentId,
        title: path[depth],
        depth,
        sortOrder: categories.size,
        color: depth === 0 ? TOP_COLOR[path[0]] ?? null : null,
        icon: null,
        gmailLabelId: null,
      });
    }
    parentId = id;
  }
  return id;
}

/**
 * Catch-all leaf titles the classifier keeps inventing despite being told not
 * to. The prompt rule ("a thread that fits the parent but no listed leaf gets
 * the PARENT path alone") needed a choke point, same as the ADR 0100 timezone
 * rule and the ADR 0102 empty-uid rule: an instruction the model can ignore is
 * not an invariant.
 *
 * Matched on the WHOLE normalized title, never a substring — "School notes" and
 * "Newsletters → Junk" are real leaves and must survive.
 */
export const CATCH_ALL_LEAVES = new Set([
  'personal notes',
  'personal note',
  'personal',
  'notes',
  'misc',
  'miscellaneous',
  'other',
  'others',
  'general',
  'uncategorized',
  'uncategorised',
  'unsorted',
  'everything else',
]);

/**
 * Drop trailing catch-all segments so the thread lands on its parent tile.
 *
 * Only ever trims BELOW the top level: a bare ["Other"] is left alone, because
 * turning it into an empty path would silently unclassify the thread rather
 * than file it, and an unclassified thread is skipped by the magics pass.
 */
export function trimCatchAllLeaf(path: string[]): string[] {
  let end = path.length;
  while (end > 1 && CATCH_ALL_LEAVES.has(path[end - 1].trim().toLowerCase())) end--;
  return end === path.length ? path : path.slice(0, end);
}

export interface PathAssignment {
  gmailThreadId: string;
  path: string[];
  confidence?: number;
  action?: EmailAction;
  /** ADR 0110 — the model's read of how the thread was sent. Never part of
   *  the tree; carried alongside so the caller can store it. */
  bulk?: boolean;
}

/** Build categories + assignments from path-keyed thread assignments. */
export function buildTreeFromPaths(assignmentsIn: PathAssignment[]): {
  categories: CategoryNode[];
  assignments: ThreadAssignment[];
} {
  const categories = new Map<string, CategoryNode>();
  const assignments: ThreadAssignment[] = [];
  for (const a of assignmentsIn) {
    const path = trimCatchAllLeaf(a.path);
    if (path.length === 0) continue;
    const leafId = ensurePath(categories, path);
    assignments.push({
      gmailThreadId: a.gmailThreadId,
      categoryId: leafId,
      confidence: a.confidence,
      action: a.action,
    });
  }
  return { categories: [...categories.values()], assignments };
}
