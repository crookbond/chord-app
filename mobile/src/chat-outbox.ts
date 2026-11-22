/**
 * ADR 0311 addendum - chat messages on the shared send queue (`send-queue.ts`).
 * Written offline, a message waits on the phone and goes out, in order, when
 * the server answers; the chat shows it where it was written meanwhile.
 *
 * Files are not queued: an upload needs the bytes on the wire, and a picked
 * file's address on the phone is not guaranteed to outlive the app.
 */
import { useMemo } from 'react';
import type { QueuedSend } from '@chord/kernel';

import { postMessage } from './api';
import { registerSender, sendOrQueue, useSendQueue } from './send-queue';

export interface ChatSendPayload {
  groupId: string;
  body: string;
  tz?: string;
}

async function sendChat(p: ChatSendPayload, sendId: string): Promise<void> {
  await postMessage(p.groupId, { body: p.body, ...(p.tz ? { tz: p.tz } : {}) }, sendId);
}

registerSender<ChatSendPayload>('chat', sendChat);

/** Send a chat message, or queue it when it cannot go now. A server refusal is thrown. */
export function sendChatText(
  groupId: string,
  body: string,
  tz?: string,
): Promise<'sent' | 'queued'> {
  return sendOrQueue<ChatSendPayload>('chat', { groupId, body, ...(tz ? { tz } : {}) }, sendChat);
}

/** What is waiting to go to this chat, oldest first. */
export function useQueuedChat(groupId: string | undefined): QueuedSend<ChatSendPayload>[] {
  const all = useSendQueue();
  return useMemo(
    () =>
      groupId
        ? (
            all.filter(
              (m) => m.kind === 'chat' && (m.payload as ChatSendPayload).groupId === groupId,
            ) as QueuedSend<ChatSendPayload>[]
          ).sort((a, b) => a.queuedAt - b.queuedAt)
        : [],
    [all, groupId],
  );
}
