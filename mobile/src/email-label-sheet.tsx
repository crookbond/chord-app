/**
 * The label box the reader's Label button opens (ADR 0141 labels).
 *
 * It was a card that sat open above every email. Labelling is occasional, so
 * it is a box you ask for instead, and the email gets the room.
 */
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';

import { listEmailLabels } from '@/api';
import { colors, themed } from '@/theme';

export function EmailLabelSheet({
  open,
  onClose,
  labels,
  busy,
  onAdd,
  onRemove,
  onApplyCategory,
}: {
  open: boolean;
  onClose: () => void;
  /** Chord labels already on this thread. */
  labels: string[];
  busy: boolean;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  /** Present only when the thread has a category to push to the mail app. */
  onApplyCategory?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [known, setKnown] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setDraft('');
    void listEmailLabels()
      .then((all) => setKnown(all.filter((l) => l.scope === 'chord').map((l) => l.name)))
      .catch(() => setKnown([]));
  }, [open]);

  const add = (name: string) => {
    const n = name.trim();
    if (!n) return;
    setDraft('');
    onAdd(n);
  };

  const applied = new Set(labels.map((l) => l.toLowerCase()));
  const offered = known.filter((n) => !applied.has(n.toLowerCase())).slice(0, 8);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
      >
        <Pressable style={styles.scrim} onPress={onClose}>
          <Pressable style={styles.box} onPress={(e) => e.stopPropagation()}>
            <View style={styles.head}>
              <Text style={styles.title}>Labels</Text>
              <Pressable onPress={onClose} hitSlop={8}>
                <Text style={styles.done}>Done</Text>
              </Pressable>
            </View>

            {labels.length > 0 ? (
              <View style={styles.chips}>
                {labels.map((name) => (
                  <Pressable
                    key={name}
                    style={styles.chipOn}
                    disabled={busy}
                    onPress={() => onRemove(name)}
                    accessibilityLabel={`Remove label ${name}`}
                  >
                    <Text style={styles.chipOnTxt}>{name} ×</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={styles.addRow}>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="New label"
                placeholderTextColor={colors.muted}
                editable={!busy}
                autoFocus
                onSubmitEditing={() => add(draft)}
                returnKeyType="done"
              />
              <Pressable
                style={[styles.addBtn, (busy || !draft.trim()) && styles.dim]}
                disabled={busy || !draft.trim()}
                onPress={() => add(draft)}
              >
                <Text style={styles.addBtnTxt}>{busy ? '…' : 'Add'}</Text>
              </Pressable>
            </View>

            {offered.length > 0 ? (
              <>
                <Text style={styles.section}>Your labels</Text>
                <View style={styles.chips}>
                  {offered.map((name) => (
                    <Pressable
                      key={name}
                      style={styles.chip}
                      disabled={busy}
                      onPress={() => add(name)}
                    >
                      <Text style={styles.chipTxt}>{name}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            {onApplyCategory ? (
              <Pressable style={styles.applyRow} disabled={busy} onPress={onApplyCategory}>
                <Text style={styles.applyTxt}>Apply this email's category as a label in your mail app</Text>
              </Pressable>
            ) : null}

            <Text style={styles.hint}>
              Labels live in Chord. Your mail app shows them only if you turned on
              tagging in Settings.
            </Text>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = themed((colors) => ({
  flex: { flex: 1 },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  box: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  done: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chipOn: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.accentLight,
  },
  chipOnTxt: { color: colors.accentDark, fontSize: 13, fontWeight: '600' },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.bg,
  },
  chipTxt: { color: colors.text, fontSize: 13 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  addBtnTxt: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.5 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 2 },
  applyRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  applyTxt: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 16 },
}));
