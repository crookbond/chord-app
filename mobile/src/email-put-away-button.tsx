/**
 * The archive-or-trash icon beside an email suggestion's buttons (Action
 * Items, "Needs your attention", Feed/Cards). Which icon shows follows the
 * swipe setting (ADR 0215), since it is the same choice.
 */
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import type { EmailSwipeAction } from '@chord/kernel';

import { colors, themed } from '@/theme';

export function PutAwayButton({
  action,
  busy,
  onPress,
  style,
}: {
  action: EmailSwipeAction;
  busy?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      hitSlop={6}
      accessibilityLabel={action === 'trash' ? 'Move the email to Trash' : 'Archive the email'}
      style={({ pressed }) => [
        styles.btn,
        style,
        pressed && !busy && { opacity: 0.6 },
        busy && { opacity: 0.4 },
      ]}
    >
      <MaterialCommunityIcons
        name={action === 'trash' ? 'trash-can-outline' : 'archive-arrow-down-outline'}
        size={16}
        color={colors.muted}
      />
    </Pressable>
  );
}

const styles = themed((colors) => ({
  btn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
