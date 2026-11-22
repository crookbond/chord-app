import { z } from 'zod';
import type { IsoDateTime, UserId } from './ids';

/** ADR 0298 — someone the viewer has blocked. */
export interface BlockedUser {
  userId: UserId;
  /** Their full name, as shown in a roster. */
  name: string;
  blockedAt: IsoDateTime;
}

export const BlockUserRequest = z.object({
  userId: z.string().min(1).max(128),
});
export type BlockUserRequest = z.infer<typeof BlockUserRequest>;
