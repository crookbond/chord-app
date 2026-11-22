/**
 * Provider-aware calendar-invite probe for attached mailboxes (ADR 0074 ×
 * 0080). Same contract as the primary-Gmail probe: deterministic invite
 * facts or "not an invite" — never an LLM guess, and a probe FAILURE throws
 * so the caller defers the thread instead of falling through.
 *
 *  - gmail   → same Gmail wire format, the account's own token
 *  - outlook → Graph's native eventMessage representation (no raw MIME)
 *  - imap    → the text/calendar part captured off the fetched MIME source
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import type { InviteProbeResult } from '../email/invite-ics.js';
import { inviteEventViaGmailApi, probeResultFromIcs, storedInviteProbe } from '../email/invite-ics.js';
import { getAccount, nativeId, AccountAuthError, type AccountRow } from './account-utils.js';
import { gmailAccountApi } from './gmail-account.service.js';
import { imapAccountApi } from './imap.service.js';
import { uidFromNativeMessageId } from './imap-sync.js';
import { getOutlookApi } from './outlook-api.js';

const NOT_INVITE: InviteProbeResult = { isInvite: false, event: null, cancelledUids: [] };

/** Graph UTC wall time (`2026-08-01T17:00:00.0000000` + tz) → ISO instant. */
function graphUtcToIso(dt?: { dateTime?: string; timeZone?: string } | null): string | null {
  if (!dt?.dateTime) return null;
  // Prefer: outlook.timezone="UTC" pins the zone; anything else is a config
  // surprise we treat as unparseable rather than guessing an offset.
  if (dt.timeZone && dt.timeZone.toUpperCase() !== 'UTC') return null;
  return `${dt.dateTime.replace(/\.\d+$/, '')}Z`;
}

async function probeOutlook(
  db: Kysely<DB>,
  account: AccountRow,
  native: string,
): Promise<InviteProbeResult> {
  const api = await getOutlookApi(db, account);
  const info = await api.getMeetingInfo(native);
  if (!info) return NOT_INVITE;
  if (info.meetingMessageType === 'meetingCancelled') {
    return {
      isInvite: true,
      event: null,
      cancelledUids: info.event?.iCalUId ? [info.event.iCalUId] : [],
    };
  }
  if (info.meetingMessageType !== 'meetingRequest') {
    // Accept/decline/tentative notifications: invite-adjacent, never a new
    // event — mark handled with nothing staged.
    return { isInvite: true, event: null, cancelledUids: [] };
  }
  const startsAt = graphUtcToIso(info.event?.start);
  const endsAt = graphUtcToIso(info.event?.end);
  if (!info.event || !startsAt || !info.event.subject) {
    return { isInvite: true, event: null, cancelledUids: [] };
  }
  const organizer = info.event.organizer?.emailAddress?.address?.trim().toLowerCase() ?? '';
  return {
    isInvite: true,
    event: {
      uid: info.event.iCalUId ?? `outlook:${account.id}:${native}`,
      title: info.event.subject,
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      ...(info.event.isAllDay ? { allDay: true } : {}),
      ...(info.event.location?.displayName
        ? { location: info.event.location.displayName }
        : {}),
      ...(organizer.includes('@') ? { organizer } : {}),
    },
    cancelledUids: [],
  };
}

/**
 * The .ics is captured at sync (IMAP parses the whole source anyway), so the
 * common case costs no network at all — this runs once per thread inside the
 * magics loop, and a login apiece is exactly what Yahoo throttles. A NULL
 * column means the row predates that capture; only then do we go to the wire.
 */
async function probeImap(
  db: Kysely<DB>,
  account: AccountRow,
  scopedMessageId: string,
  native: string,
): Promise<InviteProbeResult> {
  const uid = uidFromNativeMessageId(native);
  if (uid === null) return NOT_INVITE; // locally-synthesized sent copy

  const row = await db
    .selectFrom('email_messages')
    .select('ics_text')
    .where('user_id', '=', account.user_id)
    .where('gmail_message_id', '=', scopedMessageId)
    .executeTakeFirst();
  if (row && row.ics_text !== null) {
    return row.ics_text === ''
      ? NOT_INVITE
      : probeResultFromIcs(Buffer.from(row.ics_text, 'utf8'));
  }

  const [msg] = await imapAccountApi(account).fetch([uid]);
  if (!msg?.icsText) return NOT_INVITE;
  return probeResultFromIcs(Buffer.from(msg.icsText, 'utf8'));
}

/**
 * Probe an attached account's mirrored message (scoped id) for a calendar
 * invite. Throws on api/credential failure — the caller defers the thread.
 */
export async function inviteEventForAccountMessage(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  scopedMessageId: string,
): Promise<InviteProbeResult> {
  const account = await getAccount(db, userId, accountId);
  if (!account) {
    throw new AccountAuthError(`email account ${accountId} not found`, { needsReconnect: true });
  }
  const native = nativeId(account.id, scopedMessageId);
  if (native.startsWith('sent-')) return NOT_INVITE;
  if (account.provider === 'gmail') {
    const stored = await storedInviteProbe(db, userId, scopedMessageId);
    if (stored) return stored;
    return inviteEventViaGmailApi(await gmailAccountApi(db, account), native);
  }
  if (account.provider === 'outlook') {
    return probeOutlook(db, account, native);
  }
  return probeImap(db, account, scopedMessageId, native);
}
