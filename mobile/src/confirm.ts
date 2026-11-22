import { Alert, Platform } from 'react-native';

/**
 * Cross-platform destructive confirmation.
 *
 * React Native Web does not render the button list passed to `Alert.alert`,
 * so a native-style action sheet silently no-ops on web - the confirm callback
 * never fires and the action "appears blocked". Route every destructive
 * confirmation through here: it uses the browser's `window.confirm` on web and
 * the real `Alert` on iOS/Android.
 *
 * `window.confirm` only renders OK/Cancel, so `confirmLabel`/`cancelLabel`
 * affect the native action sheet only - keep the wording in `message` clear
 * enough to stand on its own for the web case.
 */
export function confirmDestructive(
  title: string,
  message: string,
  onConfirm: () => void,
  options?: { confirmLabel?: string; cancelLabel?: string },
): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: options?.cancelLabel ?? 'Cancel', style: 'cancel' },
    { text: options?.confirmLabel ?? 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}
