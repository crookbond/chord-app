import { z } from 'zod';
import type {
  GroupId,
  IsoDateTime,
  SaveId,
  UserId,
} from './ids';

export type SaveKind = 'link' | 'place' | 'media' | 'note' | 'contact';

export interface Save {
  id: SaveId;
  groupId: GroupId;
  kind: SaveKind;
  title: string;
  url?: string;
  note?: string;
  tags: string[];
  /** Free-text bucket like "Miami trip" — flows use it to group saves. */
  tripLabel?: string;
  createdBy: UserId | null;
  /** Display name of the creator. Populated by list endpoints; absent on direct fetches. */
  createdByName?: string;
  createdAt: IsoDateTime;
  sourceRawContext?: string;
}

export const CreateSaveRequest = z.object({
  kind: z.enum(['link', 'place', 'media', 'note', 'contact']),
  title: z.string().trim().min(1).max(200),
  url: z.string().url().optional(),
  note: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  tripLabel: z.string().max(80).optional(),
});
export type CreateSaveRequest = z.infer<typeof CreateSaveRequest>;

/** PATCH /api/v1/saves/:id — any subset of these fields is allowed.
 *  Setting `note` or `tripLabel` to an empty string clears them. */
export const UpdateSaveRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  url: z.string().url().optional(),
  note: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  tripLabel: z.string().max(80).optional(),
});
export type UpdateSaveRequest = z.infer<typeof UpdateSaveRequest>;

/** The kinds a list can be turned into (ADR 0290). A contact needs fields a
 *  list line does not carry, so it is not offered. */
export const MOVABLE_SAVE_KINDS = ['place', 'media', 'link', 'note'] as const;
export type MovableSaveKind = (typeof MOVABLE_SAVE_KINDS)[number];

/** POST /api/v1/lists/:id/move-to-saves. A line that is a URL always becomes
 *  a link, whatever `kind` says. */
export const MoveListToSavesRequest = z.object({
  kind: z.enum(MOVABLE_SAVE_KINDS).default('place'),
});
export type MoveListToSavesRequest = z.infer<typeof MoveListToSavesRequest>;

export interface MoveListToSavesResult {
  listId: string;
  groupId: GroupId;
  listName: string;
  /** Items that became a new save. */
  moved: number;
  /** Items that were already saved in that group. The list is deleted
   *  either way: every item is now a save. */
  alreadySaved: number;
  /** The tag every save carries, so the Saves tab can filter back to them. */
  tag: string;
  saves: Save[];
}

/** What a list's items most likely are, from its name: books/shows/movies are
 *  media, links/articles are links, anything else (restaurants, places to
 *  visit, shops) is a place. Only a default; the bot passes its own. */
export function saveKindForListName(name: string): MovableSaveKind {
  const n = name.toLowerCase();
  if (/\b(books?|read|reading|movies?|films?|shows?|tv|watch|watchlist|podcasts?|listen)\b/.test(n)) {
    return 'media';
  }
  if (/\b(links?|articles?|bookmarks?|urls?)\b/.test(n)) return 'link';
  return 'place';
}

/** The tag a moved list's saves carry: the list's name, lowercased, without
 *  the filler word "list" ("Restaurant list" → "restaurant"). */
export function saveTagForListName(name: string): string {
  const words = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => w !== 'list' && w !== 'lists');
  return (kept.length > 0 ? kept : words).join(' ').slice(0, 40);
}
