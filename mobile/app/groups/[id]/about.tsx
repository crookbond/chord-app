/**
 * "About this family" — the per-group family-profile surface (design doc
 * family-profile-design.md, Phase 1 increment 3).
 *
 * Roster of personas (account members + managed non-users), each expanding to
 * their facts grouped by category; a household section; and a pending strip
 * for facts / people Chord has proposed. Reads GET /groups/:id/profile.
 */
import { useCallback, useMemo, useState } from 'react';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { KeyboardScrollView } from '@/keyboard';
import { backHomeHeaderLeft } from '@/back-home';
import {
  FACT_CATEGORIES,
  HOUSEHOLD_ROLES,
  type FactCategory,
  type FamilyProfile,
  type HouseholdRole,
  type Memory,
  type PendingFact,
  type PersonaWithFacts,
} from '@chord/kernel';

import {
  confirmMemory,
  confirmProposal,
  createFact,
  createGroupPersona,
  deleteFact,
  deletePersona,
  getGroupProfile,
  rejectMemory,
  rejectProposal,
  updateFact,
  updatePersona,
} from '@/api';
import { colors, themed } from '@/theme';
import { DateField } from '@/date-field';
import { confirmDestructive } from '@/confirm';

const CATEGORY_LABEL: Record<FactCategory, string> = {
  health: 'Health',
  school: 'School',
  contact: 'Contact',
  sizes: 'Sizes',
  prefs: 'Preferences',
  logistics: 'Logistics',
  dates: 'Dates',
  note: 'Notes',
};

