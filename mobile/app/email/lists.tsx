/**
 * Mailing lists: every sender whose mail says how to leave it, busiest first,
 * each with Unsubscribe. The lists the user never opens are marked, and a
 * filter shows only those.
 *
 * One button, three honest outcomes (ADR 0122): the message under a row comes
 * from the server, because only it knows which mechanism the sender offered.
 * A link-only list opens the sender's page and claims nothing.
 *
 * A list Chord could not leave (its request failed, it only has a web page, or
 * it keeps mailing after being asked) says so and offers the two ways out
 * (ADR 0308): finish on the sender's page, or send its future mail to Trash.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, router } from 'expo-router';
import { ActivityIndicator, FlatList, Linking, Platform, Pressable, Text, View } from 'react-native';
import type { EmailMailingList } from '@chord/kernel';

import { listMailingLists, setMailAutoTrash, unsubscribeEmailThread, unsubscribeFromLists } from '@/api';
import { confirmDestructive } from '@/confirm';
import { colors, themed } from '@/theme';
import { backHomeHeaderLeft } from '@/back-home';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

interface RowOutcome {
  message: string;
  /** The sender's own unsubscribe page, when there is one. */
  url?: string;
  /** Chord could not leave this list for the user. */
  needsYou?: boolean;
}

async function openPage(url: string): Promise<void> {
  if (Platform.OS === 'web') window.open(url, '_blank');
  else await Linking.openURL(url);
}

