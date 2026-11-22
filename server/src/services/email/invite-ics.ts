/**
 * Calendar-invite emails: detect a text/calendar / .ics part on a mirrored
 * Gmail message and turn it into a DETERMINISTIC create_event payload keyed
 * by the invite's RFC-5545 UID — never an LLM guess at the time. The same
 * UID keys the Google-side event when the user accepts the invite, so the
 * staged proposal and the accepted invite reconcile (executor ical_uid
 * dedup / pull-side external_uid bridge) instead of duplicating.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { getGmailApi, type GmailApi } from '../google/gmail-api.js';
import { findIcsPayloadPart, type GmailRawMessage } from '../google/gmail-sync.js';
import { parseIcsBuffer, type ParsedIcsEvent } from '../ingest/ics/parse.js';

interface IcsPartRef {
  data?: string;
  attachmentId?: string;
}

/** First MIME part that is (or carries) an iCalendar payload. */
export function findIcsPart(raw: GmailRawMessage): IcsPartRef | null {
  return findIcsPayloadPart(raw.payload);
}

export interface InviteProbeResult {
  isInvite: boolean;
  /**
   * First importable VEVENT — null for unparseable or cancellation payloads.
   * Populated whenever the .ics parsed successfully, REGARDLESS of
   * `isInvite`: a PUBLISH/no-METHOD self-itinerary (ADR 0175) still carries a
   * real DTSTART a caller can use as a deterministic date/year anchor (ADR
   * 0177) even though it isn't routed as an invite.
   */
  event: ParsedIcsEvent | null;
  /** UIDs a METHOD:CANCEL / STATUS:CANCELLED payload retracts. */
  cancelledUids: string[];
  /** ADR 0328 — a METHOD:REPLY's answers (who, what, which event). */
  replies?: Array<{ uid: string; email: string; partstat: string }>;
}

// RFC 5546 iTIP transaction methods — an actual invitation workflow the
// recipient is expected to answer (REQUEST), was told is off (CANCEL), or
// is hearing a reply to (REPLY/COUNTER/DECLINECOUNTER). PUBLISH — and a
// calendar with no METHOD line at all, which defaults to the same posture —
// is a plain, informational calendar object: exactly what Expedia/airline/
// venue confirmations attach so "Add to calendar" works, describing the
// SENDER'S own itinerary rather than asking the recipient to RSVP to
// anything. Treating every attached .ics as an invite routed every such
// confirmation around the trip classifier (ADR 0158) and the general
// magics extractor into a bare, un-enriched calendar event instead.
const INVITE_TRANSACTION_METHODS = new Set(['REQUEST', 'CANCEL', 'REPLY', 'COUNTER', 'DECLINECOUNTER']);
/** iTIP methods that answer an invitation rather than make one. */
const ANSWER_METHODS = new Set(['REPLY', 'COUNTER', 'DECLINECOUNTER']);

/** Parse an iCalendar buffer into the probe result shape (never throws). */
export function probeResultFromIcs(buf: Buffer): InviteProbeResult {
  try {
    const parsed = parseIcsBuffer(buf);
    // isInvite is a ROUTING decision (ADR 0175); the parsed event itself is
    // surfaced either way so a non-invite caller can still read its date.
    const isInvite = !!parsed.method && INVITE_TRANSACTION_METHODS.has(parsed.method);
    return {
      isInvite,
      // A reply is an answer to a meeting that already exists - usually the
      // user's own "Accepted:" or a guest's answer to the user's invitation.
      // It is handled with nothing staged; its VEVENT staged an RSVP card for
      // a meeting the user had already answered or organized.
      event: parsed.method && ANSWER_METHODS.has(parsed.method) ? null : (parsed.events[0] ?? null),
      cancelledUids: parsed.cancelledUids,
      replies: parsed.replies,
    };
  } catch {
    return { isInvite: true, event: null, cancelledUids: [] };
  }
}

/**
 * The probe answer from the .ics captured at sync (`email_messages.ics_text`),
 * or null when nothing was captured (NULL: a row from before the capture, or a
 * Gmail .ics sent as a separate attachment) and the message must be fetched.
 * `gmailMessageId` is the stored id - account-scoped for an attached mailbox.
 */
export async function storedInviteProbe(
  db: Kysely<DB>,
  userId: string,
  gmailMessageId: string,
): Promise<InviteProbeResult | null> {
  const row = await db
    .selectFrom('email_messages')
    .select('ics_text')
    .where('user_id', '=', userId)
    .where('gmail_message_id', '=', gmailMessageId)
    .executeTakeFirst();
  if (!row || row.ics_text === null) return null;
  return row.ics_text === ''
    ? { isInvite: false, event: null, cancelledUids: [] }
    : probeResultFromIcs(Buffer.from(row.ics_text, 'utf8'));
}

/**
 * Probe one message through a Gmail-shaped api (primary mailbox OR a
 * secondary Gmail account, ADR 0080 — same wire format either way).
 */
export async function inviteEventViaGmailApi(
  api: GmailApi,
  gmailMessageId: string,
): Promise<InviteProbeResult> {
  const raw = await api.getMessage(gmailMessageId, 'full');
  if (!raw) return { isInvite: false, event: null, cancelledUids: [] };
  const part = findIcsPart(raw);
  if (!part) return { isInvite: false, event: null, cancelledUids: [] };
  let buf: Buffer | null = null;
  if (part.data) {
    buf = Buffer.from(part.data, 'base64url');
  } else if (part.attachmentId) {
    const att = await api.getAttachment(gmailMessageId, part.attachmentId);
    buf = Buffer.from(att.data, 'base64url');
  }
  if (!buf) return { isInvite: true, event: null, cancelledUids: [] };
  return probeResultFromIcs(buf);
}

/**
 * Fetch a mirrored message in full and, when it carries a calendar part,
 * parse its first VEVENT. `isInvite` distinguishes "invite but unparseable"
 * (skip LLM extraction — the calendar-accept path is authoritative) from
 * "not an invite" (normal LLM path). A cancellation payload yields no event
 * and the UIDs it cancels.
 */
export async function inviteEventForMessage(
  db: Kysely<DB>,
  userId: string,
  gmailMessageId: string,
): Promise<InviteProbeResult> {
  const stored = await storedInviteProbe(db, userId, gmailMessageId);
  if (stored) return stored;
  const api = await getGmailApi(db, userId);
  return inviteEventViaGmailApi(api, gmailMessageId);
}
