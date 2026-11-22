/**
 * ADR 0212 - answer the bot's `contact.lookup` from this phone's Contacts.
 *
 * Only the entries matching the one name asked about are sent, and only to
 * the turn that asked; the address book itself never leaves the phone. Web
 * has no address book and stays silent, so the server times out to
 * "unavailable".
 */
import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';

import {
  contactIsRole,
  matchDeviceContacts,
  matchDeviceContactsByRole,
  type DeviceContactLookupRequest,
  type DeviceContactLookupResponse,
} from '@chord/kernel';

import { answerContactLookup } from './api';
import { ensureContactsAccess } from './contacts-access';
import { onSignOut } from './sign-out';

const answered = new Set<string>();

/** The whole book's names, companies and job titles, for role lookups. Kept
 *  a minute: a turn can ask about two roles, and each read of a large book
 *  is seconds of work on the JS thread. Never addresses or numbers. */
const ROLE_BOOK_MS = 60_000;
let roleBook: { at: number; data: Contacts.ExistingContact[] } | null = null;

async function readRoleBook(): Promise<Contacts.ExistingContact[]> {
  if (roleBook && Date.now() - roleBook.at < ROLE_BOOK_MS) return roleBook.data;
  const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Company, Contacts.Fields.JobTitle] });
  roleBook = { at: Date.now(), data };
  return data;
}

onSignOut(() => {
  roleBook = null;
});

/** At most this many role candidates get their details read. */
const ROLE_DETAIL_MAX = 20;

// The user just asked for a contact, so this is the moment to ask - once.
const hasContactsAccess = (): Promise<boolean> =>
  ensureContactsAccess(
    'Chord will look in your contacts for the name or role you asked about, like your ' +
      "dentist. Only the matching contact's details are sent to Chord. Your address book " +
      'is not uploaded.',
  );

async function lookUp(query: string, role?: string[]): Promise<DeviceContactLookupResponse> {
  if (!(await hasContactsAccess())) return { status: 'no_permission', matches: [] };
  // ADR 0275 - "the dentist": a role is in the company or job title, not the
  // name, so the whole book is read here and only the entries that are that
  // role are sent.
  if (role?.length) {
    // Names, companies and titles for the whole book; addresses and numbers
    // only for the entries that are that role.
    const candidates = (await readRoleBook()).filter((c) => contactIsRole(role, c)).slice(0, ROLE_DETAIL_MAX);
    const detailed = (
      await Promise.all(
        candidates.map((c) =>
          c.id
            ? Contacts.getContactByIdAsync(c.id, [
                Contacts.Fields.Emails,
                Contacts.Fields.PhoneNumbers,
                Contacts.Fields.Company,
                Contacts.Fields.JobTitle,
              ]).catch(() => undefined)
            : Promise.resolve(c),
        ),
      )
    ).filter((c): c is Contacts.ExistingContact => !!c);
    const matches = matchDeviceContactsByRole(role, detailed);
    return matches.length > 0 ? { status: 'found', matches } : { status: 'not_found', matches: [] };
  }
  const fields = [Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers, Contacts.Fields.Birthday];
  // The OS name filter narrows the read; matchDeviceContacts decides what is sent.
  const firstWord = query.trim().split(/\s+/)[0] ?? query;
  const { data } = await Contacts.getContactsAsync({ name: firstWord, fields });
  const matches = matchDeviceContacts(query, data);
  return matches.length > 0 ? { status: 'found', matches } : { status: 'not_found', matches: [] };
}

export function handleContactLookup(req: DeviceContactLookupRequest, currentUserId?: string): void {
  if (Platform.OS === 'web') return;
  // An invitee lookup in a shared chat reaches every member's phone; only the
  // asker's searches (ADR 0157 addendum).
  if (req.forUserId && currentUserId && req.forUserId !== currentUserId) return;
  // A group stream reopened mid-turn can deliver the same request twice.
  if (answered.has(req.requestId)) return;
  answered.add(req.requestId);
  void (async () => {
    try {
      await answerContactLookup(req.requestId, await lookUp(req.query, req.role));
    } catch {
      // The turn times out to "unavailable", which is the honest answer here.
    }
  })();
}
