import { z } from 'zod';
import type {
  GroupId,
  IsoDateTime,
  PlaceId,
  UserId,
} from './ids';

/** Saved place in a personal chat (Flow 3 I-1). Scoped to personal group. */
export interface Place {
  id: PlaceId;
  groupId: GroupId;
  name: string;
  area?: string;
  city?: string;
  tags: string[];
  note?: string;
  createdBy: UserId | null;
  createdAt: IsoDateTime;
}

export const CreatePlaceRequest = z.object({
  name: z.string().trim().min(1).max(200),
  area: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  note: z.string().max(2000).optional(),
});
export type CreatePlaceRequest = z.infer<typeof CreatePlaceRequest>;