function ageFromBirthdate(bd: string | null): number | null {
  if (!bd || !/^\d{4}-\d{2}-\d{2}$/.test(bd) || bd.startsWith('0000')) return null;
  const b = new Date(bd + 'T00:00:00');
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** Group a persona/household fact list by category, in FACT_CATEGORIES order. */
function byCategory(facts: Memory[]): Array<{ category: FactCategory; facts: Memory[] }> {
  const out: Array<{ category: FactCategory; facts: Memory[] }> = [];
  for (const c of FACT_CATEGORIES) {
    const f = facts.filter((x) => (x.category ?? 'note') === c);
    if (f.length) out.push({ category: c, facts: f });
  }
  return out;
}

export default function AboutFamilyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = String(id);
  const [profile, setProfile] = useState<FamilyProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfile(await getGroupProfile(groupId));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const resolvePending = useCallback(
    async (p: PendingFact, accept: boolean) => {
      setBusy(`pending:${p.id}`);
      try {
        if (p.kind === 'fact') {
          if (accept) await confirmMemory(p.id);
          else await rejectMemory(p.id);
        } else {
          if (accept) await confirmProposal(p.id);
          else await rejectProposal(p.id);
        }
        await refresh();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<HouseholdRole>('child');
  const [newBirthdate, setNewBirthdate] = useState('');

  const addPersona = useCallback(async () => {
    if (!newName.trim()) return;
    if (newBirthdate && !/^\d{4}-\d{2}-\d{2}$/.test(newBirthdate)) {
      setErr('Birthday must be YYYY-MM-DD.');
      return;
    }
    setBusy('add-persona');
    try {
      await createGroupPersona(groupId, {
        name: newName.trim(),
        householdRole: newRole,
        ...(newBirthdate ? { birthdate: newBirthdate } : {}),
      });
      setNewName('');
      setNewBirthdate('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [newName, newRole, newBirthdate, groupId, refresh]);

  const household = profile?.household ?? [];

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{ title: 'About this family', headerLeft: backHomeHeaderLeft('Chat', `/groups/${id}`) }}
      />
      <KeyboardScrollView style={styles.root} contentContainerStyle={styles.content}>
        {err && <Text style={styles.err}>{err}</Text>}
        {profile === null ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : (
          <>
            {profile.pending.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.label}>Chord learned this — confirm?</Text>
                {profile.pending.map((p) => (
                  <View key={p.id} style={styles.pendingRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.pendingTitle} numberOfLines={2}>
                        {p.title}
                      </Text>
                      {p.detail ? (
                        <Text style={styles.muted} numberOfLines={2}>
                          {p.detail}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      style={[styles.miniBtn, busy !== null && styles.btnDisabled]}
                      disabled={busy !== null}
                      onPress={() => void resolvePending(p, true)}
                    >
                      <Text style={styles.miniBtnTxt}>✓</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.miniBtnGhost, busy !== null && styles.btnDisabled]}
                      disabled={busy !== null}
                      onPress={() => void resolvePending(p, false)}
                    >
                      <Text style={styles.miniBtnGhostTxt}>✕</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.sectionTitle}>Members</Text>
            {profile.personas.map((p) => (
              <PersonaCard
                key={p.id}
                persona={p}
                groupId={groupId}
                expanded={expanded === p.id}
                onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
                onChange={refresh}
                busy={busy}
                setBusy={setBusy}
                setErr={setErr}
              />
            ))}

            <View style={styles.card}>
              <Text style={styles.label}>Add a family member</Text>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="Name"
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              <View style={styles.chipRow}>
                {HOUSEHOLD_ROLES.map((r) => (
                  <Pressable key={r} onPress={() => setNewRole(r)}>
                    <Text style={[styles.chip, newRole === r && styles.chipOn]}>{r}</Text>
                  </Pressable>
                ))}
              </View>
              <DateField
                value={newBirthdate}
                onChange={setNewBirthdate}
                placeholder="Birthday YYYY-MM-DD (optional)"
                style={{ marginBottom: 8 }}
                inputStyle={[styles.input, { marginBottom: 0 }]}
              />
              <Pressable
                style={[styles.btn, (!newName.trim() || busy !== null) && styles.btnDisabled]}
                disabled={!newName.trim() || busy !== null}
                onPress={() => void addPersona()}
              >
                <Text style={styles.btnTxt}>{busy === 'add-persona' ? '…' : 'Add member'}</Text>
              </Pressable>
            </View>

            <Text style={styles.sectionTitle}>Household</Text>
            <FactBlock
              facts={household}
              groupId={groupId}
              subject={{ subjectType: 'household' }}
              onChange={refresh}
              busy={busy}
              setBusy={setBusy}
              setErr={setErr}
              emptyHint="Home address, wifi, the car, emergency contacts, the pediatrician…"
            />
          </>
        )}
      </KeyboardScrollView>
    </View>
  );
}

function PersonaCard({
  persona,
  groupId,
  expanded,
  onToggle,
  onChange,
  busy,
  setBusy,
  setErr,
}: {
  persona: PersonaWithFacts;
  groupId: string;
  expanded: boolean;
  onToggle: () => void;
  onChange: () => Promise<void>;
  busy: string | null;
  setBusy: (k: string | null) => void;
  setErr: (e: string | null) => void;
}) {
  const age = ageFromBirthdate(persona.birthdate);
  const subject = persona.memberUserId
    ? ({ subjectType: 'user', subjectId: persona.memberUserId } as const)
    : ({ subjectType: 'persona', subjectId: persona.id } as const);

  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState(persona.name);
  const [eRole, setERole] = useState<HouseholdRole>(persona.householdRole);
  const [eBd, setEBd] = useState(persona.birthdate ?? '');

  const savePersona = useCallback(async () => {
    if (!eName.trim()) return;
    setBusy(`edit-persona:${persona.id}`);
    try {
      await updatePersona(persona.id, {
        name: eName.trim(),
        householdRole: eRole,
        birthdate: eBd.trim() ? eBd.trim() : null,
      });
      setEditing(false);
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [persona.id, eName, eRole, eBd, onChange, setBusy, setErr]);

  const removePersona = useCallback(() => {
    confirmDestructive(
      'Remove family member?',
      `${persona.name} will no longer appear on this family's roster.`,
      () => {
        void (async () => {
          setBusy(`del-persona:${persona.id}`);
          try {
            await deletePersona(persona.id);
            await onChange();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(null);
          }
        })();
      },
      { confirmLabel: 'Remove' },
    );
  }, [persona.id, persona.name, onChange, setBusy, setErr]);

  return (
    <View style={styles.card}>
      <Pressable onPress={onToggle} style={styles.personaHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarTxt}>{initials(persona.name)}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.personaName}>{persona.name}</Text>
          <Text style={styles.muted}>
            {persona.householdRole}
            {age !== null ? ` · ${age}` : ''}
            {persona.isManaged && persona.managedBy ? ' · managed' : ''}
          </Text>
        </View>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.personaBody}>
          {persona.isManaged && editing && (
            <View style={styles.factEdit}>
              <TextInput
                value={eName}
                onChangeText={setEName}
                placeholder="Name"
                placeholderTextColor={colors.muted}
                style={[styles.input, styles.inputSm]}
              />
              <View style={styles.chipRow}>
                {HOUSEHOLD_ROLES.map((r) => (
                  <Pressable key={r} onPress={() => setERole(r)}>
                    <Text style={[styles.chip, eRole === r && styles.chipOn]}>{r}</Text>
                  </Pressable>
                ))}
              </View>
              <DateField
                value={eBd}
                onChange={setEBd}
                placeholder="Birthday YYYY-MM-DD (optional)"
                style={styles.inputSm}
                inputStyle={[styles.input, { marginBottom: 0 }]}
              />
              <View style={styles.editBtnRow}>
                <Pressable
                  style={[styles.btnSm, (!eName.trim() || busy !== null) && styles.btnDisabled]}
                  disabled={!eName.trim() || busy !== null}
                  onPress={() => void savePersona()}
                >
                  <Text style={styles.btnTxt}>
                    {busy === `edit-persona:${persona.id}` ? '…' : 'Save'}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.linkBtn}
                  disabled={busy !== null}
                  onPress={() => {
                    setEName(persona.name);
                    setERole(persona.householdRole);
                    setEBd(persona.birthdate ?? '');
                    setEditing(false);
                  }}
                >
                  <Text style={styles.linkBtnTxt}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
          <FactBlock
            facts={persona.facts}
            groupId={groupId}
            subject={subject}
            onChange={onChange}
            busy={busy}
            setBusy={setBusy}
            setErr={setErr}
            emptyHint={`Nothing recorded about ${persona.name} yet.`}
          />
          {persona.isManaged && (
            <View style={styles.editBtnRow}>
              {!editing && (
                <Pressable
                  style={[styles.linkBtn, busy !== null && styles.btnDisabled]}
                  disabled={busy !== null}
                  onPress={() => setEditing(true)}
                >
                  <Text style={styles.linkBtnMuted}>Edit details</Text>
                </Pressable>
              )}
              <Pressable
                style={[styles.linkBtn, busy !== null && styles.btnDisabled]}
                disabled={busy !== null}
                onPress={removePersona}
              >
                <Text style={styles.linkBtnTxt}>Remove {persona.name}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function FactBlock({
  facts,
  groupId,
  subject,
  onChange,
  busy,
  setBusy,
  setErr,
  emptyHint,
}: {
  facts: Memory[];
  groupId: string;
  subject: { subjectType: 'user' | 'persona' | 'household'; subjectId?: string };
  onChange: () => Promise<void>;
  busy: string | null;
  setBusy: (k: string | null) => void;
  setErr: (e: string | null) => void;
  emptyHint: string;
}) {
  const groups = useMemo(() => byCategory(facts), [facts]);
  const [fkey, setFkey] = useState('');
  const [fval, setFval] = useState('');
  const [fcat, setFcat] = useState<FactCategory>('note');
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [editCat, setEditCat] = useState<FactCategory>('note');

  const add = useCallback(async () => {
    if (!fkey.trim() || !fval.trim()) return;
    setBusy('add-fact');
    try {
      await createFact(groupId, {
        subjectType: subject.subjectType,
        ...(subject.subjectId ? { subjectId: subject.subjectId } : {}),
        key: fkey.trim(),
        value: fval.trim(),
        category: fcat,
      });
      setFkey('');
      setFval('');
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [fkey, fval, fcat, groupId, subject, onChange, setBusy, setErr]);

  const removeFact = useCallback(
    async (fid: string) => {
      setBusy(`del-fact:${fid}`);
      try {
        await deleteFact(fid);
        await onChange();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [onChange, setBusy, setErr],
  );

  const startEdit = useCallback((f: Memory) => {
    setEditId(f.id);
    setEditVal(f.value);
    setEditCat((f.category as FactCategory | null) ?? 'note');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editId || !editVal.trim()) return;
    setBusy(`edit-fact:${editId}`);
    try {
      await updateFact(editId, { value: editVal.trim(), category: editCat });
      setEditId(null);
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [editId, editVal, editCat, onChange, setBusy, setErr]);

  return (
    <View>
      {groups.length === 0 ? (
        <Text style={styles.muted}>{emptyHint}</Text>
      ) : (
        groups.map((g) => (
          <View key={g.category} style={styles.factGroup}>
            <Text style={styles.factCat}>{CATEGORY_LABEL[g.category]}</Text>
            {g.facts.map((f) =>
              editId === f.id ? (
                <View key={f.id} style={styles.factEdit}>
                  <Text style={styles.factKey}>{f.key}</Text>
                  <TextInput
                    value={editVal}
                    onChangeText={setEditVal}
                    placeholder="Value"
                    placeholderTextColor={colors.muted}
                    style={[styles.input, styles.inputSm]}
                  />
                  <View style={styles.chipRow}>
                    {FACT_CATEGORIES.map((c) => (
                      <Pressable key={c} onPress={() => setEditCat(c)}>
                        <Text style={[styles.chip, editCat === c && styles.chipOn]}>
                          {CATEGORY_LABEL[c]}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.editBtnRow}>
                    <Pressable
                      style={[
                        styles.btnSm,
                        (!editVal.trim() || busy !== null) && styles.btnDisabled,
                      ]}
                      disabled={!editVal.trim() || busy !== null}
                      onPress={() => void saveEdit()}
                    >
                      <Text style={styles.btnTxt}>
                        {busy === `edit-fact:${f.id}` ? '…' : 'Save'}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.linkBtn}
                      disabled={busy !== null}
                      onPress={() => setEditId(null)}
                    >
                      <Text style={styles.linkBtnTxt}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View key={f.id} style={styles.factRow}>
                  <Pressable
                    style={{ flex: 1 }}
                    disabled={busy !== null}
                    onPress={() => startEdit(f)}
                  >
                    <Text style={styles.factText}>
                      <Text style={styles.factKey}>{f.key}: </Text>
                      {f.value}
                    </Text>
                  </Pressable>
                  <Pressable
                    hitSlop={8}
                    disabled={busy !== null}
                    onPress={() => void removeFact(f.id)}
                  >
                    <Text style={styles.factDel}>✕</Text>
                  </Pressable>
                </View>
              ),
            )}
          </View>
        ))
      )}

      <View style={styles.factForm}>
        <TextInput
          value={fkey}
          onChangeText={setFkey}
          placeholder="Label (allergy, shoe size, …)"
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.inputSm]}
        />
        <TextInput
          value={fval}
          onChangeText={setFval}
          placeholder="Value"
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.inputSm]}
        />
        <View style={styles.chipRow}>
          {FACT_CATEGORIES.map((c) => (
            <Pressable key={c} onPress={() => setFcat(c)}>
              <Text style={[styles.chip, fcat === c && styles.chipOn]}>{CATEGORY_LABEL[c]}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          style={[styles.btnSm, (!fkey.trim() || !fval.trim() || busy !== null) && styles.btnDisabled]}
          disabled={!fkey.trim() || !fval.trim() || busy !== null}
          onPress={() => void add()}
        >
          <Text style={styles.btnTxt}>{busy === 'add-fact' ? '…' : 'Add fact'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1 },
  content: { padding: 14, paddingBottom: 48 },
  center: { paddingVertical: 40, alignItems: 'center' },
  err: { color: colors.red, marginBottom: 10 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.muted, marginTop: 14, marginBottom: 6 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 10,
  },
  label: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 8 },
  muted: { fontSize: 12, color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.text,
    marginBottom: 8,
    backgroundColor: colors.bg,
  },
  inputSm: { marginBottom: 6 },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  btnSm: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 8, alignItems: 'center', marginTop: 4 },
  btnTxt: { color: colors.onAccent, fontWeight: '700', fontSize: 13 },
  btnDisabled: { opacity: 0.4 },
  linkBtn: { paddingVertical: 8, marginTop: 4 },
  linkBtnTxt: { color: colors.red, fontSize: 12, fontWeight: '600' },
  linkBtnMuted: { color: colors.accent, fontSize: 12, fontWeight: '600' },

  personaHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  personaName: { fontSize: 15, fontWeight: '600', color: colors.text },
  personaBody: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  chevron: { color: colors.muted, fontSize: 14 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { fontSize: 12, fontWeight: '700', color: colors.text },

  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  pendingTitle: { fontSize: 13, color: colors.text },
  miniBtn: {
    minWidth: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniBtnTxt: { color: colors.onAccent, fontWeight: '700' },
  miniBtnGhost: {
    minWidth: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniBtnGhostTxt: { color: colors.muted, fontWeight: '700' },

  factGroup: { marginBottom: 8 },
  factCat: { fontSize: 11, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: 3 },
  factRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 2 },
  factText: { flex: 1, fontSize: 13, color: colors.text },
  factKey: { fontWeight: '600' },
  factDel: { color: colors.muted, fontSize: 13 },
  factEdit: {
    paddingVertical: 6,
    paddingLeft: 6,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    marginBottom: 4,
  },
  editBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  factForm: { marginTop: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 8 },
  chip: {
    fontSize: 11,
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    textTransform: 'capitalize',
  },
  chipOn: { color: colors.onAccent, backgroundColor: colors.accent, borderColor: colors.accent },
}));
