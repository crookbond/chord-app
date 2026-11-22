import { Text, View } from 'react-native';

import { themed } from '@/theme';

/**
 * How much unread mail a category holds, on the AI view's cards (Feed and
 * Cards). Carries the word, not a bare number: a Cards header can also show
 * a count of open decisions in the category's own colour, and two unlabelled
 * numbers side by side say nothing about which is which. Chord's accent
 * rather than the category colour, for the same reason.
 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.txt}>{count} unread</Text>
    </View>
  );
}

const styles = themed((colors) => ({
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 9,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  txt: { color: colors.onAccent, fontSize: 11, fontWeight: '700' },
}));
