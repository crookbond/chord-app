import { z } from 'zod';
import type {
  ContactId,
  GroupId,
  IsoDateTime,
  UserId,
} from './ids';

/** Contact note in personal chat (Flow 3 I-3, I-4). */
export interface Contact {
  id: ContactId;
  groupId: GroupId;
  name: string;
  org?: string;
  education?: string[];
  family?: string;
  tags: string[];
  /** Free-form notes — searched for "who's in SF" style memory queries. */
  note?: string;
  createdBy: UserId | null;
  createdAt: IsoDateTime;
}

export const CreateContactRequest = z.object({
  name: z.string().trim().min(1).max(100),
  org: z.string().max(100).optional(),
  education: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  family: z.string().max(300).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  note: z.string().max(2000).optional(),
});
export type CreateContactRequest = z.infer<typeof CreateContactRequest>;
