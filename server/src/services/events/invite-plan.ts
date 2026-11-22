/**
 * ADR 0328 — who a group event can invite, and how.
 *
 * A member is invited at an address whose calendar will take the invitation:
 * a calendar they connected to Chord, else the Google or Microsoft account
 * they sign in with (every such account has a calendar, connected to Chord or
 * not). Never an Apple private-relay address, which forwards the mail and puts
 * nothing on a calendar. No address = the member keeps a copy (ADR 0040 §7).
 *
 * The organizer sends from their calendar when they have one Chord writes to,
 * else as a mailed iTIP request from a mailbox that can send, else not at all.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { hasCalendarWriteScope } from '../google/calendar-write.service.js';
import { calendarConnection } from '../outlook-calendar/accounts.js';
import { resolveSendMailbox } from '../email/default-mailbox.js';

export type InviteVia = 'calendar' | 'mail';

const RELAY = /@privaterelay\.appleid\.com$/i;

function usable(address: string | null | undefined): string | null {
  const a = address?.trim().toLowerCase();
  if (!a || !a.includes('@') || RELAY.test(a)) return null;
  return a;
}

/** The address a member is invited at, or null when Chord has none that a
 *  calendar would take. */
export async function inviteAddressFor(db: Kysely<DB>, userId: string): Promise<string | null> {
  const user = await db
    .selectFrom('users')
    .select(['email', 'google_sub', 'microsoft_sub', 'shadow', 'refresh_token_scopes'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || user.shadow === 1) return null;

  // 1. A calendar they connected: the login Google's, then an attached
  //    mailbox that carries one (ADR 0313 / 0228), oldest first.
  if (user.google_sub && (await hasCalendarWriteScope(db, userId))) {
    const a = usable(user.email);
    if (a) return a;
  }
  const withCalendar = await db
    .selectFrom('email_accounts')
    .select('email_address')
    .where('user_id', '=', userId)
    .where('calendar_enabled', '=', 1)
    .where('status', '=', 'ok')
    .orderBy('created_at')
    .execute();
  for (const r of withCalendar) {
    const a = usable(r.email_address);
    if (a) return a;
  }
  // 2. The account they sign in with has a calendar of its own.
  if (user.google_sub || user.microsoft_sub) return usable(user.email);
  return null;
}

/**
 * How the organizer can send invitations for an event on `calendarId` (null =
 * their default, which is the login calendar when Chord can write to it).
 */
export async function organizerInviteVia(
  db: Kysely<DB>,
  organizerId: string,
  calendarId: string | null | undefined,
): Promise<InviteVia | null> {
  const key = calendarId ?? 'primary';
  const isProviderKey = key.startsWith('outlook:') || key.startsWith('gacct:');
  if (isProviderKey) {
    if ((await calendarConnection(db, organizerId, key)).state === 'connected') return 'calendar';
  } else if (await hasCalendarWriteScope(db, organizerId)) {
    return 'calendar';
  }
  return (await resolveSendMailbox(db, organizerId)) ? 'mail' : null;
}

/** The organizer's own address, so a member who shares it is not "invited"
 *  to their own event. */
export async function organizerAddress(db: Kysely<DB>, organizerId: string): Promise<string | null> {
  const user = await db.selectFrom('users').select('email').where('id', '=', organizerId).executeTakeFirst();
  return usable(user?.email);
}
