/**
 * ADR 0346 phase 4 - slots held in Chord while the other side's invitation
 * is on its way. Shown on the Calendar screen only: a hold is never on a
 * calendar, so it is listed above the grid rather than drawn as an event.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { suggestionWhen, type MeetingHold } from '@chord/kernel';

import { dropMeetingHold, listMeetingHolds } from '@/api';
import { themed } from '@/theme';

export function HeldStrip() {
  const [holds, setHolds] = useState<MeetingHold[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      listMeetingHolds()
        .then((h) => live && setHolds(h))
        .catch(() => {});
      return () => {
        live = false;
      };
    }, []),
  );

  if (holds.length === 0) return null;
  const drop = async (id: string) => {
    setBusy(id);
    try {
      await dropMeetingHold(id);
      setHolds((h) => h.filter((x) => x.meetingId !== id));
    } catch {
      // leave it listed; a retry is one tap away
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.strip}>
      {holds.map((h) => (
        <View key={h.meetingId} style={styles.row}>
          <Text style={styles.txt} numberOfLines={2}>
            ⏳ Held in Chord: {h.title}, {suggestionWhen(h.startsAt, { weekday: true, withTime: true }) ?? ''}
            {h.withName ? ` · waiting on ${h.withName}'s invite` : ' · waiting on the invite'}
          </Text>
          <Pressable disabled={busy === h.meetingId} onPress={() => void drop(h.meetingId)} hitSlop={6}>
            <Text style={styles.drop}>Stop holding</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = themed((colors) => ({
  strip: { paddingHorizontal: 12, paddingVertical: 4, gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  txt: { flex: 1, color: colors.text, fontSize: 12 },
  drop: { color: colors.accent, fontSize: 12, fontWeight: '700' },
}));
