/**
 * One reading of a mail question, for both search surfaces (ADR 0270).
 *
 * A query arrives as text (with ADR 0126 operators), possibly with structured
 * filters from the bot tool, possibly as plain language ("emails from Bill
 * about the cabin"). This turns all three into the same `findEmailThreads`
 * input: the topic as free text, and each person resolved to the addresses
 * they write from. Done once here so the bot and the search box cannot read
 * the same question two ways (the ADR 0085 rule, one step earlier).
 */
import type { Kysely } from 'kysely';

import { parseMailIntent, parseSearchQuery, roleTerms, type EmailAction, type SearchQuery } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import type { EmailFactKind, EmailSearchInput } from './email-search.js';
import { resolveCorrespondent, type CorrespondentCandidate } from './person-resolve.js';

export interface MailFilters {
  from?: string;
  to?: string;
  /** ISO instants, inclusive. */
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  actions?: EmailAction[];
  kind?: EmailFactKind;
}

export interface PersonResolution {
  role: 'from' | 'to';
  asked: string;
  status: 'resolved' | 'ambiguous' | 'none';
  candidates: CorrespondentCandidate[];
  /** ADR 0275: where a role ("the dentist") was found. */
  via?: 'people' | 'contacts' | 'senders' | 'phone';
  /** ADR 0275: the phone's address-book entries that are the role - offer to save them to People. */
  phoneContacts?: PhoneContact[];
}

export interface PhoneContact {
  name: string;
  emails: string[];
  company?: string;
}

/**
 * Asks the user's phone which address-book entries are a role (ADR 0275).
 * Null when no phone answered. Supplied by the caller, which owns the turn.
 */
export type AskPhoneForRole = (asked: string, terms: string[]) => Promise<PhoneContact[] | null>;

export type MailFind = Omit<EmailSearchInput, 'userId' | 'limit' | 'order' | 'categoryIds' | 'withHeadline'>;

export interface PreparedMailQuery {
  parsed: SearchQuery;
  find: MailFind;
  /** True when anything but free text narrows the search (a person, a date, a kind...). */
  narrowed: boolean;
  people: PersonResolution[];
  /** A person was asked for and could not be pinned down: search no mail, ask instead. */
  blocked: boolean;
}

/**
 * What the bot is told when a person could not be pinned down. The candidates
 * are written out, so the model copies them: an address seen only on a To/Cc
 * line has no name, and asked to "list each name" the model made one up
 * from the address (andrewallen5@ became "Andrea Allen").
 */
export function askWhichPersonInstruction(unclear: PersonResolution[]): string {
  const lists = unclear.map((p) => {
    const options = p.candidates.map((c) =>
      c.name ? `${c.name} <${c.emails.join(', ')}>` : `${c.emails.join(', ')} (name not known)`,
    );
    return `"${p.asked}": ${options.join('; ')}`;
  });
  return (
    `More than one person matches. Ask the user which one they mean, listing these exactly as written - ` +
    `${lists.join(' | ')}. Where the name is not known, give only the address; never make up a name from an address. ` +
    `Do not guess and do not report email results yet.`
  );
}

export async function prepareMailQuery(
  db: Kysely<DB>,
  userId: string,
  raw: string,
  filters: MailFilters = {},
  opts: { askPhone?: AskPhoneForRole } = {},
): Promise<PreparedMailQuery> {
  const parsed = parseSearchQuery(raw);
  const explicitPerson = filters.from || filters.to || parsed.from || parsed.to;
  // Plain language is read only when nothing structured names a person.
  const intent = explicitPerson ? null : parseMailIntent(parsed.text);
  const fromIntent = !!(intent && (intent.from || intent.to));

  const find: MailFind = {
    text: fromIntent ? intent!.text : parsed.text,
    hasAttachment: filters.hasAttachment ?? parsed.hasAttachment === true,
    after: filters.after ?? parsed.after ?? (fromIntent ? intent!.after : undefined),
    before: filters.before ?? parsed.before,
    label: parsed.label,
    actions: filters.actions,
    kind: filters.kind,
  };
  const people: PersonResolution[] = [];
  let blocked = false;
  let intentFailed = false;

  const resolveRole = async (role: 'from' | 'to', asked: string | undefined, fromPlainLanguage: boolean) => {
    if (!asked) return;
    const r = await resolveCorrespondent(db, userId, asked, { direction: role });
    if (r.status === 'address' || r.status === 'domain') {
      if (role === 'from') {
        find.fromAddresses = r.addresses;
        find.fromDomains = r.domains;
      } else {
        find.toAddresses = r.addresses;
        find.toDomains = r.domains;
      }
      people.push({ role, asked, status: 'resolved', candidates: [] });
      return;
    }
    if (r.status === 'resolved') {
      if (role === 'from') {
        find.fromAddresses = r.addresses;
        find.fromNamed = r.named;
      } else {
        // A recipient address carries no sender name to check against.
        find.toAddresses = [...r.addresses, ...r.named.map((n) => n.email)];
      }
      people.push({ role, asked, status: 'resolved', candidates: r.candidates, ...(r.role ? { via: r.role.source } : {}) });
      return;
    }
    if (r.status === 'ambiguous') {
      people.push({ role, asked, status: 'ambiguous', candidates: r.candidates });
      blocked = true;
      return;
    }
    // ADR 0275 — a role nobody in the user's mail or People turned out to be:
    // the phone's address book may know ("Dr. Patel", company "Bright Smiles
    // Dental"). Its email addresses are the filter; the bot offers to save it.
    const terms = roleTerms(asked);
    if (terms && opts.askPhone) {
      const found = (await opts.askPhone(asked, terms))?.filter((c) => c.emails.length > 0) ?? [];
      if (found.length > 0) {
        const addresses = [...new Set(found.flatMap((c) => c.emails.map((e) => e.toLowerCase())))];
        if (role === 'from') find.fromAddresses = addresses;
        else find.toAddresses = addresses;
        people.push({
          role,
          asked,
          status: 'resolved',
          candidates: found.map((c) => ({ name: c.name, emails: c.emails, count: 0 })),
          via: 'phone',
          phoneContacts: found,
        });
        return;
      }
    }
    // Nobody by that name. Read from plain language, the words were probably
    // never a person ("mail from the school about the trip"): search them.
    if (fromPlainLanguage) {
      intentFailed = true;
      return;
    }
    people.push({ role, asked, status: 'none', candidates: [] });
    // An operator or tool field that names nobody still means something: a
    // sender's name the index can match by substring (ADR 0126's `from:`).
    // A recipient has no such fallback - the user asked for mail to someone
    // they never wrote to, and the honest answer is none.
    if (role === 'from') find.from = asked.toLowerCase();
    else blocked = true;
  };

  await resolveRole('from', filters.from ?? parsed.from ?? intent?.from, !filters.from && !parsed.from);
  await resolveRole('to', filters.to ?? parsed.to ?? intent?.to, !filters.to && !parsed.to);
  if (intentFailed) {
    find.text = parsed.text;
    find.after = filters.after ?? parsed.after;
  }

  const narrowed =
    !!find.from ||
    !!find.fromAddresses?.length ||
    !!find.fromNamed?.length ||
    !!find.fromDomains?.length ||
    !!find.toAddresses?.length ||
    !!find.toDomains?.length ||
    !!find.hasAttachment ||
    !!find.after ||
    !!find.before ||
    !!find.label ||
    !!find.actions?.length ||
    !!find.kind ||
    blocked;
  return { parsed, find, narrowed, people, blocked };
}
