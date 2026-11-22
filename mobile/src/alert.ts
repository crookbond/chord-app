/**
 * RN's Alert.alert is a silent no-op on react-native-web, so any error path
 * that relies on it simply does nothing in the browser. Every user-facing
 * failure message goes through here instead.
 */
import { Alert, Platform } from 'react-native';

export function showAlert(title: string, message: string): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

/** Human-readable reason a file failed to open (410 = blob gone server-side;
 *  404/ENOENT cover older servers - same detection as the Attachments tab). */
export function fileOpenErrorMessage(filename: string, err: Error): string {
  if (/\b(410|404)\b/.test(err.message) || /BLOB_MISSING|ENOENT/i.test(err.message)) {
    return `“${filename}” is no longer stored on the server. Upload it again to restore it.`;
  }
  return `${filename}: ${err.message}`;
}
