/**
 * Filters (ADR 0309): mail from a sender or a domain goes into a folder on the
 * user's own mailbox, made there if it does not exist. The rule lives in
 * Chord and runs after each sync; the same rules can be made in chat ("send
 * emails from school.org to School").
 */
import { useCallback, useEffect, useState } from 'react';
import { Stack, router } from 'expo-router';
import { ActivityIndicator, Pressable, Switch, Text, View } from 'react-native';
import type { EmailFilingRule } from '@chord/kernel';

import { addMailFilter, listMailFilters, removeMailFilter } from '@/api';
import { confirmDestructive } from '@/confirm';
import { KeyboardScrollView } from '@/keyboard';
import { TextInput } from '@/text-input';
import { colors, themed } from '@/theme';
import { backHomeHeaderLeft } from '@/back-home';

export default function FiltersScreen() {
  const [rules, setRules] = useState<EmailFilingRule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [folder, setFolder] = useState('');
  const [alsoExisting, setAlsoExisting] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      setRules(await listMailFilters());
    } catch (e) {
      setErr((e as Error).message);
      setRules([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(async () => {
    if (!from.trim() || !folder.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setRules(await addMailFilter({ from: from.trim(), folder: folder.trim(), alsoExisting }));
      setFrom('');
      setFolder('');
      setAlsoExisting(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [from, folder, alsoExisting]);

  const remove = useCallback((rule: EmailFilingRule) => {
    confirmDestructive(
      'Remove this filter?',
      `Mail from ${who(rule)} will stay in the inbox again. Mail already filed stays in "${rule.folder}".`,
      () => {
        void removeMailFilter(rule.id)
          .then(setRules)
          .catch((e: Error) => setErr(e.message));
      },
      { confirmLabel: 'Remove' },
    );
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Filters', headerLeft: backHomeHeaderLeft('Email', '/email') }} />
      <KeyboardScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.note}>
          Mail from a sender or a domain goes into a folder on your mailbox (a label in Gmail). Chord makes the
          folder if it isn't there and files new mail after each sync. Nothing is deleted.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>From (email address or domain)</Text>
          <TextInput
            style={styles.input}
            value={from}
            onChangeText={setFrom}
            placeholder="bill@example.com or school.org"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <Text style={styles.label}>Folder</Text>
          <TextInput
            style={styles.input}
            value={folder}
            onChangeText={setFolder}
            placeholder="School"
            placeholderTextColor={colors.muted}
          />
          <View style={styles.switchRow}>
            <Text style={styles.switchTxt}>Also move matching mail already in the inbox</Text>
            <Switch value={alsoExisting} onValueChange={setAlsoExisting} />
          </View>
          <Pressable
            style={[styles.addBtn, (busy || !from.trim() || !folder.trim()) && styles.disabled]}
            disabled={busy || !from.trim() || !folder.trim()}
            onPress={() => void add()}
          >
            {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.addTxt}>Add filter</Text>}
          </Pressable>
        </View>

        {err ? <Text style={styles.err}>{err}</Text> : null}
        {rules === null ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} />
        ) : rules.length === 0 ? (
          <Text style={styles.empty}>No filters yet.</Text>
        ) : (
          rules.map((r) => (
            <View key={r.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.from} numberOfLines={1}>
                  {who(r)}
                </Text>
                <Text style={styles.meta}>
                  → {r.folder} · {Date.parse(r.since) === 0 ? 'all mail' : `since ${new Date(r.since).toLocaleDateString()}`}
                </Text>
              </View>
              <Pressable onPress={() => remove(r)} hitSlop={8}>
                <Text style={styles.removeTxt}>Remove</Text>
              </Pressable>
            </View>
          ))
        )}
      </KeyboardScrollView>
    </View>
  );
}

function who(rule: EmailFilingRule): string {
  return rule.kind === 'domain' ? `anyone at ${rule.value}` : rule.value;
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
  card: { backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 16 },
  label: { color: colors.muted, fontSize: 12, marginTop: 6, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 15,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 12 },
  switchTxt: { color: colors.text, fontSize: 13, flex: 1 },
  addBtn: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 12 },
  addTxt: { color: colors.onAccent, fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.4 },
  err: { color: colors.red, marginBottom: 8 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    gap: 12,
  },
  from: { color: colors.text, fontWeight: '600', fontSize: 14 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  removeTxt: { color: colors.red, fontWeight: '600', fontSize: 13 },
}));
