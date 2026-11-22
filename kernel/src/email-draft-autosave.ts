/**
 * When the composer saves a draft (ADR 0113, ADR 0303).
 *
 * After a quiet spell, as before - but a debounce alone never fires for someone
 * who types without pausing, so an unsaved change is also never older than
 * `DRAFT_AUTOSAVE_MAX_WAIT_MS`. A crash then loses at most that much.
 */
export const DRAFT_AUTOSAVE_QUIET_MS = 1500;
export const DRAFT_AUTOSAVE_MAX_WAIT_MS = 30_000;

/** Milliseconds until the next save, given when the oldest unsaved change was
 *  made (null = this change is the first since the last save). */
export function draftAutosaveDelay(pendingSinceMs: number | null, nowMs: number): number {
  const waited = pendingSinceMs === null ? 0 : Math.max(0, nowMs - pendingSinceMs);
  return Math.max(0, Math.min(DRAFT_AUTOSAVE_QUIET_MS, DRAFT_AUTOSAVE_MAX_WAIT_MS - waited));
}
