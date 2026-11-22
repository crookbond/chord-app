import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * ADR 0263 - the room something pinned to the bottom needs on Android, where
 * the app and its modals draw edge-to-edge and the system navigation bar sits
 * on top of them. Zero on iOS, where those layouts were drawn around the home
 * indicator already.
 */
export function useAndroidBottomInset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'android' ? insets.bottom : 0;
}
