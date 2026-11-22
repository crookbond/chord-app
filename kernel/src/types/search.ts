/**
 * ADR 0062 — user-facing global search contract. A flat, ranked list of hits
 * across the searcher's own data (messages, files, tasks, lists, saves),
 * scoped to the groups they belong to. Distinct from the bot's `search` tool
 * (ADR 0059), which returns a categorized DTO for the LLM.
 */
import { z } from 'zod';

export const SEARCH_ENTITY_TYPES = [
  'message',
  'file',
  'task',
  'list',
  'save',
  /** A mail thread. Personal data with no group of its own, so it is only
   *  searched from the personal 1:1 scope - see the note in search.service. */
  'email',
  /** A pending proposal awaiting the user's yes/no (To Do's -> Action Items). */
  'todo',
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export interface SearchHit {
  entityType: SearchEntityType;
  entityId: string;
  /** The hit's group — the searcher is a member (their own data), so the id is
   *  safe to return to the client for deep-linking (unlike the bot path, which
   *  must avoid raw ids per ADR 0032's scrubber). */
  groupId: string;
  groupName: string;
  /** Primary label: filename / task title / list name / save title / sender. */
  title: string;
  /** Match-highlighted excerpt (ts_headline), or a plain title fallback. */
  snippet: string;
  /** In-app expo-router destination for tapping the hit. */
  href: string;
  createdAt: string;
  /** ts_rank_cd score; higher is more relevant. */
  score: number;
}

export const SearchRequest = z.object({
  q: z.string().trim().min(2).max(200),
  types: z.array(z.enum(SEARCH_ENTITY_TYPES)).optional(),
  /** Total hits cap (across all types). Default 30, hard-capped at 50. */
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export interface SearchResponse {
  query: string;
  /** `all-groups` from a personal 1:1 search (`/me/search`); `this-group` for
   *  an in-group search (`/groups/:id/search`). */
  scope: 'all-groups' | 'this-group';
  hits: SearchHit[];
}
