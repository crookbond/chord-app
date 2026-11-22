/**
 * A screen opened with nothing behind it - a web reload, a restored tab, a
 * link - has no stack history, so the header's own back arrow is not drawn and
 * `router.back()` does nothing. Screens without the tab bar would then have no
 * way out. These go back when there is somewhere to go, else to `home`.
 */
import { router, type Href } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { Icon } from '@/email-reader-bar';
import { themed } from '@/theme';

export function goBackOr(home: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(home);
}

/** `headerLeft` for a screen that may be opened with no history: undefined
 *  (the stack's back arrow) when there is history, else a button to `home`. */
export function backHomeHeaderLeft(label: string, home: Href) {
  if (router.canGoBack()) return undefined;
  return function BackHome() {
    return (
      <Pressable
        onPress={() => router.replace(home)}
        hitSlop={8}
        accessibilityRole="link"
        accessibilityLabel={`${label}, back`}
        style={styles.btn}
      >
        <Icon name="chevron-left" size={24} />
        <Text style={styles.label}>{label}</Text>
      </Pressable>
    );
  };
}

const styles = themed((colors) => ({
  btn: { flexDirection: 'row' as const, alignItems: 'center' as const, paddingRight: 8 },
  label: { color: colors.accent, fontSize: 16 },
}));
