/**
 * ADR 0328 — sending a group event's invitations to the family.
 *
 * `createEvent` writes each invited member's row as Chord's own record (never
 * pushed) and starts `sendFamilyInvites` once the write has committed. That
 * puts the members on the organizer's event:
 *
 * - `calendar`: the organizer's provider event gains them as guests through
 *   the same guest change a named guest gets (ADR 0295), so the provider
 *   mails the invitation and, later, every update.
 * - `mail`: the organizer has no calendar Chord writes to, so Chord mails an
 *   iTIP request from their mailbox, and a new request or a cancellation
 *   whenever the time or place changes or the event is deleted.
 *
 * When the invitation cannot go out, the rows become ordinary copies on each
 * member's own calendar, so nobody is left without the event.
 */
import type { Kysely, Selectable } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB, EventsTable } from '../../db/schema.js';
import { resolveSendMailbox } from '../email/default-mailbox.js';
import { getAccount } from '../email-accounts/account-utils.js';
import { getGmailApi } from '../google/gmail-api.js';
import { buildItipRequestMime, buildItipRequestRaw, type ItipRequestInput } from '../google/gmail-sync.js';
import { changeEventGuests } from './guests.service.js';

type Row = Selectable<EventsTable>;

export type FamilyInviteResult =
  | { ok: true; via: 'calendar' | 'mail'; invited: Array<{ userId: string; email: string; name: string | null }> }
  | {
      ok: false;
      /** Why no invitation went out; everyone listed got a copy instead. */
      reason: 'not_found' | 'not_organizer' | 'not_on_calendar' | 'provider_error' | 'no_mailbox' | 'send_failed';
      copied: Array<{ userId: string; name: string | null }>;
    };

async function invitedRows(db: Kysely<DB>, org: Row): Promise<Row[]> {
  if (!org.ical_uid) return [];
  return db
    .selectFrom('events')
    .selectAll()
    .where('ical_uid', '=', org.ical_uid)
    .where('invite_email', 'is not', null)
    .where('deleted_at', 'is', null)
    .where('id', '!=', org.id)
    .execute();
}

async function names(db: Kysely<DB>, userIds: string[]): Promise<Map<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.selectFrom('users').select(['id', 'display_name']).where('id', 'in', userIds).execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export async function sendFamilyInvites(db: Kysely<DB>, organizerEventId: string): Promise<FamilyInviteResult | null> {
  const org = await db.selectFrom('events').selectAll().where('id', '=', organizerEventId).executeTakeFirst();
  if (!org || !org.owner_user_id) return null;
  const rows = await invitedRows(db, org);
  if (rows.length === 0) return null;
  const who = await names(
    db,
    rows.map((r) => r.owner_user_id!).filter(Boolean),
  );
  const invited = rows.map((r) => ({
    userId: r.owner_user_id!,
    email: r.invite_email!,
    name: who.get(r.owner_user_id!) ?? null,
  }));

  const via = rows[0]!.invite_via;
  if (via === 'calendar') {
    const res = await changeEventGuests(db, {
      eventId: org.id,
      actorUserId: org.owner_user_id,
      add: invited.map((i) => i.email),
    });
    if (res.ok) {
      await db
        .updateTable('events')
        .set({ invite_uid: res.iCalUid ?? org.ical_uid })
        .where('id', 'in', rows.map((r) => r.id))
        .execute();
      return { ok: true, via: 'calendar', invited };
    }
    await convertToCopies(db, rows);
    return { ok: false, reason: res.reason, copied: invited.map(({ userId, name }) => ({ userId, name })) };
  }

  const sent = await mailInvitation(db, org, invited, 'REQUEST');
  if (sent === 'sent') {
    // Everyone mailed shows as not answered until their reply arrives.
    const { recordGuestAnswers } = await import('./guest-answers.js');
    await recordGuestAnswers(
      db,
      org.id,
      invited.map((i) => ({ email: i.email, responseStatus: 'needsAction' })),
    );
    await db
      .updateTable('events')
      .set({ invite_uid: org.ical_uid })
      .where('id', 'in', rows.map((r) => r.id))
      .execute();
    return { ok: true, via: 'mail', invited };
  }
  await convertToCopies(db, rows);
  return { ok: false, reason: sent, copied: invited.map(({ userId, name }) => ({ userId, name })) };
}

/**
 * The invitation could not go out: give each member the copy they would have
 * had before ADR 0328, on their own default calendar, and push it.
 */
