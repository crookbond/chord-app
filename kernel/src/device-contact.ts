/**
 * ADR 0212 — shaping one device address-book entry into the `contact.lookup`
 * answer. Lives in kernel (not beside the mobile code that calls it) because
 * mobile has no test harness, and the month offset below is exactly the kind
 * of thing that ships wrong untested.
 */
import { mentionsRole } from './roles';
import type { DeviceContactMatch } from './types/contact-discovery';
import type { EmailRecipientSuggestion } from './types/email';

export interface RawDeviceContact {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  emails?: Array<{ email?: string | null }> | null;
  phoneNumbers?: Array<{ number?: string | null }> | null;
  /** expo-contacts `Date`: month is 0-based (JS `Date` convention). */
  birthday?: { day?: number | null; month?: number | null; year?: number | null } | null;
  /** ADR 0275: what the entry says it is - "Bright Smiles Dental", "Pediatrician". */
  company?: string | null;
  jobTitle?: string | null;
}

const MAX_MATCHES = 5;
const MAX_VALUES = 10;

/** 'YYYY-MM-DD', year '0000' when unknown — the `important_dates` convention. */
export function deviceBirthdayToIsoDate(b: RawDeviceContact['birthday']): string | undefined {
  if (!b || b.day == null || b.month == null) return undefined;
  const month = b.month + 1;
  if (month < 1 || month > 12 || b.day < 1 || b.day > 31) return undefined;
  const year = b.year && b.year > 0 ? b.year : 0;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(b.day, 2)}`;
}

function uniq(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, MAX_VALUES);
}

function displayName(c: RawDeviceContact): string {
  return (c.name?.trim() || [c.firstName, c.lastName].filter(Boolean).join(' ').trim());
}

/**
 * Entries whose name contains every word of the query, exact full-name
 * matches first. The OS name filter is looser (and differs per platform), so
 * this is the rule that decides what leaves the phone.
 */
export function matchDeviceContacts(query: string, contacts: RawDeviceContact[]): DeviceContactMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const q = words.join(' ');
  const hits: Array<{ exact: boolean; m: DeviceContactMatch }> = [];
  for (const c of contacts) {
    const name = displayName(c);
    if (!name) continue;
    const tokens = name.toLowerCase().split(/\s+/);
    if (!words.every((w) => tokens.some((t) => t.startsWith(w)))) continue;
    const birthday = deviceBirthdayToIsoDate(c.birthday);
    hits.push({
      exact: name.toLowerCase() === q,
      m: {
        name,
        emails: uniq((c.emails ?? []).map((e) => e.email)),
        phones: uniq((c.phoneNumbers ?? []).map((p) => p.number)),
        ...(birthday ? { birthday } : {}),
      },
    });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return hits.slice(0, MAX_MATCHES).map((h) => h.m);
}

/**
 * ADR 0275 — entries that ARE a role ("the dentist"): the role's words in the
 * company, the job title or the name ("Dr. Patel (dentist)"). Entries with an
 * email first, since an email is what a mail search can use. Only these leave
 * the phone, like a name lookup.
 */
/**
 * Whether an entry is that role, judged on its name, company and job title
 * only - so the phone can read just those fields for the whole book and
 * fetch addresses and numbers for the few that are (ADR 0275).
 */
export function contactIsRole(terms: string[], c: RawDeviceContact): boolean {
  const name = displayName(c) || c.company?.trim() || '';
  if (!name) return false;
  return mentionsRole(c.company, terms) || mentionsRole(c.jobTitle, terms) || mentionsRole(name, terms);
}

export function matchDeviceContactsByRole(terms: string[], contacts: RawDeviceContact[]): DeviceContactMatch[] {
  const hits: DeviceContactMatch[] = [];
  for (const c of contacts) {
    const name = displayName(c) || c.company?.trim() || '';
    if (!contactIsRole(terms, c)) continue;
    const company = c.company?.trim();
    hits.push({
      name,
      emails: uniq((c.emails ?? []).map((e) => e.email)),
      phones: uniq((c.phoneNumbers ?? []).map((p) => p.number)),
      ...(company ? { company: company.slice(0, 200) } : {}),
    });
  }
  hits.sort((a, b) => Number(b.emails.length > 0) - Number(a.emails.length > 0));
  return hits.slice(0, MAX_MATCHES);
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * ADR 0114 addendum — recipient suggestions from this phone's address book,
 * for the token being typed. Matched here, on the device: nothing is sent.
 * A contact matches when every word typed starts a word of its name, or the
 * token starts one of its addresses (or that address's local part). One row
 * per address; entries without an email are skipped (a recipient field takes
 * addresses). Name matches come before address-only matches.
 */
export function suggestDeviceRecipients(
  token: string,
  contacts: RawDeviceContact[],
  limit = 5,
): EmailRecipientSuggestion[] {
  const t = token.trim().toLowerCase();
  if (t.length < 2) return [];
  const words = t.split(/\s+/).filter(Boolean);
  const byName: EmailRecipientSuggestion[] = [];
  const byEmail: EmailRecipientSuggestion[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    const name = displayName(c);
    const nameTokens = name.toLowerCase().split(/[\s.\-']+/).filter(Boolean);
    const nameHit = !!name && words.every((w) => nameTokens.some((n) => n.startsWith(w)));
    for (const e of c.emails ?? []) {
      const email = e.email?.trim().toLowerCase();
      if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
      const emailHit = email.startsWith(t);
      if (!nameHit && !emailHit) continue;
      seen.add(email);
      const row: EmailRecipientSuggestion = { email, name: name || null, source: 'contacts' };
      (nameHit ? byName : byEmail).push(row);
    }
  }
  return [...byName, ...byEmail].slice(0, limit);
}

/**
 * The server's suggestions (ranked by how much mail was exchanged) first,
 * then the phone's, one row per address. A server row with no name borrows
 * the contact's name, which is how the person is known on this phone.
 */
export function mergeRecipientSuggestions(
  server: EmailRecipientSuggestion[],
  device: EmailRecipientSuggestion[],
  limit = 8,
): EmailRecipientSuggestion[] {
  const deviceName = new Map(device.map((d) => [d.email.toLowerCase(), d.name]));
  const out: EmailRecipientSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of server) {
    const key = s.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.name ? s : { ...s, name: deviceName.get(key) ?? null });
  }
  for (const d of device) {
    const key = d.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.slice(0, limit);
}

/**
 * The event editor's guest box: what was typed, split on commas/semicolons,
 * as lowercase addresses plus what is not an address (a name the user did
 * not pick from the suggestions), which is shown rather than sent.
 */
export function parseGuestAddresses(value: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of value.split(/[,;]/)) {
    const raw = part.trim();
    if (!raw) continue;
    const bracketed = /<([^<>]+)>\s*$/.exec(raw)?.[1]?.trim();
    const email = (bracketed ?? raw).toLowerCase();
    if (EMAIL_RE.test(email)) {
      if (!emails.includes(email)) emails.push(email);
    } else invalid.push(raw);
  }
  return { emails, invalid };
}

export type DeviceInviteePick =
  | { kind: 'email'; email: string; name: string }
  | { kind: 'ambiguous'; candidates: Array<{ name: string; email: string }> }
  | { kind: 'none' };

/**
 * ADR 0157 addendum — what the phone's answer for an invitee name settles.
 * Only entries with an address count. One entry whose full name IS the name
 * asked wins; otherwise exactly one entry wins; several = ask, never guess.
 * A contact with several addresses is invited at its first one (the order the
 * phone lists them, primary first), which the reply names.
 */
export function pickInviteeFromDevice(query: string, matches: DeviceContactMatch[]): DeviceInviteePick {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const withEmail = matches
    .map((m) => ({ name: m.name, email: m.emails.find((e) => EMAIL_RE.test(e.trim()))?.trim().toLowerCase() }))
    .filter((m): m is { name: string; email: string } => !!m.email);
  if (withEmail.length === 0) return { kind: 'none' };
  const exact = withEmail.filter((m) => m.name.toLowerCase().replace(/\s+/g, ' ') === q);
  const pool = exact.length > 0 ? exact : withEmail;
  const distinct = [...new Map(pool.map((m) => [m.email, m])).values()];
  if (distinct.length === 1) return { kind: 'email', ...distinct[0]! };
  return { kind: 'ambiguous', candidates: distinct.slice(0, MAX_MATCHES) };
}
