/**
 * ADR 0328 — the invitations started for an event, so the bot turn that made
 * it can say who was invited. Kept apart from the sender, which the events
 * service loads lazily: the promise has to be on record the moment the event
 * is written, before that import has finished.
 */
import type { FamilyInviteResult } from './family-invites.js';

const inFlight = new Map<string, Promise<FamilyInviteResult | null>>();

/** Remember the outcome for a short while; a turn reads it right away. */
export function rememberFamilyInvites(eventId: string, run: Promise<FamilyInviteResult | null>): void {
  inFlight.set(eventId, run);
  void run.finally(() => {
    const t = setTimeout(() => {
      if (inFlight.get(eventId) === run) inFlight.delete(eventId);
    }, 60_000);
    t.unref?.();
  });
}

/** The outcome of the invitations started for this event, or null when none
 *  were started (flag off, nobody to invite, or a write still uncommitted). */
export async function waitForFamilyInvites(eventId: string): Promise<FamilyInviteResult | null> {
  return (await inFlight.get(eventId)) ?? null;
}
