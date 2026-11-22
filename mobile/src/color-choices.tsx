import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CALENDAR_COLOR_CHOICES } from '@chord/kernel';

import { colors, themed } from '@/theme';

/**
 * ADR 0278 — the color choices for a calendar or a mailbox: one dot per named
 * color, then "Default" (back to the provider's color or Chord's palette).
 * `picked` is the user's current pick, null when they have none.
 */
export function ColorChoiceRow({
  picked,
  disabled,
  onPick,
}: {
  picked: string | null;
  disabled?: boolean;
  onPick: (hex: string | null) => void;
}) {
  const current = picked?.toUpperCase() ?? null;
  return (
    <View style={styles.palette}>
      {CALENDAR_COLOR_CHOICES.map((c) => (
        <Pressable
          key={c.name}
          onPress={() => onPick(c.hex)}
          disabled={disabled}
          accessibilityLabel={c.name}
          style={[styles.dot, { backgroundColor: c.hex }, current === c.hex && styles.dotOn]}
        />
      ))}
      <Pressable
        onPress={() => onPick(null)}
        disabled={disabled || current === null}
        style={[styles.reset, current === null && styles.resetOn]}
      >
        <Text style={[styles.resetTxt, current === null && styles.resetTxtOn]}>Default</Text>
      </Pressable>
    </View>
  );
}

/** A tappable square in a color; opens the choices. */
export function ColorSwatch({
  color,
  onPress,
  disabled,
  label,
}: {
  color: string | null | undefined;
  onPress: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      hitSlop={8}
      style={[styles.swatch, { backgroundColor: color ?? colors.border }]}
    />
  );
}

const styles = themed((colors) => ({
  palette: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  dot: { width: 24, height: 24, borderRadius: 12 },
  dotOn: { borderWidth: 3, borderColor: colors.text },
  reset: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  resetOn: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  resetTxt: { fontSize: 12, fontWeight: '600', color: colors.muted },
  resetTxtOn: { color: colors.accent },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
}));
