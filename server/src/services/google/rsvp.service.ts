/**
 * Answering a calendar invitation (ADR 0104).
 *
 * The Calendar API has no RSVP endpoint. The documented way to respond is to
 * patch your own entry in an event's `attendees` array — which needs the event
 * to be addressable at `calendars/<cal>/events/<id>`. That works for the common
 * case, where Google put the invitation on your calendar the moment it arrived.
 *
 * It does not work for the case that made us write this. When Google is unsure
 * of the sender it withholds the invitation, and its own docs say the event
 * "isn't added to their calendar until they click Add to calendar or they RSVP
 * to the event". So the event we would have to patch does not exist until the
 * RSVP it is supposed to carry has already happened.
 *
 * The way out is the protocol Gmail's own Yes/Maybe/No buttons use: mail an
 * iTIP `METHOD:REPLY` (RFC 5546) back to the organizer. It does not care what
 * state the calendar is in, and it is the only route that actually tells the
 * organizer anything.
 *
 * So: patch when we can, mail when we cannot. Most invitations cost no email.
 */
import type { Kysely } from 'kysely';
import { isNoReplyAddress } from '@chord/kernel';

import { logger } from '../../config/logging.js';
import { byInstant } from '../../db/text-instant.js';
import type { DB } from '../../db/schema.js';
import { getGmailApi } from './gmail-api.js';
import { buildItipReplyMime, buildItipReplyRaw, type ItipReplyInput } from './gmail-sync.js';
import { outlookCalendarApiFor } from '../outlook-calendar/accounts.js';
import { getAccount, type AccountRow } from '../email-accounts/account-utils.js';
import { mailboxOfProvenance } from '../email/source-mailbox.js';
import { gmailAccountCalendarIds, gmailCalendarAccessToken } from '../gmail-calendar/accounts.js';
import { isGmailCalendarKey } from '../gmail-calendar/ids.js';
import { getAccessToken } from './oauth.service.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

export type RsvpResponse = 'accepted' | 'declined' | 'tentative';

/** iCalendar PARTSTAT for each response (RFC 5545 §3.2.12). */
const PARTSTAT: Record<RsvpResponse, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
};

export interface RsvpInput {
  /** The invitation's RFC-5545 UID — our key into both routes. */
  icalUid: string;
  response: RsvpResponse;
  organizerEmail?: string | null;
  title?: string | null;
  /** Echoed back in the REPLY so the organizer's client can match it. */
  sequence?: number | null;
  /** ADR 0312 — the `gmail:<threadId>` the invitation came in; it picks the
   *  mailbox that answers. Absent = the primary Gmail. */
  provenance?: string | null;
  /** ADR 0328 — answer from this attached mailbox (the address a family
   *  member was invited at), when there is no email behind the invitation. */
  accountId?: string | null;
}

export interface RsvpResult {
  ok: boolean;
  /** Which route answered. Null when nothing could. */
  via: 'calendar' | 'email' | null;
  reason?: 'not_found' | 'no_organizer' | 'send_failed' | 'no_google' | 'mailbox_cannot_answer';
}

interface GcalAttendee {
  email?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: string;
}

interface GcalEvent {
  id: string;
  iCalUID?: string;
  summary?: string;
  sequence?: number;
  organizer?: { email?: string };
  attendees?: GcalAttendee[];
}

async function gfetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Locate the invitation on one of the user's calendars by UID.
 *
 * `events.list` takes an `iCalUID` filter, which is the only way to go from the
 * UID an email gave us to the id the API addresses events by. `showDeleted` so
 * a previously-declined invite is still answerable — changing your mind is a
 * normal thing to do.
 */
