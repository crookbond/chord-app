/**
 * Junk peek (ADR 0080 addendum): a live, read-only view of every mailbox's
 * spam folder - verification codes and password resets land there constantly.
 * Nothing here is mirrored or fed to the AI; "Not junk" moves the message to
 * that mailbox's inbox, and the normal sync takes it from there.
 */
import { useCallback, useEffect, useState } from 'react';
import { Stack, router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import type { JunkMessage } from '@chord/kernel';

import { listJunkMail, rescueJunkMail } from '@/api';
import { colors, themed } from '@/theme';
import { backHomeHeaderLeft } from '@/back-home';
import { useBusyKeys } from '@/busy-keys';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

export default function JunkScreen() {
  const [items, setItems] = useState<JunkMessage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { has: isBusy, start: startBusy, end: endBusy } = useBusyKeys();
  const [openKey, setOpenKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      setItems(await listJunkMail());
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rescue = useCallback(
    async (key: string) => {
      startBusy(key);
      setErr(null);
      try {
        await rescueJunkMail(key);
        setItems((prev) => prev?.filter((m) => m.key !== key) ?? prev);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        endBusy(key);
      }
    },
    [startBusy, endBusy],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Junk', headerLeft: backHomeHeaderLeft('Email', '/email') }} />
      <Text style={styles.note}>
        Read straight from each mailbox&rsquo;s spam folder - never imported, never used by the
        assistant. &ldquo;Not junk&rdquo; moves a message to your inbox.
      </Text>
      {err ? <Text style={styles.err}>{err}</Text> : null}
      {items === null ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 32 }} />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>No junk in the last 7 days. Lucky you.</Text>
      ) : (
        <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
          data={items}
          keyExtractor={(m) => m.key}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => {
            const open = openKey === item.key;
            return (
              <Pressable
                style={styles.row}
                onPress={() => setOpenKey(open ? null : item.key)}
              >
                <View style={styles.rowHead}>
                  <Text style={styles.mailbox}>{item.mailbox}</Text>
                  <Text style={styles.date}>{new Date(item.date).toLocaleDateString()}</Text>
                </View>
                <Text style={styles.from} numberOfLines={1}>
                  {item.fromName ?? item.fromEmail ?? '(unknown sender)'}
                </Text>
                <Text style={styles.subject} numberOfLines={open ? undefined : 1}>
                  {item.subject || '(no subject)'}
                </Text>
                <Text style={styles.snippet} numberOfLines={open ? undefined : 2}>
                  {open ? item.bodyText ?? item.snippet : item.snippet}
                </Text>
                <Pressable
                  style={[styles.rescueBtn, isBusy(item.key) && styles.disabled]}
                  disabled={isBusy(item.key)}
                  onPress={() => void rescue(item.key)}
                >
                  {isBusy(item.key) ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Text style={styles.rescueTxt}>Not junk - move to inbox</Text>
                  )}
                </Pressable>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
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
  err: { color: colors.red, marginBottom: 8 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40 },
  row: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  mailbox: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  date: { color: colors.muted, fontSize: 11 },
  from: { color: colors.text, fontWeight: '600', fontSize: 14 },
  subject: { color: colors.text, fontSize: 14, marginTop: 2 },
  snippet: { color: colors.muted, fontSize: 13, marginTop: 2 },
  rescueBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 8,
  },
  rescueTxt: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  disabled: { opacity: 0.4 },
}));
