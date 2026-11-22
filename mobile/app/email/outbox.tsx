/**
 * Outbox (ADR 0311): email sent with no network, waiting in the shared send
 * queue (ADR 0311 addendum), and drafts that could not reach the server. Each
 * goes on its own once the server answers; this screen shows what is waiting
 * and why something did not go, with Send now, Retry and Delete.
 */
import { useCallback, useMemo } from 'react';
import { Stack, router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { QueuedSend } from '@chord/kernel';

import { confirmDestructive } from '@/confirm';
import {
  removePhoneDraft,
  useEmailOutbox,
  usePhoneDrafts,
  type EmailOutboxPayload,
  type LocalEmailDraft,
} from '@/email-outbox';
import { useOnline } from '@/network';
import { deleteQueuedSend, flushSendQueue, retryQueuedSend } from '@/send-queue';
import { themed } from '@/theme';
import { backHomeHeaderLeft } from '@/back-home';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

type Item = QueuedSend<EmailOutboxPayload>;

export default function OutboxScreen() {
  const items = useEmailOutbox();
  const drafts = usePhoneDrafts();
  const online = useOnline();

  const ordered = useMemo(() => [...items].sort((a, b) => a.queuedAt - b.queuedAt), [items]);
  const phoneDrafts = useMemo(
    () => [...drafts].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [drafts],
  );

  const remove = useCallback((item: Item) => {
    confirmDestructive(
      'Delete this message?',
      'It has not been sent and will not be.',
      () => deleteQueuedSend(item.localId),
      { confirmLabel: 'Delete' },
    );
  }, []);

  const removeDraft = useCallback((d: LocalEmailDraft) => {
    confirmDestructive(
      'Delete this draft?',
      'It is only on this phone, so it will be gone.',
      () => void removePhoneDraft(d.key),
      { confirmLabel: 'Delete' },
    );
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Outbox', headerLeft: backHomeHeaderLeft('Email', '/email') }} />
      <ScrollView {...DISMISS_KEYBOARD_ON_DRAG} contentContainerStyle={{ paddingBottom: 32 }}>
        <Text style={styles.note}>
          {online
            ? 'Email waiting to send. It goes on its own, oldest first.'
            : "You're offline. Email you send waits here and goes, oldest first, when you're back online."}
        </Text>

        {ordered.length === 0 ? <Text style={styles.empty}>Nothing waiting to send.</Text> : null}
        {ordered.map((i) => (
          <View key={i.localId} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.who} numberOfLines={1}>
                {recipientsLine(i.payload)}
              </Text>
              <Text style={styles.subject} numberOfLines={1}>
                {subjectLine(i.payload)}
              </Text>
              <Text style={[styles.meta, i.status === 'failed' && styles.failed]}>
                {i.status === 'failed'
                  ? `Not sent: ${i.error ?? 'it could not be sent'}`
                  : `Waiting since ${when(i.queuedAt)}`}
              </Text>
            </View>
            <View style={styles.actions}>
              {i.status === 'failed' ? (
                <Pressable onPress={() => retryQueuedSend(i.localId)} hitSlop={8}>
                  <Text style={styles.sendTxt}>Retry</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => void flushSendQueue()} disabled={!online} hitSlop={8}>
                  <Text style={[styles.sendTxt, !online && styles.disabled]}>Send now</Text>
                </Pressable>
              )}
              <Pressable onPress={() => remove(i)} hitSlop={8}>
                <Text style={styles.removeTxt}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}

        {phoneDrafts.length > 0 ? (
          <>
            <Text style={styles.section}>Drafts saved on this phone</Text>
            <Text style={styles.note}>They go to Drafts when you&apos;re back online.</Text>
            {phoneDrafts.map((d) => (
              <View key={d.key} style={styles.row}>
                <Pressable style={{ flex: 1 }} onPress={() => openDraft(d)}>
                  <Text style={styles.who} numberOfLines={1}>
                    {d.to.length ? `To ${d.to.join(', ')}` : kindLabel(d.kind)}
                  </Text>
                  <Text style={styles.subject} numberOfLines={1}>
                    {d.subject?.trim() || d.body?.trim().split('\n')[0] || '(nothing written yet)'}
                  </Text>
                  <Text style={[styles.meta, d.error ? styles.failed : null]}>
                    {d.error ? `Could not be saved: ${d.error}` : `Saved ${when(Date.parse(d.updatedAt))}`}
                  </Text>
                </Pressable>
                <Pressable onPress={() => removeDraft(d)} hitSlop={8}>
                  <Text style={styles.removeTxt}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** A reply or forward opens on its thread, where its composer finds the copy;
 *  a new message opens the composer on the phone copy itself. */
function openDraft(d: LocalEmailDraft): void {
  if (d.kind === 'reply' && d.threadId) router.push(`/email/${d.threadId}`);
  else if (d.kind === 'forward' && d.threadId) router.push(`/email/forward/${d.threadId}`);
  else router.push({ pathname: '/email/compose', params: { local: d.key } });
}

function kindLabel(kind: EmailOutboxPayload['kind']): string {
  return kind === 'reply' ? 'Reply' : kind === 'forward' ? 'Forward' : 'New message';
}

function recipientsLine(p: EmailOutboxPayload): string {
  if (p.to.length) return `To ${p.to.join(', ')}`;
  return p.kind === 'reply' ? 'Reply to the sender' : kindLabel(p.kind);
}

function subjectLine(p: EmailOutboxPayload): string {
  const lead = p.kind === 'new' ? p.subject?.trim() : kindLabel(p.kind);
  const first = p.body.trim().split('\n')[0];
  return [lead, first].filter(Boolean).join(' · ') || '(no text)';
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const styles = themed((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  back: { color: colors.accent, fontSize: 16, width: 48 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 12, marginBottom: 12 },
  section: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 16, marginBottom: 4 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 16, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    gap: 12,
  },
  who: { color: colors.text, fontWeight: '600', fontSize: 14 },
  subject: { color: colors.text, fontSize: 13, marginTop: 2 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  failed: { color: colors.red },
  actions: { alignItems: 'flex-end', gap: 10 },
  sendTxt: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  removeTxt: { color: colors.red, fontWeight: '600', fontSize: 13 },
  disabled: { opacity: 0.4 },
}));
