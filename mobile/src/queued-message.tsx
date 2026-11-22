/**
 * ADR 0311 addendum - a chat message written offline, shown where the person
 * wrote it until the server has it: "Waiting to send", or, when the server
 * refused it, why, with Retry and Delete.
 */
import { Pressable, Text, View } from 'react-native';
import { QUEUED_CHAT_ID_PREFIX, type Message, type QueuedSend } from '@chord/kernel';

import type { ChatSendPayload } from '@/chat-outbox';
import { deleteQueuedSend, retryQueuedSend } from '@/send-queue';
import { themed } from '@/theme';

/** A list row for a queued message. Never sent anywhere: the id marks it as local. */
export function queuedAsMessage(m: QueuedSend<ChatSendPayload>): Message {
  return {
    id: `${QUEUED_CHAT_ID_PREFIX}${m.localId}`,
    groupId: m.payload.groupId,
    senderId: null,
    kind: 'text',
    body: m.payload.body,
    mentionsBot: false,
    createdAt: new Date(m.queuedAt).toISOString(),
  };
}

export function QueuedMessage({ item }: { item: QueuedSend<ChatSendPayload> }) {
  const failed = item.status === 'failed';
  return (
    <View style={styles.row}>
      <View style={[styles.bubble, failed && styles.bubbleFailed]}>
        <Text style={styles.body}>{item.payload.body}</Text>
        <Text style={[styles.status, failed && styles.statusFailed]}>
          {failed ? `Not sent: ${item.error ?? 'refused'}` : '🕓 Waiting to send'}
        </Text>
        {failed ? (
          <View style={styles.actions}>
            <Pressable onPress={() => retryQueuedSend(item.localId)} hitSlop={6}>
              <Text style={styles.action}>Retry</Text>
            </Pressable>
            <Pressable onPress={() => deleteQueuedSend(item.localId)} hitSlop={6}>
              <Text style={styles.action}>Delete</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  row: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 8 },
  bubble: {
    padding: 10,
    borderRadius: 14,
    borderBottomRightRadius: 4,
    backgroundColor: colors.rightBubble,
    opacity: 0.7,
    maxWidth: '80%',
  },
  bubbleFailed: { opacity: 1, borderWidth: 1, borderColor: colors.red },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  status: { fontSize: 11, color: colors.muted, marginTop: 4, textAlign: 'right' },
  statusFailed: { color: colors.red },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 14, marginTop: 6 },
  action: { fontSize: 13, color: colors.accent, fontWeight: '600' },
}));
