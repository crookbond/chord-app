import { Platform, Pressable, Text, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';

import { nextGroupSelection } from '@chord/kernel';

import { themed } from '@/theme';

/**
 * ADR 0247 — "Just me" plus one chip per group; several groups can be picked.
 * On a phone every tap toggles a group. On the web a plain click picks one
 * group and Ctrl/⌘-click adds or removes, like selecting files.
 */
export function GroupChips({
  groups,
  selected,
  onChange,
  style,
}: {
  groups: { id: string; name: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const web = Platform.OS === 'web';
  const press = (id: string | null) => (e: GestureResponderEvent) => {
    const ev = e.nativeEvent as unknown as { ctrlKey?: boolean; metaKey?: boolean };
    const additive = !web || !!ev.ctrlKey || !!ev.metaKey;
    onChange(nextGroupSelection(selected, id, additive));
  };
  return (
    <View>
      <View style={[st.chipRow, style]}>
        <Pressable onPress={press(null)} hitSlop={4} accessibilityRole="checkbox" accessibilityState={{ checked: selected.length === 0 }}>
          <Text style={[st.chip, selected.length === 0 && st.chipActive]}>Just me</Text>
        </Pressable>
        {groups.map((g) => {
          const on = selected.includes(g.id);
          return (
            <Pressable
              key={g.id}
              onPress={press(g.id)}
              hitSlop={4}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
            >
              <Text style={[st.chip, on && st.chipActive]} numberOfLines={1}>
                {on && selected.length > 1 ? '✓ ' : ''}
                {g.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {web && groups.length > 1 ? (
        <Text style={st.hint}>Ctrl-click (⌘ on a Mac) to pick more than one group.</Text>
      ) : null}
    </View>
  );
}

const st = themed((colors) => ({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  chip: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: 140,
  },
  chipActive: { color: colors.onAccent, backgroundColor: colors.accent, borderColor: colors.accent },
  hint: { fontSize: 11, color: colors.muted, marginTop: 4 },
}));