async function findByUid(
  accessToken: string,
  calendarIds: string[],
  icalUid: string,
): Promise<{ calendarId: string; event: GcalEvent } | null> {
  for (const calendarId of calendarIds) {
    const url =
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events` +
      `?iCalUID=${encodeURIComponent(icalUid)}&showDeleted=true&maxResults=2`;
    const res = await gfetch(url, accessToken);
    if (!res.ok) continue;
    const body = (await res.json()) as { items?: GcalEvent[] };
    const event = body.items?.[0];
    if (event) return { calendarId, event };
  }
  return null;
}

/** Answer on ONE Outlook mailbox's calendar — the one the invitation came to. */
async function respondViaOutlook(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  input: RsvpInput,
): Promise<boolean> {
  try {
    const api = await outlookCalendarApiFor(db, userId, accountId);
    if (!api) return false;
    const eventId = await api.findByICalUid(input.icalUid);
    return !!eventId && (await api.respond(eventId, input.response));
  } catch (err) {
    logger.warn(`rsvp: outlook answer failed account=${accountId}: ${(err as Error).message}`);
    return false;
  }
}

/** Answer on ONE attached Gmail's own calendars, with its own token. */
async function respondViaGmailAccount(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  input: RsvpInput,
): Promise<boolean> {
  try {
    const token = await gmailCalendarAccessToken(db, userId, accountId);
    if (!token) return false;
    const found = await findByUid(token, await gmailAccountCalendarIds(db, userId, accountId), input.icalUid);
    return !!found && (await patchResponse(token, found.calendarId, found.event, input.response));
  } catch (err) {
    logger.warn(`rsvp: gmail account answer failed account=${accountId}: ${(err as Error).message}`);
    return false;
  }
}

/** Every Google calendar worth looking on: primary first, then the user's sources. */
async function candidateCalendars(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('calendar_sources')
    .select('google_calendar_id')
    .where('user_id', '=', userId)
    .where('provider', '=', 'google')
    .execute();
  return [
    'primary',
    ...rows
      .map((r) => r.google_calendar_id)
      // ADR 0313 — an attached Gmail's calendars answer for that mailbox only.
      .filter((c) => c !== 'primary' && !isGmailCalendarKey(c)),
  ];
}

/** Calendar and mail robots that relay an invitation for its organizer
 *  (`calendar-notification@google.com`, `invitations@…`). */
const RELAY_LOCAL_PART =
  /^(calendar(-notification|-server)?|notifications?|invitations?|invites?|events?|scheduling|scheduler|meetings?)$/;

/** Could a mail sender be the person who sent this invitation? A robot or
 *  the user's own address cannot (ADR 0104: invitations are relayed). */
export function senderCouldBeOrganizer(address: string, ownAddresses: string[]): boolean {
  const a = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return false;
  if (ownAddresses.some((o) => o.trim().toLowerCase() === a)) return false;
  if (isNoReplyAddress(a)) return false;
  const [local, domain] = a.split('@') as [string, string];
  if (RELAY_LOCAL_PART.test(local)) return false;
  return !/(^|\.)calendar\.google\.com$/.test(domain);
}

/**
 * The fallback for an invitation that names no organizer (an Outlook card
 * staged before Graph's organizer was read, an .ics with no ORGANIZER): the
 * person who sent the email, when that is a person. Only the newest message
 * someone else sent counts; a robot there means nobody, never an older
 * sender who may be someone else entirely.
 */
async function senderOfInvitation(
  db: Kysely<DB>,
  userId: string,
  provenance: string | null | undefined,
): Promise<string | null> {
  const threadId = provenance?.startsWith('gmail:') ? provenance.slice('gmail:'.length) : '';
  if (!threadId) return null;
  const [messages, me, accounts] = await Promise.all([
    db
      .selectFrom('email_messages')
      .select(['from_email', 'internal_date', 'gmail_label_ids'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', threadId)
      .execute(),
    db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('email_accounts').select('email_address').where('user_id', '=', userId).execute(),
  ]);
  const own = [me?.email ?? '', ...accounts.map((a) => a.email_address)].filter(Boolean);
  const received = messages
    .filter((m) => !(m.gmail_label_ids ?? []).includes('SENT'))
    .filter((m) => !own.some((o) => o.toLowerCase() === (m.from_email ?? '').toLowerCase()))
    .sort(byInstant((m) => m.internal_date));
  const newest = received[received.length - 1]?.from_email ?? null;
  return newest && senderCouldBeOrganizer(newest, own) ? newest.trim().toLowerCase() : null;
}

/** Who the answer goes to: the invitation's own organizer, else the
 *  calendar's, else the email's sender when that is a person. */
async function organizerFor(
  db: Kysely<DB>,
  userId: string,
  input: RsvpInput,
  event: GcalEvent | null,
): Promise<string | null> {
  return (
    input.organizerEmail ||
    event?.organizer?.email ||
    (await senderOfInvitation(db, userId, input.provenance))
  );
}

/**
 * Answer an invitation. Returns which route carried the answer so the caller
 * can be honest with the user about what happened. A refusal is logged with
 * its reason: the user sees only a sentence, and without the line nobody can
 * tell which of the routes failed.
 */
export async function respondToInvite(
  db: Kysely<DB>,
  userId: string,
  input: RsvpInput,
): Promise<RsvpResult> {
  const result = await answerInvite(db, userId, input);
  if (!result.ok) {
    logger.warn(
      `rsvp: not answered reason=${result.reason ?? 'unknown'} uid=${input.icalUid} ` +
        `response=${input.response} provenance=${input.provenance ?? 'none'} ` +
        `account=${input.accountId ?? 'none'} organizer=${input.organizerEmail ? 'stored' : 'none'}`,
      { userId },
    );
  }
  return result;
}

async function answerInvite(
  db: Kysely<DB>,
  userId: string,
  input: RsvpInput,
): Promise<RsvpResult> {
  // ADR 0312 — answered by the mailbox the invitation came to and no other:
  // never another account's calendar, never another address.
  const mailbox = input.accountId
    ? { kind: 'account' as const, accountId: input.accountId }
    : ((await mailboxOfProvenance(db, userId, input.provenance)) ?? { kind: 'primary' as const });

  if (mailbox.kind === 'account') {
    const account = await getAccount(db, userId, mailbox.accountId);
    if (!account) return { ok: false, via: null, reason: 'mailbox_cannot_answer' };
    // ADR 0228 — an Outlook mailbox's own calendar has a real answer call.
    if (account.provider === 'outlook' && (await respondViaOutlook(db, userId, account.id, input))) {
      return { ok: true, via: 'calendar' };
    }
    // ADR 0313 — an attached Gmail with its calendar connected answers on
    // that calendar, with that account's token, before mailing a reply.
    if (account.provider === 'gmail' && (await respondViaGmailAccount(db, userId, account.id, input))) {
      return { ok: true, via: 'calendar' };
    }
    return sendItipFromAccount(db, account, input);
  }

  let accessToken: string | null = null;
  try {
    accessToken = await getAccessToken(db, userId);
  } catch {
    return { ok: false, via: null, reason: 'no_google' };
  }

  const found = await findByUid(accessToken, await candidateCalendars(db, userId), input.icalUid);
  if (found) {
    const patched = await patchResponse(accessToken, found.calendarId, found.event, input.response);
    if (patched) return { ok: true, via: 'calendar' };
    // Fall through: a patch that failed is not a reason to leave the
    // organizer uninformed when we can still write to them.
    logger.warn(`rsvp: patch failed, falling back for uid=${input.icalUid}`);
  }
  return sendItipReply(db, userId, input, found?.event ?? null);
}

/** The iTIP REPLY, sent from an attached mailbox's own address. */
async function sendItipFromAccount(
  db: Kysely<DB>,
  account: AccountRow,
  input: RsvpInput,
): Promise<RsvpResult> {
  const organizer = await organizerFor(db, account.user_id, input, null);
  if (!organizer) return { ok: false, via: null, reason: 'no_organizer' };
  const reply: ItipReplyInput = {
    fromEmail: account.email_address,
    fromName: account.display_name ?? null,
    organizerEmail: organizer,
    icalUid: input.icalUid,
    partstat: PARTSTAT[input.response],
    summary: input.title ?? 'Invitation',
    sequence: input.sequence ?? 0,
  };
  try {
    if (account.provider === 'gmail') {
      const { gmailAccountApi } = await import('../email-accounts/gmail-account.service.js');
      await (await gmailAccountApi(db, account)).sendMessage(buildItipReplyRaw(reply));
    } else if (account.provider === 'outlook') {
      const { getOutlookApi } = await import('../email-accounts/outlook-api.js');
      await (await getOutlookApi(db, account)).sendMime(buildItipReplyMime(reply));
    } else {
      const { imapAccountApi } = await import('../email-accounts/imap.service.js');
      await imapAccountApi(account).sendRaw({
        from: account.email_address,
        to: [organizer],
        raw: buildItipReplyMime(reply),
      });
    }
    return { ok: true, via: 'email' };
  } catch (err) {
    logger.warn(
      `rsvp: iTIP send failed account=${account.id} uid=${input.icalUid}: ${(err as Error).message}`,
    );
    return { ok: false, via: null, reason: 'send_failed' };
  }
}

/**
 * Patch our own attendee entry. Google replaces the whole `attendees` array on
 * a patch, so the existing list is sent back with only our row changed —
 * dropping the others would un-invite everybody. `sendUpdates=all` is what
 * makes this a real RSVP rather than a private note to ourselves.
 */
async function patchResponse(
  accessToken: string,
  calendarId: string,
  event: GcalEvent,
  response: RsvpResponse,
): Promise<boolean> {
  const attendees = event.attendees ?? [];
  const self = attendees.find((a) => a.self);
  if (!self) return false;
  const next = attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a));
  const url =
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}` +
    `?sendUpdates=all`;
  const res = await gfetch(url, accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ attendees: next }),
  });
  return res.ok;
}

