import { z } from 'zod';

/** ADR 0019 — per-user catchup folder. */
export interface CatchupFolder {
  id: string;
  /** One word, lowercase. Stable identifier. */
  name: string;
  /** Title-cased label for UI. */
  display: string;
  kind: 'seed' | 'derived' | 'archived';
  pinned: boolean;
  /** Total non-archived assignments in this folder for the requesting user. */
  count: number;
}

export type CatchupEntityType = 'task' | 'list' | 'save' | 'trip';

export interface CatchupFolderContents {
  tasks: string[];
  lists: string[];
  saves: string[];
  trips: string[];
}

export const MoveCatchupAssignmentRequest = z.object({
  folderId: z.string().min(1),
});
export type MoveCatchupAssignmentRequest = z.infer<typeof MoveCatchupAssignmentRequest>;
