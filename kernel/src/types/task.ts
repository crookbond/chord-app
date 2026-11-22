import { z } from 'zod';
import type {
  GroupId,
  IsoDateTime,
  TaskId,
  UserId,
} from './ids';

export type TaskStatus = 'open' | 'active' | 'done' | 'superseded' | 'archived';

/**
 * How far past its due date an open task must be before it reads as "stale"
 * — muted and sorted below live work in the client, tagged [STALE] in the
 * briefing context (spec v4 §6.2, ADR 0092). Shared so the two surfaces
 * cannot drift. Distinct from TASK_OVERDUE_ARCHIVE_DAYS, which retires it.
 */
export const TASK_STALE_MS = 48 * 60 * 60 * 1000;

/** True when `dueAt` is set and more than TASK_STALE_MS in the past. */
export function isTaskStale(dueAt: string | undefined | null, now = Date.now()): boolean {
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  return Number.isFinite(due) && due < now - TASK_STALE_MS;
}

/**
 * ADR 0285 — why a to-do was archived. `overdue` / `expired` / `email_gone` /
 * `email_spam` / `event_gone` were done by Chord; `dropped` and `completed` by a person.
 */
export type TaskArchivedReason =
  | 'overdue'
  | 'expired'
  | 'email_gone'
  | 'email_spam'
  | 'event_gone'
  | 'dropped'
  | 'completed';

/** Reasons Chord acted on its own, which the morning briefing reports. */
export function retiredByChord(reason: TaskArchivedReason | null | undefined): boolean {
  return reason === 'overdue' || reason === 'expired' || reason === 'email_gone' || reason === 'email_spam' || reason === 'event_gone';
}

const ARCHIVED_REASON_TEXT: Record<TaskArchivedReason, string> = {
  overdue: 'more than a week past its date',
  expired: 'its time ran out',
  email_gone: 'its email was deleted',
  email_spam: 'its email went to spam',
  event_gone: 'its calendar event was removed',
  dropped: 'you dropped it',
  completed: 'done',
};

/** The words the briefing and the To Do's Archived section both use. */
export function archivedReasonText(reason: TaskArchivedReason): string {
  return ARCHIVED_REASON_TEXT[reason];
}

export interface Task {
  id: TaskId;
  groupId: GroupId;
  title: string;
  details?: string;
  assigneeId?: UserId;
  /** ADR 0151 — a managed family member (a child, a grandparent) as the
   *  assignee. Mutually exclusive with assigneeId. */
  assigneePersonaId?: string;
  /** Display name of the assigned persona. Populated by list endpoints. */
  assigneePersonaName?: string;
  status: TaskStatus;
  dueAt?: IsoDateTime;
  /** When the bot should surface this again. */
  remindAt?: IsoDateTime;
  /** Original natural-language cue ("3 weeks before 2/15"). */
  remindCue?: string;
  /** Auto-archive after this timestamp, regardless of status. */
  liveUntil?: IsoDateTime;
  archivedAt?: IsoDateTime;
  /** ADR 0285 — why it was archived; absent while live, and for to-dos
   *  archived before the reason was recorded. */
  archivedReason?: TaskArchivedReason;
  /** When the task transitioned to status='done'. Cleared on reopen. */
  completedAt?: IsoDateTime;
  createdBy: UserId | null;
  /** Display name of the creator. Populated by list endpoints; absent on direct fetches. */
  createdByName?: string;
  createdAt: IsoDateTime;
  /** The raw message fragment (or doc excerpt) that produced this task during
   *  import or per-file extraction. Present when and only when the entity was
   *  created by an automated pipeline, not a human action. */
  sourceRawContext?: string;
}

export const CreateTaskRequest = z.object({
  title: z.string().trim().min(1).max(200),
  details: z.string().max(2000).optional(),
  assigneeId: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  remindAt: z.string().datetime().optional(),
  remindCue: z.string().max(200).optional(),
  liveUntil: z.string().datetime().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const UpdateTaskRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().max(2000).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  status: z.enum(['open', 'active', 'done', 'superseded', 'archived']).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  remindAt: z.string().datetime().nullable().optional(),
  remindCue: z.string().max(200).nullable().optional(),
  liveUntil: z.string().datetime().nullable().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;
