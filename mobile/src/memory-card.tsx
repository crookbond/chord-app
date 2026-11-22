import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import {
  MEMORY_ACTION_LABEL,
  memoryCardActions,
  memoryStatusAfter,
  type BotCard,
  type MemoryCardAction,
} from '@chord/kernel';

import { confirmMemory, deleteFact, rejectMemory } from '@/api';
import { useApp } from '@/store';
import { themed } from '@/theme';

const META: Record<string, string> = {
  saved: 'Remembered',
  removed: 'Removed',
};

/**
 * ADR 0281 — a fact Chord just learned. The person who taught it can keep or
 * reject a suggestion, or forget a saved fact. The server rewrites the stored
 * card when the fact changes; until that arrives the tap is shown locally.
 */
export function MemoryCard({ card }: { card: BotCard }) {
  const userId = useApp((s) => s.user?.id);
  const [local, setLocal] = useState<BotCard['memoryStatus']>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => setLocal(undefined), [card.memoryStatus]);

  const status = local ?? card.memoryStatus;
  const shown: BotCard = { ...card, memoryStatus: status };
  const actions = busy ? [] : memoryCardActions(shown, userId);
  const meta = local ? META[local] ?? card.meta : card.meta;

  const act = async (a: MemoryCardAction) => {
    if (!card.memoryId) return;
    setBusy(true);
    try {
      if (a === 'keep') await confirmMemory(card.memoryId);
      else if (a === 'reject') await rejectMemory(card.memoryId);
      else await deleteFact(card.memoryId);
      setLocal(memoryStatusAfter(a));
    } catch (err) {
      Alert.alert('Could not change that', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const faded = status === 'removed' || status === 'replaced';
  return (
    <View style={[styles.card, faded && styles.faded]}>
      <Text style={styles.icon}>🧠</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={1}>
          {card.title}
        </Text>
        {card.subtitle ? (
          <Text style={[styles.value, faded && styles.struck]} numberOfLines={3}>
            {card.subtitle}
          </Text>
        ) : null}
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {actions.length > 0 && (
          <View style={styles.row}>
            {actions.map((a) => (
              <Pressable
                key={a}
                accessibilityRole="button"
                style={[styles.btn, a === 'keep' ? styles.btnYes : styles.btnNo]}
                onPress={() => void act(a)}
              >
                <Text style={a === 'keep' ? styles.btnYesTxt : styles.btnNoTxt}>
                  {MEMORY_ACTION_LABEL[a]}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  faded: { opacity: 0.6 },
  icon: { fontSize: 16, marginTop: 1 },
  title: { fontSize: 13, fontWeight: '700', color: colors.text },
  value: { fontSize: 13, color: colors.text, marginTop: 2 },
  struck: { textDecorationLine: 'line-through' },
  meta: { fontSize: 11, color: colors.muted, marginTop: 2, fontStyle: 'italic' },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  btnYes: { backgroundColor: colors.accent },
  btnYesTxt: { color: '#fff', fontWeight: '700', fontSize: 12 },
  btnNo: { backgroundColor: colors.accentLight },
  btnNoTxt: { color: colors.accent, fontWeight: '700', fontSize: 12 },
}));