export async function convertToCopies(db: Kysely<DB>, rows: Array<Pick<Row, 'id' | 'owner_user_id'>>): Promise<void> {
  if (rows.length === 0) return;
  const owners = [...new Set(rows.map((r) => r.owner_user_id).filter((o): o is string => !!o))];
  const defaults =
    owners.length > 0
      ? await db.selectFrom('users').select(['id', 'default_calendar_id']).where('id', 'in', owners).execute()
      : [];
  const calOf = new Map(defaults.map((d) => [d.id, d.default_calendar_id ?? 'primary']));
  for (const r of rows) {
    await db
      .updateTable('events')
      .set({
        invite_email: null,
        invite_via: null,
        invite_uid: null,
        chord_uid: r.id,
        google_calendar_id: r.owner_user_id ? (calOf.get(r.owner_user_id) ?? 'primary') : null,
        local_dirty: 1,
        gcal_sync_status: 'pending',
      })
      .where('id', '=', r.id)
      .execute();
  }
  const { queueOwnerPush } = await import('../events.service.js');
  for (const owner of owners) queueOwnerPush(db, owner, 'invite-fallback', rows[0]!.id);
}

/**
 * Mail an iTIP request or cancellation for `org` to `to`, from the organizer's
 * mailbox (their default send mailbox, ADR 0255).
 */
export async function mailInvitation(
  db: Kysely<DB>,
  org: Pick<Row, 'owner_user_id' | 'ical_uid' | 'sequence' | 'title' | 'location' | 'description' | 'starts_at' | 'ends_at' | 'all_day'>,
  to: Array<{ email: string; name?: string | null }>,
  method: 'REQUEST' | 'CANCEL',
): Promise<'sent' | 'no_mailbox' | 'send_failed'> {
  if (!org.owner_user_id || !org.ical_uid || to.length === 0) return 'no_mailbox';
  const mailbox = await resolveSendMailbox(db, org.owner_user_id);
  if (!mailbox) return 'no_mailbox';
  const me = await db
    .selectFrom('users')
    .select(['email', 'display_name'])
    .where('id', '=', org.owner_user_id)
    .executeTakeFirst();
  const fromEmail = mailbox.address ?? me?.email ?? null;
  if (!fromEmail) return 'no_mailbox';
  const input: ItipRequestInput = {
    method,
    fromEmail,
    fromName: me?.display_name ?? null,
    attendees: to,
    icalUid: org.ical_uid,
    sequence: org.sequence ?? 0,
    summary: org.title,
    location: org.location,
    description: org.description,
    startsAt: org.starts_at,
    endsAt: org.ends_at,
    allDay: org.all_day === 1,
  };
  try {
    if (!mailbox.accountId) {
      await (await getGmailApi(db, org.owner_user_id)).sendMessage(buildItipRequestRaw(input));
      return 'sent';
    }
    const account = await getAccount(db, org.owner_user_id, mailbox.accountId);
    if (!account) return 'no_mailbox';
    if (account.provider === 'gmail') {
      const { gmailAccountApi } = await import('../email-accounts/gmail-account.service.js');
      await (await gmailAccountApi(db, account)).sendMessage(buildItipRequestRaw(input));
    } else if (account.provider === 'outlook') {
      const { getOutlookApi } = await import('../email-accounts/outlook-api.js');
      await (await getOutlookApi(db, account)).sendMime(buildItipRequestMime(input));
    } else {
      const { imapAccountApi } = await import('../email-accounts/imap.service.js');
      await imapAccountApi(account).sendRaw({
        from: fromEmail,
        to: to.map((t) => t.email),
        raw: buildItipRequestMime(input),
      });
    }
    return 'sent';
  } catch (err) {
    logger.warn(`family invites: iTIP ${method} send failed uid=${org.ical_uid}: ${(err as Error).message}`);
    return 'send_failed';
  }
}

/** After a time/place change on an event whose invitations went by mail:
 *  send the updated request (its sequence already raised by updateEvent). */
export async function mailInvitationUpdate(db: Kysely<DB>, organizerEventId: string): Promise<void> {
  const org = await db.selectFrom('events').selectAll().where('id', '=', organizerEventId).executeTakeFirst();
  if (!org) return;
  const rows = (await invitedRows(db, org)).filter((r) => r.invite_via === 'mail');
  if (rows.length === 0) return;
  const result = await mailInvitation(
    db,
    org,
    rows.map((r) => ({ email: r.invite_email! })),
    'REQUEST',
  );
  if (result !== 'sent') logger.warn('family invites: update not mailed', { eventId: org.id, result });
}
