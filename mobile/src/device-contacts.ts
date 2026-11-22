/**
 * ADR 0114 addendum — this phone's contacts as recipient suggestions.
 *
 * The address book is read here and matched here (`suggestDeviceRecipients`);
 * nothing from it is sent to the server (ADR 0065). Only entries with an email
 * are kept, since a recipient field takes addresses. Web has no address book,
 * so suggestions there stay mail-derived only.
 */
import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import { suggestDeviceRecipients, type EmailRecipientSuggestion, type RawDeviceContact } from '@chord/kernel';

import { ensureContactsAccess } from './contacts-access';
import { onSignOut } from './sign-out';

// The book changes rarely while someone writes a message; re-read after this.
const FRESH_MS = 5 * 60_000;

let cache: { at: number; contacts: RawDeviceContact[] } | null = null;
let loading: Promise<RawDeviceContact[]> | null = null;
let askedThisRun = false;

onSignOut(() => {
  cache = null;
  loading = null;
});

async function read(): Promise<RawDeviceContact[]> {
  const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Emails] });
  const contacts = data
    .filter((c) => (c.emails ?? []).some((e) => !!e.email))
    .map((c) => ({
      name: c.name,
      firstName: c.firstName,
      lastName: c.lastName,
      emails: (c.emails ?? []).map((e) => ({ email: e.email })),
    }));
  cache = { at: Date.now(), contacts };
  return contacts;
}

/**
 * Contacts with an email, or [] when they can't be read. `ask` = may show the
 * permission prompt (once per app run, from a field being focused — never
 * mid-keystroke).
 */
async function deviceContacts(ask: boolean): Promise<RawDeviceContact[]> {
  if (Platform.OS === 'web') return [];
  try {
    const perm = await Contacts.getPermissionsAsync();
    if (!perm.granted) {
      if (!ask || askedThisRun || !perm.canAskAgain) return [];
      askedThisRun = true;
      const ok = await ensureContactsAccess(
        'Chord suggests people from your contacts as you type an email address or add a guest. ' +
          'The matching happens on this phone; your address book is not uploaded.',
      );
      if (!ok) return [];
    }
    if (cache && Date.now() - cache.at < FRESH_MS) return cache.contacts;
    loading ??= read().finally(() => {
      loading = null;
    });
    return await loading;
  } catch {
    return cache?.contacts ?? [];
  }
}

/** Called when a recipient field gets focus: asks once, then warms the cache. */
export function prepareDeviceContacts(): void {
  void deviceContacts(true);
}

export async function suggestFromDeviceContacts(token: string): Promise<EmailRecipientSuggestion[]> {
  return suggestDeviceRecipients(token, await deviceContacts(false));
}
