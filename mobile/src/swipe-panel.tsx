/**
 * Swipe gestures shared by the email list (ADR 0274) and the Action Items
 * cards: the coloured panel behind a swiped row, and a wrapper that runs one
 * action when a card is swiped away to the left.
 */
import { useRef, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';

import { Icon, type IconName } from '@/email-reader-bar';
import { colors, themed } from '@/theme';

export const SWIPE_THRESHOLD = 56;
const SWIPE_WIDTH = 92;

/** The coloured panel behind a swiped row: full height, and its icon grows in
 *  with the drag instead of a fixed label popping into view. */
export function SwipePanel({
  progress,
  color,
  icon,
  label,
}: {
  progress: SharedValue<number>;
  color: string;
  icon: IconName;
  label: string;
}) {
  const content = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4, 1], [0, 0.6, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.6, 1], Extrapolation.CLAMP) }],
  }));
  return (
    <View style={[styles.action, { backgroundColor: color }]} accessibilityLabel={label}>
      <Animated.View style={[styles.content, content]}>
        <Icon name={icon} size={22} color="#fff" />
        <Text style={styles.txt}>{label}</Text>
      </Animated.View>
    </View>
  );
}

/**
 * Swipe the card left (finger moving left) to run `onDismiss`. Phones only:
 * the web has no swipe and keeps the card's own dismiss button. With no
 * `onDismiss` (the card is busy, or cannot be dismissed) it is a plain card.
 */
export function SwipeToDismiss({
  onDismiss,
  label = 'Dismiss',
  children,
}: {
  onDismiss?: () => void;
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<SwipeableMethods>(null);
  if (Platform.OS === 'web' || !onDismiss) return <>{children}</>;
  return (
    <Swipeable
      ref={ref}
      renderRightActions={(progress) => (
        <SwipePanel progress={progress} color={colors.red} icon="close" label={label} />
      )}
      onSwipeableWillOpen={(dir) => {
        if (dir === 'left') onDismiss();
      }}
      friction={1}
      rightThreshold={SWIPE_THRESHOLD}
      dragOffsetFromRightEdge={12}
      overshootRight={false}
      animationOptions={{ damping: 26, stiffness: 260, mass: 0.6 }}
      containerStyle={styles.container}
    >
      {children}
    </Swipeable>
  );
}

const styles = themed((c) => ({
  container: { backgroundColor: c.bg, borderRadius: 10 },
  action: { width: SWIPE_WIDTH, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  content: { alignItems: 'center', gap: 2 },
  txt: { color: '#fff', fontSize: 12, fontWeight: '600' },
}));
