import { z } from 'zod';

/**
 * Email classifier contract (ADR 0061) — the integration seam.
 *
 * The clustering/tiling engine is built by a separate team. It produces a
 * category TREE plus per-thread assignments; Chord OWNS this contract, the
 * landing tables, and the ingest/read paths, but does NOT build the clusterer.
 * Both sides import these zod schemas so they compile against one shape.
 *
 * Semantics are SNAPSHOT-REPLACE: the classifier sends the FULL current tree +
 * assignments for a user; ingest upserts atomically and prunes anything absent.
 * Assignments are keyed by Gmail thread id (not Chord's internal id) so the
 * classifier never needs to know our ids; ingest maps them to local threads and
 * skips any not-yet-synced thread (a later sync + re-ingest reconciles).
 */

export const CategoryNode = z.object({
  /** Classifier-stable id (survives re-runs so tiles don't churn). */
  id: z.string().min(1).max(128),
  /** Parent node id; null marks a root tile. */
  parentId: z.string().min(1).max(128).nullable(),
  /** Human tile title, e.g. "Finance", "Receipts". */
  title: z.string().min(1).max(120),
  /** 0 for a root tile; increments per level. */
  depth: z.number().int().min(0).max(32),
  sortOrder: z.number().int().optional(),
  /** Optional tile tint (hex). */
  color: z.string().max(32).nullable().optional(),
  /** Optional icon name/emoji. */
  icon: z.string().max(64).nullable().optional(),
  /** Set when the classifier persisted this category as a Gmail label. */
  gmailLabelId: z.string().max(128).nullable().optional(),
});
export type CategoryNode = z.infer<typeof CategoryNode>;

/**
 * What the thread wants FROM YOU - the second, orthogonal axis.
 *
 * The category tree says what a thread is about; this says what it needs.
 * They are independent: a school email can be `reply_needed` while another
 * school email is `informational`, and both stay under Friends & family.
 * Exactly one value per thread.
 *
 * Before this axis existed, "needs action" was implicit and lived in a
 * different subsystem entirely (the magics pass staged proposals, surfaced
 * under To Do's), so a thread that wanted a human reply but produced no
 * proposal was invisible as an action.
 */
export const EMAIL_ACTIONS = ['to_do', 'reply_needed', 'informational', 'other'] as const;
export const EmailAction = z.enum(EMAIL_ACTIONS);
export type EmailAction = z.infer<typeof EmailAction>;

export const ThreadAssignment = z.object({
  gmailThreadId: z.string().min(1).max(128),
  categoryId: z.string().min(1).max(128),
  confidence: z.number().min(0).max(1).optional(),
  /** Optional so the external classifier (ADR 0061 seam) stays compatible
   *  without shipping in lockstep; ingest defaults a missing value to
   *  'other' rather than leaving the column null. */
  action: EmailAction.optional(),
});
export type ThreadAssignment = z.infer<typeof ThreadAssignment>;

export const EmailClassificationSnapshot = z.object({
  version: z.literal(1),
  /** Ignored when posted through the session-authed ingest route (taken from
   *  the session); present for shared-DB batch jobs. */
  userId: z.string().min(1).max(128),
  categories: z.array(CategoryNode).max(5000),
  assignments: z.array(ThreadAssignment).max(100_000),
});
export type EmailClassificationSnapshot = z.infer<typeof EmailClassificationSnapshot>;

export interface EmailClassificationIngestResult {
  categories: number;
  /** Assignments mapped to a known local thread and written. */
  assignments: number;
  /** Assignments dropped because the thread isn't synced yet. */
  skippedUnknownThreads: number;
}
