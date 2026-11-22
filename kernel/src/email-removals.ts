/**
 * Whether a view's data still shows an email this device put away.
 *
 * Archiving or trashing from the reader does not wait for the mailbox (ADR
 * 0218): the next email is on screen while the provider round trip and the
 * mirror write run behind it. So a fetch ISSUED before that write landed can
 * be answered from a mirror where the thread is still in the inbox, and its
 * response is stale however recently it was asked for.
 *
 * The rule is therefore two parts: a removal the mailbox has not answered
 * yet hides the row outright, and one it has answered hides it in any data
 * fetched before the CONFIRMATION. Stamping only at the tap is what let a
 * walk's last emails come back - returning to the view refetches in the same
 * moment the taps happened, so the new fetch looked newer than every removal
 * while predating their writes.
 */
export type EmailRemovalTimes = ReadonlyMap<string, number>;

export interface EmailRemovals {
  /** Removals the mailbox has not answered yet. */
  removing: ReadonlySet<string>;
  /** When each removal was last stamped: at the tap, and at the confirmation. */
  removedAt: EmailRemovalTimes;
}

/** Was `id` put away from here, as far as `fetchedAt` data can know? */
export function removedSinceFetch(
  removals: EmailRemovals,
  fetchedAt: number,
  id: string,
): boolean {
  if (removals.removing.has(id)) return true;
  const at = removals.removedAt.get(id);
  return at !== undefined && at >= fetchedAt;
}

/**
 * Is data fetched at `fetchedAt` known to be stale - does it predate a
 * removal confirmed since? A view that filters on the rule above is showing
 * the right rows but may be missing others the server would now send in
 * their place, so it is worth one more fetch.
 */
export function fetchPredatesRemoval(removals: EmailRemovals, fetchedAt: number): boolean {
  // A pending one is hidden already and its write has not landed, so a read
  // now would be just as stale; its confirmation re-stamps and asks then.
  for (const [id, at] of removals.removedAt) {
    if (at >= fetchedAt && !removals.removing.has(id)) return true;
  }
  return false;
}

/** The rows of `fetchedAt` data that are not emails put away from here. */
export function withoutRemoved<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  removals: EmailRemovals,
  fetchedAt: number,
): T[] {
  return rows.filter((row) => !removedSinceFetch(removals, fetchedAt, idOf(row)));
}
