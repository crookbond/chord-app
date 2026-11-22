/**
 * ADR 0263 - asking for Contacts access.
 *
 * Google Play requires an in-app explanation of what is read and where it
 * goes BEFORE the system permission prompt, with the person agreeing to it.
 * iOS shows the app's own usage text inside its prompt, so there the system
 * prompt is the explanation and nothing extra is shown.
 */
import { Alert, Platform } from 'react-native';
import * as Contacts from 'expo-contacts';

function explain(what: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Allow Chord to read your contacts?',
      what,
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * True when Contacts can be read. Asks once if it has not been decided yet;
 * `what` says, in a sentence or two, what is read and what leaves the phone.
 */
export async function ensureContactsAccess(what: string): Promise<boolean> {
  const current = await Contacts.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  if (Platform.OS === 'android' && !(await explain(what))) return false;
  return (await Contacts.requestPermissionsAsync()).granted;
}