export default function MailingListsScreen() {
  const [lists, setLists] = useState<EmailMailingList[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, RowOutcome>>({});
  const [unreadOnly, setUnreadOnly] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      setLists(await listMailingLists());
    } catch (e) {
      setErr((e as Error).message);
      setLists([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(
    () => (lists ?? []).filter((l) => !unreadOnly || l.opened === 0),
    [lists, unreadOnly],
  );
  const neverOpened = (lists ?? []).filter((l) => l.opened === 0).length;
  // What "Unsubscribe from all" acts on: the rows on screen Chord can leave in
  // one go. A web-page-only list needs the user on that page, one at a time.
  const leavable = shown.filter((l) => !l.requestedAt && (l.kind === 'one_click' || l.kind === 'mailto'));

  const unsubscribeAll = useCallback(() => {
    const targets = leavable;
    if (targets.length === 0) return;
    confirmDestructive(
      `Unsubscribe from ${targets.length} list${targets.length === 1 ? '' : 's'}?`,
      targets.map((l) => l.senderName ?? l.senderEmail).join(', '),
      () => {
        void (async () => {
          setBusy('*');
          try {
            const { results } = await unsubscribeFromLists(targets.map((l) => l.senderEmail));
            setOutcome((prev) => {
              const next = { ...prev };
              for (const r of results) {
                next[r.senderEmail] = { message: r.message, url: r.url, needsYou: r.needsYou };
              }
              return next;
            });
            await refresh();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(null);
          }
        })();
      },
      { confirmLabel: 'Unsubscribe' },
    );
  }, [leavable, refresh]);

  const unsubscribe = useCallback(
    async (list: EmailMailingList) => {
      setBusy(list.senderEmail);
      try {
        const out = await unsubscribeEmailThread(list.threadId);
        const needsYou = !out.unsubscribed && !out.requested;
        setOutcome((prev) => ({ ...prev, [list.senderEmail]: { message: out.message, url: out.url, needsYou } }));
        // A link-only list was asked for by this tap, so its page opens now; a
        // failed one-click waits for "Open their page" rather than surprising them.
        if (out.url && out.kind === 'link') await openPage(out.url);
        if (out.unsubscribed || out.requested) await refresh();
      } catch (e) {
        setOutcome((prev) => ({ ...prev, [list.senderEmail]: { message: (e as Error).message, needsYou: true } }));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const setTrash = useCallback(
    async (list: EmailMailingList, on: boolean) => {
      setBusy(list.senderEmail);
      try {
        await setMailAutoTrash([list.senderEmail], on);
        await refresh();
      } catch (e) {
        setOutcome((prev) => ({ ...prev, [list.senderEmail]: { message: (e as Error).message } }));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const offerTrash = useCallback(
    (list: EmailMailingList) => {
      confirmDestructive(
        `Send future mail from ${list.senderName ?? list.senderEmail} to Trash?`,
        'From now on, new email from this sender goes to Trash. Mail already here stays where it is, and anything in Trash can be recovered.',
        () => void setTrash(list, true),
        { confirmLabel: 'Send to Trash' },
      );
    },
    [setTrash],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Mailing lists', headerLeft: backHomeHeaderLeft('Email', '/email') }} />
      <Text style={styles.note}>
        Senders whose email says how to leave their list, from the last 90 days, most email first.
      </Text>
      {lists && lists.length > 0 ? (
        <View style={styles.chips}>
          <Pressable style={[styles.chip, !unreadOnly && styles.chipOn]} onPress={() => setUnreadOnly(false)}>
            <Text style={[styles.chipTxt, !unreadOnly && styles.chipTxtOn]}>All · {lists.length}</Text>
          </Pressable>
          <Pressable style={[styles.chip, unreadOnly && styles.chipOn]} onPress={() => setUnreadOnly(true)}>
            <Text style={[styles.chipTxt, unreadOnly && styles.chipTxtOn]}>Never opened · {neverOpened}</Text>
          </Pressable>
        </View>
      ) : null}
      {leavable.length > 1 ? (
        <Pressable
          style={[styles.allBtn, busy !== null && styles.disabled]}
          disabled={busy !== null}
          onPress={unsubscribeAll}
        >
          {busy === '*' ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.allTxt}>
              Unsubscribe from all {leavable.length}
              {unreadOnly ? ' never opened' : ''}
            </Text>
          )}
        </Pressable>
      ) : null}
      {err ? <Text style={styles.err}>{err}</Text> : null}
      {lists === null ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 32 }} />
      ) : shown.length === 0 ? (
        <Text style={styles.empty}>
          {unreadOnly ? 'You open something from every list.' : 'No mailing lists in the last 90 days.'}
        </Text>
      ) : (
        <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
          data={shown}
          keyExtractor={(l) => l.senderEmail}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => {
            const said = outcome[item.senderEmail];
            return (
              <View style={styles.row}>
                <Text style={styles.from} numberOfLines={1}>
                  {item.senderName ?? item.senderEmail}
                </Text>
                {item.senderName ? (
                  <Text style={styles.address} numberOfLines={1}>
                    {item.senderEmail}
                  </Text>
                ) : null}
                <Text style={[styles.meta, item.opened === 0 && styles.metaWarn]}>
                  {item.messages} email{item.messages === 1 ? '' : 's'} ·{' '}
                  {item.opened === 0 ? 'none opened' : `${item.opened} opened`} · last{' '}
                  {new Date(item.lastReceivedAt).toLocaleDateString()}
                </Text>
                {item.requestedAt ? (
                  <Text style={styles.done}>
                    Asked to stop on {new Date(item.requestedAt).toLocaleDateString()}
                  </Text>
                ) : item.kind === null ? (
                  <Text style={styles.meta}>Chord can't unsubscribe from this one.</Text>
                ) : (
                  <Pressable
                    style={[styles.btn, busy !== null && styles.disabled]}
                    disabled={busy !== null}
                    onPress={() => void unsubscribe(item)}
                  >
                    {busy === item.senderEmail ? (
                      <ActivityIndicator color={colors.accent} />
                    ) : (
                      <Text style={styles.btnTxt}>
                        {item.kind === 'link' ? 'Unsubscribe (opens their page)' : 'Unsubscribe'}
                      </Text>
                    )}
                  </Pressable>
                )}
                {said ? <Text style={styles.said}>{said.message}</Text> : null}
                {said?.needsYou ? (
                  <Text style={styles.meta}>
                    Chord couldn't unsubscribe you from this one on its own: it needs a click on their side.
                  </Text>
                ) : null}
                {said?.needsYou && said.url ? (
                  <Pressable style={styles.btn} onPress={() => void openPage(said.url!)}>
                    <Text style={styles.btnTxt}>Open their page</Text>
                  </Pressable>
                ) : null}
                {item.autoTrash ? (
                  <View style={styles.trashRow}>
                    <Text style={styles.done}>New mail from this sender goes to Trash</Text>
                    <Pressable
                      disabled={busy !== null}
                      onPress={() => void setTrash(item, false)}
                      hitSlop={8}
                    >
                      <Text style={styles.link}>Stop</Text>
                    </Pressable>
                  </View>
                ) : said?.needsYou || item.requestedAt || item.kind === 'link' || item.kind === null ? (
                  <Pressable
                    style={[styles.btn, busy !== null && styles.disabled]}
                    disabled={busy !== null}
                    onPress={() => offerTrash(item)}
                  >
                    <Text style={styles.btnTxt}>Send future mail to Trash</Text>
                  </Pressable>
                ) : null}
              </View>
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
  note: { color: colors.muted, fontSize: 12, marginBottom: 10 },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipTxt: { color: colors.text, fontSize: 13 },
  chipTxtOn: { color: colors.onAccent, fontWeight: '600' },
  err: { color: colors.red, marginBottom: 8 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40 },
  row: { backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 10 },
  from: { color: colors.text, fontWeight: '600', fontSize: 15 },
  address: { color: colors.muted, fontSize: 12, marginTop: 1 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 4 },
  metaWarn: { color: colors.warn },
  done: { color: colors.green, fontSize: 13, marginTop: 8 },
  said: { color: colors.text, fontSize: 13, marginTop: 6 },
  btn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 8,
  },
  btnTxt: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  trashRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  link: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  allBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  allTxt: { color: colors.onAccent, fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.4 },
}));