/**
 * The iTIP route. A REPLY carries exactly one ATTENDEE — us — and the organizer
 * matches it to their event by UID, so the calendar never has to hold a copy
 * for this to work.
 */
async function sendItipReply(
  db: Kysely<DB>,
  userId: string,
  input: RsvpInput,
  event: GcalEvent | null,
): Promise<RsvpResult> {
  const organizer = await organizerFor(db, userId, input, event);
  if (!organizer) return { ok: false, via: null, reason: 'no_organizer' };

  const me = await db
    .selectFrom('users')
    .select(['email', 'display_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!me?.email) return { ok: false, via: null, reason: 'no_google' };

  const raw = buildItipReplyRaw({
    fromEmail: me.email,
    fromName: me.display_name ?? null,
    organizerEmail: organizer,
    icalUid: input.icalUid,
    partstat: PARTSTAT[input.response],
    summary: input.title ?? event?.summary ?? 'Invitation',
    sequence: input.sequence ?? event?.sequence ?? 0,
  });

  try {
    const api = await getGmailApi(db, userId);
    await api.sendMessage(raw);
    return { ok: true, via: 'email' };
  } catch (err) {
    logger.warn(`rsvp: iTIP send failed for uid=${input.icalUid}: ${(err as Error).message}`);
    return { ok: false, via: null, reason: 'send_failed' };
  }
}
