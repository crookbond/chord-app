/**
 * People - manual UI for ADR 0016 family graph.
 *
 * List of people the user has saved + their important dates. Add a
 * person via the inline form; tap a person to open a panel with
 * "add date" + per-row delete.
 *
 * The bot tools `add_person` / `add_important_date` populate the same
 * tables - both surfaces stay in sync via re-fetch on focus.
 */
import { useCallback, useEffect, useState } from 'react';
import { Stack, router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { KeyboardScrollView } from '@/keyboard';
import { type BusyKeys, useBusyKeys } from '@/busy-keys';
import type { ImportantDateKind, PendingPersonSuggestion, PersonWithDates } from '@chord/kernel';

import {
  addImportantDate,
  confirmProposal,
  createPerson,
  deleteImportantDate,
  deletePerson,
  listGroups,
  listPeople,
  listPeoplePending,
  readSavedCopy,
  rejectProposal,
  sharePersonToGroup,
} from '@/api';
import { useScreenRefresh } from '@/refresh';
import { colors, themed } from '@/theme';
import { DateField } from '@/date-field';
import { confirmDestructive } from '@/confirm';

const KINDS: Array<{ key: ImportantDateKind; label: string; emoji: string }> = [
  { key: 'birthday', label: 'Birthday', emoji: '🎂' },
  { key: 'anniversary', label: 'Anniversary', emoji: '💍' },
  { key: 'death', label: 'Remembrance', emoji: '🕯' },
  { key: 'other', label: 'Other', emoji: '★' },
];

export default function PeopleScreen() {
  const [people, setPeople] = useState<PersonWithDates[] | null>(null);
  const [pending, setPending] = useState<PendingPersonSuggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const busy = useBusyKeys();
  const { start: startBusy, end: endBusy } = busy;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sharedGroups, setSharedGroups] = useState<Array<{ id: string; name: string }>>([]);

  const [newName, setNewName] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // The first paint comes from this phone's saved copy, not a spinner; the
  // server's answer below replaces it (a saved copy never replaces an answer).
  useEffect(() => {
    void readSavedCopy<PersonWithDates[]>('people').then((saved) => {
      if (saved) setPeople((prev) => prev ?? saved);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [ppl, pend, groups] = await Promise.all([
        listPeople(),
        listPeoplePending().catch(() => [] as PendingPersonSuggestion[]),
        listGroups().catch(() => []),
      ]);
      setPeople(ppl);
      setPending(pend);
      setSharedGroups(
        groups.filter((g) => g.kind === 'group').map((g) => ({ id: g.id, name: g.name })),
      );
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // ADR 0078 - ✓/✕ on a staged person/birthday proposal from chat or email.
  const decidePending = useCallback(
    async (proposalId: string, accept: boolean) => {
      startBusy(`pending:${proposalId}`);
      try {
        if (accept) await confirmProposal(proposalId);
        else await rejectProposal(proposalId);
        await refresh();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        endBusy(`pending:${proposalId}`);
      }
    },
    [refresh, startBusy, endBusy],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const { refreshControl } = useScreenRefresh(refresh);

  const addPerson = useCallback(async () => {
    if (!newName.trim()) return;
    startBusy('add-person');
    try {
      await createPerson({ displayName: newName.trim(), notes: newNotes.trim() || undefined });
      setNewName('');
      setNewNotes('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      endBusy('add-person');
    }
  }, [newName, newNotes, refresh, startBusy, endBusy]);

  const removePerson = useCallback(
    async (id: string) => {
      const proceed = async () => {
        startBusy(`del-person:${id}`);
        try {
          await deletePerson(id);
          if (expanded === id) setExpanded(null);
          await refresh();
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          endBusy(`del-person:${id}`);
        }
      };
      confirmDestructive(
        'Delete person?',
        'This also removes their important dates.',
        () => void proceed(),
      );
    },
    [expanded, refresh],
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'People',
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace('/settings');
              }}
              hitSlop={8}
              style={styles.headerBack}
            >
              <Text style={styles.headerBackTxt}>‹ Settings</Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardScrollView
        style={styles.root}
        contentContainerStyle={styles.scrollContent}
        refreshControl={refreshControl}
      >
        <Text style={styles.intro}>
          People you want Chord to remember. Birthdays and anniversaries here power the
          Calendar&rsquo;s Important Days filter and the morning briefing.
        </Text>

        {/* ADR 0078 - staged person/birthday suggestions from chat + email. */}
        {pending.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.label}>Waiting on your OK</Text>
            {pending.map((s) => (
              <View key={s.proposalId} style={styles.pendingRow}>
                {/* Text opens the source email so the fact can be checked
                    before accepting. */}
                <Pressable
                  style={{ flex: 1, minWidth: 0 }}
                  disabled={!s.sourceHref}
                  onPress={() => s.sourceHref && router.push(s.sourceHref as never)}
                >
                  <Text
                    style={[styles.pendingTitle, s.sourceHref && styles.pendingTitleLink]}
                    numberOfLines={1}
                  >
                    {s.kind === 'person' ? '👤' : '🎂'} {s.title}
                  </Text>
                  {s.detail && (
                    <Text style={styles.muted} numberOfLines={1}>
                      {s.detail}
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  style={[styles.pendingBtn, busy.has(`pending:${s.proposalId}`) && styles.btnDisabled]}
                  disabled={busy.has(`pending:${s.proposalId}`)}
                  onPress={() => void decidePending(s.proposalId, true)}
                >
                  <Text style={styles.pendingBtnTxt}>
                    {busy.has(`pending:${s.proposalId}`) ? '…' : 'Add'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.pendingDismiss, busy.has(`pending:${s.proposalId}`) && styles.btnDisabled]}
                  disabled={busy.has(`pending:${s.proposalId}`)}
                  onPress={() => void decidePending(s.proposalId, false)}
                >
                  <Text style={styles.pendingDismissTxt}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.label}>Add person</Text>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Display name (e.g. Alice)"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <TextInput
            value={newNotes}
            onChangeText={setNewNotes}
            placeholder="Notes (optional) - wife, dad, neighbor"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <Pressable
            style={[
              styles.btn,
              (!newName.trim() || busy.has('add-person')) && styles.btnDisabled,
            ]}
            disabled={!newName.trim() || busy.has('add-person')}
            onPress={() => void addPerson()}
          >
            {busy.has('add-person') ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={styles.btnTxt}>Save</Text>
            )}
          </Pressable>
        </View>

        {err && <Text style={styles.err}>{err}</Text>}

        {people === null ? (
          <View style={styles.center}><ActivityIndicator /></View>
        ) : people.length === 0 ? (
          <Text style={styles.empty}>
            No people yet. Add one above, or tell Chord: &ldquo;@Chord remember Alice&rsquo;s birthday is May 8&rdquo;.
          </Text>
        ) : (
          people.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              expanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              onDelete={() => void removePerson(p.id)}
              onChange={refresh}
              busy={busy}
              setErr={setErr}
              sharedGroups={sharedGroups}
            />
          ))
        )}
      </KeyboardScrollView>
    </View>
  );
}

function PersonRow({
  person,
  expanded,
  onToggle,
  onDelete,
  onChange,
  busy,
  setErr,
  sharedGroups,
}: {
  person: PersonWithDates;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onChange: () => Promise<void>;
  busy: BusyKeys;
  setErr: (e: string | null) => void;
  sharedGroups: Array<{ id: string; name: string }>;
}) {
  const [kind, setKind] = useState<ImportantDateKind>('birthday');
  const [date, setDate] = useState('');
  const [recurs, setRecurs] = useState(true);

  const addDate = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setErr('Date must be YYYY-MM-DD (use 0000- when year is unknown).');
      return;
    }
    const key = `add-date:${person.id}`;
    busy.start(key);
    try {
      await addImportantDate(person.id, { kind, date, recurs });
      setDate('');
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      busy.end(key);
    }
  }, [date, kind, recurs, person.id, onChange, busy, setErr]);

  const removeDate = useCallback(
    async (dateId: string) => {
      busy.start(`del-date:${dateId}`);
      try {
        await deleteImportantDate(dateId);
        await onChange();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        busy.end(`del-date:${dateId}`);
      }
    },
    [onChange, busy, setErr],
  );

  return (
    <View style={styles.personCard}>
      <Pressable onPress={onToggle} style={styles.personHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.personName}>{person.displayName}</Text>
          {person.notes && <Text style={styles.muted}>{person.notes}</Text>}
          {person.email ? <Text style={styles.muted}>✉ {person.email}</Text> : null}
          {person.phone ? <Text style={styles.muted}>☎ {person.phone}</Text> : null}
          <Text style={styles.muted}>
            {person.importantDates.length === 0
              ? 'No dates yet'
              : person.importantDates
                  .map((d) => `${KINDS.find((k) => k.key === d.kind)?.emoji ?? '★'} ${d.date}`)
                  .join('  ·  ')}
          </Text>
          {/* ADR 0078 - confirmed facts Chord has learned about this person. */}
          {(person.facts ?? []).length > 0 && (
            <View style={styles.factWrap}>
              {(person.facts ?? []).map((f, i) => (
                <Text key={`${f.key}:${i}`} style={styles.factChip} numberOfLines={1}>
                  {f.key.replace(/_/g, ' ')}: {f.value}
                </Text>
              ))}
            </View>
          )}
        </View>
        <Text style={styles.chev}>{expanded ? '⌃' : '⌄'}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.expand}>
          {person.importantDates.map((d) => (
            <View key={d.id} style={styles.dateRow}>
              <Text style={styles.dateRowTxt}>
                {KINDS.find((k) => k.key === d.kind)?.emoji} {d.kind} · {d.date}
                {d.recurs ? '  (recurs)' : ''}
              </Text>
              <Pressable
                onPress={() => void removeDate(d.id)}
                disabled={busy.has(`del-date:${d.id}`)}
                hitSlop={8}
              >
                <Text style={styles.dateRowDel}>Remove</Text>
              </Pressable>
            </View>
          ))}

          <View style={styles.addDateBlock}>
            <Text style={styles.label}>Add a date</Text>
            <View style={styles.kindRow}>
              {KINDS.map((k) => {
                const active = kind === k.key;
                return (
                  <Pressable
                    key={k.key}
                    onPress={() => setKind(k.key)}
                    style={[styles.kindChip, active && styles.kindChipActive]}
                  >
                    <Text style={[styles.kindChipTxt, active && styles.kindChipTxtActive]}>
                      {k.emoji} {k.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <DateField
              value={date}
              onChange={setDate}
              placeholder="YYYY-MM-DD (e.g. 0000-05-08 or 1985-05-08)"
              allowUnknownYear
              inputStyle={styles.input}
            />
            <Pressable
              onPress={() => setRecurs(!recurs)}
              style={[styles.recursToggle, recurs && styles.recursToggleActive]}
            >
              <Text style={[styles.recursTxt, recurs && styles.recursTxtActive]}>
                {recurs ? '✓ Recurs annually' : 'One-time'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.btn, busy.has(`add-date:${person.id}`) && styles.btnDisabled]}
              disabled={busy.has(`add-date:${person.id}`)}
              onPress={() => void addDate()}
            >
              {busy.has(`add-date:${person.id}`) ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnTxt}>Save date</Text>
              )}
            </Pressable>
          </View>

          {sharedGroups.length > 0 && (
            <View style={styles.shareBlock}>
              <Text style={styles.label}>Share with a family group</Text>
              <Text style={styles.muted}>
                Adds {person.displayName} to that group&rsquo;s roster and copies their dates,
                notes and email. Your private entry stays as it is.
              </Text>
              <View style={styles.shareRow}>
                {sharedGroups.map((g) => (
                  <Pressable
                    key={g.id}
                    disabled={busy.has(`share:${person.id}:${g.id}`)}
                    onPress={() =>
                      confirmDestructive(
                        `Share ${person.displayName} with "${g.name}"?`,
                        'Everyone in that group will see this person on the family profile.',
                        () => {
                          void (async () => {
                            busy.start(`share:${person.id}:${g.id}`);
                            try {
                              await sharePersonToGroup(g.id, person.id);
                            } catch (e) {
                              setErr((e as Error).message);
                            } finally {
                              busy.end(`share:${person.id}:${g.id}`);
                            }
                          })();
                        },
                        { confirmLabel: 'Share' },
                      )
                    }
                  >
                    <Text style={styles.shareChip}>
                      {busy.has(`share:${person.id}:${g.id}`) ? '…' : `→ ${g.name}`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          <Pressable onPress={onDelete} style={styles.deletePerson}>
            <Text style={styles.deletePersonTxt}>Delete person</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24 },
  headerBack: { paddingHorizontal: 8, paddingVertical: 4 },
  headerBackTxt: { color: colors.accent, fontSize: 16 },
  intro: { color: colors.muted, fontSize: 13, marginBottom: 12, lineHeight: 18 },
  err: { color: colors.red, fontSize: 13, marginBottom: 8 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 24, paddingHorizontal: 12, lineHeight: 18 },

  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
    gap: 8,
  },
  label: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  muted: { color: colors.muted, fontSize: 12, marginTop: 2 },

  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  btn: {
    backgroundColor: colors.accent,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.4 },
  btnTxt: { color: colors.onAccent, fontWeight: '600' },

  personCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  personHeader: {
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  personName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  chev: { color: colors.muted, fontSize: 18 },

  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8 },
  pendingTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  pendingTitleLink: { textDecorationLine: 'underline', textDecorationColor: colors.border },
  pendingBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  pendingBtnTxt: { color: colors.onAccent, fontSize: 12, fontWeight: '700' },
  pendingDismiss: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingDismissTxt: { color: colors.muted, fontSize: 12, fontWeight: '700' },

  factWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  factChip: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: colors.accentLight,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
    maxWidth: 260,
  },

  expand: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 10,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 10,
  },
  dateRowTxt: { flex: 1, color: colors.text, fontSize: 13 },
  dateRowDel: { color: colors.red, fontSize: 12, fontWeight: '600' },

  addDateBlock: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 12,
    gap: 8,
    marginTop: 6,
  },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kindChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  kindChipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  kindChipTxt: { fontSize: 11, color: colors.muted, fontWeight: '600' },
  kindChipTxtActive: { color: colors.accent },

  recursToggle: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  recursToggleActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  recursTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  recursTxtActive: { color: colors.accent },

  shareBlock: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  shareRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  shareChip: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },

  deletePerson: {
    paddingVertical: 10,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 6,
  },
  deletePersonTxt: { color: colors.red, fontWeight: '600', fontSize: 13 },
}));
