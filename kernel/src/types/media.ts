import { z } from 'zod';
import type {
  GroupId,
  IsoDateTime,
  MediaItemId,
  UserId,
} from './ids';

/** Reading / podcast / watch lists (Flow 3 I-2). */
export type MediaKind = 'book' | 'podcast' | 'show' | 'movie' | 'article';

export interface MediaItem {
  id: MediaItemId;
  groupId: GroupId;
  kind: MediaKind;
  title: string;
  note?: string;
  done: boolean;
  createdBy: UserId | null;
  createdAt: IsoDateTime;
}

export const CreateMediaRequest = z.object({
  kind: z.enum(['book', 'podcast', 'show', 'movie', 'article']),
  title: z.string().trim().min(1).max(200),
  note: z.string().max(1000).optional(),
});
export type CreateMediaRequest = z.infer<typeof CreateMediaRequest>;
