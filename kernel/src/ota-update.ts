/**
 * ADR 0216 — when the app looks for an OTA update on its own, and when it
 * offers the reload. Pure so it can be tested; `mobile/` has no harness.
 */

/** Coming back to the app more often than this does not check again. */
export const OTA_CHECK_MIN_GAP_MS = 10 * 60_000;

/**
 * Check on return to the foreground, at most once per gap. A launch already
 * checks on its own (expo-updates' default), so `lastCheckAt` starts at the
 * launch time rather than zero.
 */
export function shouldCheckForUpdate(
  lastCheckAt: number,
  now: number,
  minGapMs: number = OTA_CHECK_MIN_GAP_MS,
): boolean {
  return now - lastCheckAt >= minGapMs;
}

/** Stands in for a pending update whose id we were not told, so "Later"
 *  can still hide it. */
const UNKNOWN_UPDATE = '__unknown__';

/** What "Later" records, so the same update does not ask again. */
export function updateDismissKey(pendingUpdateId: string | null | undefined): string {
  return pendingUpdateId || UNKNOWN_UPDATE;
}

/**
 * Offer the reload only for a downloaded update the person has not already
 * waved off. "Later" hides THAT update; a newer one asks again.
 */
export function shouldShowUpdateBanner(input: {
  isUpdatePending: boolean;
  pendingUpdateId: string | null | undefined;
  dismissedKey: string | null;
}): boolean {
  if (!input.isUpdatePending) return false;
  return updateDismissKey(input.pendingUpdateId) !== input.dismissedKey;
}
