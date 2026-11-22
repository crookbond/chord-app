/**
 * Someone else's ticket shows as FREE on your calendar (ADR 0289 addendum).
 *
 * A ticket's calendar event sits on the booker's calendar (one copy; an
 * event with an external uid is not fanned out). When the trip names its
 * travellers and the copy's owner is not one of them, the copy is marked
 * free - Google, Outlook and the phone then
 * show it as free, so it no longer hides a real clash or blocks your time.
 * Your copy of your own ticket, and every copy of a ticket on a trip that
 * names nobody, stays busy.
 *
 * The value is enforced both ways on ticket events (they are Chord-made), so
 * a traveller added later turns their copy back to busy. A changed copy is
 * queued for the calendar push like any edit.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { isOnTrip, memberName, ticketTravelers, type PersonRef } from './trip-conflict.js';

const TICKET_UID_PREFIX = 'chord:travel_leg:';
/** How often the background pass re-checks upcoming tickets. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SWEEP_LIMIT = 500;

/**
 * Set free/busy on every copy of the given ticket events (by `external_uid`),
 * or, with no uids, on every ticket starting from a day ago. Returns how many
 * copies changed.
 */
export async function refreshTicketFreeBusy(
  db: Kysely<DB>,
  opts: { externalUids?: string[] } = {},
): Promise<number> {
  if (opts.externalUids && opts.externalUids.length === 0) return 0;
  let q = db
    .selectFrom('events')
    .select(['id', 'external_uid', 'owner_user_id', 'transparency'])
    .where('deleted_at', 'is', null)
    .where('external_uid', 'like', `${TICKET_UID_PREFIX}%`);
  q = opts.externalUids
    ? q.where('external_uid', 'in', opts.externalUids)
    : q
        .where(textInstant('events.starts_at'), '>=', sql<string>`now() - interval '1 day'`)
        .limit(SWEEP_LIMIT);
  const rows = await q.execute();
  if (rows.length === 0) return 0;

  const travelers = await ticketTravelers(db, rows, null);
  const ownerIds = [...new Set(rows.map((r) => r.owner_user_id).filter((id): id is string => !!id))];
  const owners = ownerIds.length
    ? await db
        .selectFrom('users')
        .select(['id', 'username', 'display_name', 'first_name', 'last_name'])
        .where('id', 'in', ownerIds)
        .execute()
    : [];
  const personOf = new Map<string, PersonRef>(
    owners.map((u) => [u.id, { userId: u.id, names: [memberName(u), u.display_name].filter((n): n is string => !!n) }]),
  );

  const toFree: string[] = [];
  const toBusy: string[] = [];
  for (const r of rows) {
    const onTrip = travelers.get(r.id) ?? [];
    const owner = r.owner_user_id ? personOf.get(r.owner_user_id) : undefined;
    const free = onTrip.length > 0 && !!owner && !isOnTrip(owner, onTrip);
    const want = free ? 'transparent' : 'opaque';
    if ((r.transparency ?? 'opaque') === want) continue;
    (free ? toFree : toBusy).push(r.id);
  }
  const now = new Date().toISOString();
  for (const [ids, transparency] of [
    [toFree, 'transparent'],
    [toBusy, 'opaque'],
  ] as const) {
    if (ids.length === 0) continue;
    await db
      .updateTable('events')
      .set({ transparency, local_dirty: 1, gcal_sync_status: 'pending', updated_at: now })
      .where('id', 'in', ids)
      .execute();
  }
  return toFree.length + toBusy.length;
}

let lastSweep = 0;

/**
 * Catch-all for any path that changes who is on a trip without going through
 * the ticket's own sync (participants edited, a leg moved, a trip shared to a
 * group), and the one-time fix for tickets made before this rule.
 */
export async function maybeRefreshTicketFreeBusy(db: Kysely<DB>): Promise<void> {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  await refreshTicketFreeBusy(db);
}
