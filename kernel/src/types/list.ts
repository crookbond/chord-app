import { z } from 'zod';
import type {
  GroupId,
  IsoDateTime,
  ListId,
  ListItemId,
  UserId,
} from './ids';

export interface List {
  id: ListId;
  groupId: GroupId;
  name: string;
  createdBy: UserId | null;
  /** Display name of the creator. Populated by list endpoints; absent on direct fetches. */
  createdByName?: string;
  createdAt: IsoDateTime;
}

export interface ListItem {
  id: ListItemId;
  listId: ListId;
  text: string;
  checked: boolean;
  createdAt: IsoDateTime;
}

export const UpsertListRequest = z.object({
  name: z.string().trim().min(1).max(80),
});
export type UpsertListRequest = z.infer<typeof UpsertListRequest>;

// A list item is a free-form line, not a short tag — a recipe step or a
// detailed errand easily runs past a couple hundred chars. Cap at 2000 to
// match the other long free-text fields (task details, place/contact notes)
// so long items don't silently fail to add.
export const LIST_ITEM_TEXT_MAX = 2000;

export const AddListItemRequest = z.object({
  text: z.string().trim().min(1).max(LIST_ITEM_TEXT_MAX),
});
export type AddListItemRequest = z.infer<typeof AddListItemRequest>;

export const UpdateListItemRequest = z.object({
  text: z.string().trim().min(1).max(LIST_ITEM_TEXT_MAX).optional(),
  checked: z.boolean().optional(),
});
export type UpdateListItemRequest = z.infer<typeof UpdateListItemRequest>;
