/**
 * Shows the first few action cards and stacks the rest behind one card that
 * says how many more; a tap opens the stack, "Show fewer" closes it. The
 * split itself is `cardStack` in kernel.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { cardStack } from '@chord/kernel';

import { themed } from '@/theme';

export function StackedCards<T>({
  items,
  open,
  onToggle,
  render,
  limit,
  minStacked,
  label = (n: number) => `${n} more`,
}: {
  items: T[];
  /** Cards shown before the stack (kernel default 5). */
  limit?: number;
  minStacked?: number;
  label?: (n: number) => string;
  open: boolean;
  onToggle: () => void;
  render: (item: T) => ReactNode;
}) {
  const { shown, stacked } = cardStack(items, open, limit, minStacked);
  const closable = open && cardStack(items, false, limit, minStacked).stacked.length > 0;
  return (
    <>
      {shown.map(render)}
      {stacked.length > 0 ? (
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={`Show ${stacked.length} more`}
          style={styles.stack}
        >
          <View style={[styles.layer, styles.layerBack]} />
          <View style={[styles.layer, styles.layerMid]} />
          <View style={styles.front}>
            <Text style={styles.more}>{label(stacked.length)}</Text>
            <Text style={styles.hint}>Tap to show</Text>
          </View>
        </Pressable>
      ) : null}
      {closable ? (
        <Pressable onPress={onToggle} accessibilityRole="button" style={styles.fewer}>
          <Text style={styles.hint}>Show fewer</Text>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = themed((colors) => ({
  stack: { paddingBottom: 8 },
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 10,
  },
  layerBack: { bottom: 0, marginHorizontal: 16 },
  layerMid: { bottom: 4, marginHorizontal: 8 },
  front: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  more: { color: colors.text, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  fewer: { alignSelf: 'center', paddingVertical: 4 },
}));
