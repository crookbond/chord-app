/**
 * ADR 0212 — ask the asker's own phone about one name in its Contacts.
 *
 * The bot runs on the server and the address book lives on the phone, which
 * never uploads it (ADR 0065/0157). So a turn that needs "Ben's email"
 * broadcasts one `contact.lookup` on the turn's channel (the personal chat, or
 * a shared chat for an event invitee, ADR 0157 addendum) and waits for
 * the app to POST back the matching entries. Nothing is stored: the answer
 * lives in this map for at most one turn and then only in the reply the user
 * asked for.
 *
 * The waiting turn is held in this process's memory. The phone's POST can land
 * on any web copy (ADR 0280), so a copy that is not holding the request hands
 * the answer to the others over Redis pub/sub — passed along, never stored.
 */
import { SSE, type DeviceContactLookupResponse } from '@chord/kernel';

import { newId } from '../../utils/ids.js';
import { sseHub } from '../sse.hub.js';
import type { SseBroadcaster } from './executor.js';

const PEER_TOPIC = 'contact-lookup-answer';

interface ForwardedAnswer {
  userId: string;
  requestId: string;
  response: DeviceContactLookupResponse;
}

export type DeviceLookupOutcome =
  | DeviceContactLookupResponse
  /** No device answered in time: app closed, web client, or a bridged chat. */
  | { status: 'unavailable'; matches: [] };

interface Pending {
  userId: string;
  resolve: (r: DeviceLookupOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export async function requestDeviceContact(args: {
  emit: SseBroadcaster;
  groupId: string;
  userId: string;
  query: string;
  /** ADR 0275: look the query up as a role, by these words. */
  role?: string[];
  timeoutMs: number;
}): Promise<DeviceLookupOutcome> {
  const requestId = newId('cl');
  const result = new Promise<DeviceLookupOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ status: 'unavailable', matches: [] });
    }, args.timeoutMs);
    pending.set(requestId, { userId: args.userId, resolve, timer });
  });
  // `forUserId`: an invitee lookup can run in a shared chat, where every
  // member's phone hears this; only the asker's may search (ADR 0157 addendum).
  args.emit(args.groupId, SSE.contactLookup, {
    requestId,
    query: args.query,
    forUserId: args.userId,
    ...(args.role ? { role: args.role } : {}),
  });
  return result;
}

/**
 * The phone's answer. The first answer wins; an answer from a different user
 * than the one who asked is refused, so a request id alone cannot inject
 * contact data into someone else's turn. That check runs wherever the request
 * is held, including for a forwarded answer.
 */
function answerLocal(userId: string, requestId: string, response: DeviceContactLookupResponse): boolean {
  const p = pending.get(requestId);
  if (!p || p.userId !== userId) return false;
  pending.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(response);
  return true;
}

/**
 * True when the answer reached a waiting turn here or was handed to the other
 * copies (which cannot report back whether one of them was waiting); false
 * only when no copy could be holding it.
 */
export function answerDeviceContactLookup(
  userId: string,
  requestId: string,
  response: DeviceContactLookupResponse,
): boolean {
  if (answerLocal(userId, requestId, response)) return true;
  const forwarded: ForwardedAnswer = { userId, requestId, response };
  return sseHub.sendToPeers(PEER_TOPIC, forwarded);
}

sseHub.onPeerMessage(PEER_TOPIC, (data) => {
  const a = data as ForwardedAnswer;
  answerLocal(a.userId, a.requestId, a.response);
});
