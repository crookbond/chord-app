/**
 * Drafts (ADR 0113).
 *
 * These are Chord's drafts, not the provider's. A draft you started in Gmail
 * stays in Gmail, and the footer says so — the same honesty the ADR 0108 Sent
 * folder owes about mailboxes it only partly mirrors. A list that quietly held
 * half of what the word "Drafts" means would be worse than no list.
 */
import { useCallback, useState } from 'react';
import { Stack, router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import type { EmailDraft } from '@chord/kernel';

import { deleteEmailDraft, listEmailDrafts } from '@/api';
import { confirmDestructive } from '@/confirm';
import { colors, themed } from '@/theme';
import { backHomeHeaderLeft, goBackOr } from '@/back-home';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

const KIND_LABEL: Record<EmailDraft['kind'], string> = {
  new: 'New message',
  reply: 'Reply',
  forward: 'Forward',
};

function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function DraftsScreen() {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDrafts(await listEmailDrafts());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const open = useCallback((draft: EmailDraft) => {
    // A reply draft belongs to its thread, so resuming means opening the
    // thread — the composer there picks its own draft back up by thread id.
    if (draft.kind === 'reply' && draft.threadId) {
      router.push(`/email/${draft.threadId}`);
      return;
    }
    if (draft.kind === 'forward' && draft.threadId) {
      router.push(
        draft.forwardMessageId
          ? `/email/forward/${draft.threadId}?message=${encodeURIComponent(draft.forwardMessageId)}`
          : `/email/forward/${draft.threadId}`,
      );
      return;
    }
    router.push(`/email/compose?draft=${draft.id}`);
  }, []);

  const discard = useCallback(
    (draft: EmailDraft) => {
      confirmDestructive(
        'Discard draft?',
        `"${draft.preview}" will be deleted.`,
        () => {
          // Dropped locally first so the row goes on the tap; a failed delete
          // reloads, which puts it back rather than lying about it.
          setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
          void deleteEmailDraft(draft.id).catch(() => void load());
        },
        { confirmLabel: 'Discard' },
      );
    },
    [load],
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Drafts', headerLeft: backHomeHeaderLeft('Email', '/email') }} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
          data={drafts}
          keyExtractor={(d) => d.id}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => open(item)}>
              <View style={styles.rowMain}>
                <View style={styles.rowTop}>
                  <Text style={styles.kind}>{KIND_LABEL[item.kind]}</Text>
                  <Text style={styles.when}>{relTime(item.updatedAt)}</Text>
                </View>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.preview}
                </Text>
                {item.to.length ? (
                  <Text style={styles.to} numberOfLines={1}>
                    To: {item.to.join(', ')}
                  </Text>
                ) : null}
              </View>
              <Pressable onPress={() => discard(item)} hitSlop={10}>
                <Text style={styles.discard}>×</Text>
              </Pressable>
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.muted}>{err ?? 'Nothing unsent.'}</Text>
            </View>
          }
          ListFooterComponent={
            drafts.length ? (
              <Text style={styles.foot}>
                Drafts you started in Chord. Anything you began in your mail app stays there.
              </Text>
            ) : null
          }
          contentContainerStyle={drafts.length === 0 ? styles.emptyList : undefined}
        />
      )}
    </View>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: colors.muted, fontSize: 14 },
  emptyList: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kind: { color: colors.accent, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  when: { color: colors.muted, fontSize: 11 },
  preview: { color: colors.text, fontSize: 15, fontWeight: '500' },
  to: { color: colors.muted, fontSize: 12 },
  discard: { color: colors.muted, fontSize: 22, lineHeight: 22 },
  sep: { height: 1, backgroundColor: colors.border },
  foot: { color: colors.muted, fontSize: 12, padding: 16, textAlign: 'center' },
}));
