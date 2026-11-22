import { isNoReplyAddress } from './email-vacation';

/**
 * Who an email-suggested meeting invites (ADR 0315 addendum).
 *
 * The model says only WHICH people ("sender" for a one-on-one, "all" for a
 * meeting of everyone on the email); the addresses come from the message's
 * own From / To / Cc, so none is ever written by the model. The user's own
 * addresses and no-reply robots are never invited. Order: sender first, then
 * To, then Cc, each address once.
 */
export type MeetingInviteScope = 'sender' | 'all';

export const MAX_MEETING_INVITEES = 20;

export function meetingInvitees(
  who: MeetingInviteScope,
  msg: { from: string | null; to: string[]; cc: string[] },
  ownAddresses: string[],
): string[] {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  // "sender" is the other side of a one-on-one: when the newest message is
  // the user's own, that is who it was written to.
  const fromIsOwn = own.has((msg.from ?? '').trim().toLowerCase());
  const candidates =
    who === 'sender' ? (fromIsOwn ? msg.to.slice(0, 1) : [msg.from]) : [msg.from, ...msg.to, ...msg.cc];
  const out: string[] = [];
  for (const raw of candidates) {
    const a = (raw ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) continue;
    if (own.has(a) || isNoReplyAddress(a) || out.includes(a)) continue;
    out.push(a);
    if (out.length >= MAX_MEETING_INVITEES) break;
  }
  return out;
}
