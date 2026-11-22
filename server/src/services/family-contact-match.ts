/**
 * ADR 0237 — "is this email / phone already somebody on Chord?"
 *
 * A family invite names a person by a contact point the OWNER typed. If that
 * point already belongs to a real Chord account, nothing needs accepting: the
 * plan can simply cover them. This module only answers the identity question,
 * and only from proof the account itself gave us:
 *
 *   - its sign-in email,
 *   - a mailbox it connected (OAuth or an app password: control of the address),
 *   - a phone number it verified by code (ADR 0064).
 *
 * It never matches on a display name, and it answers "nobody" rather than guess
 * when two different accounts claim the same person.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';
import { normalizeE164 } from './phone/normalize.js';

/** An owner typing "(773) 555-0123" gave no country code. A bare 10-digit number
 *  is read as North American, the only region Chord signs up from today. */
export function phoneCandidates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const e164 = normalizeE164(raw);
  if (e164) return [e164];
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 10) return [`+1${digits}`];
  if (digits.length === 11 && digits.startsWith('1')) return [`+${digits}`];
  return [];
}

/** The one account that owns this email and/or phone, or null when none does or
 *  when the two contact points point at different people. */
export async function findAccountForContact(
  db: Kysely<DB>,
  contact: { email?: string | null; phone?: string | null },
  opts: { excludeUserIds?: string[] } = {},
): Promise<string | null> {
  const found = new Set<string>();
  const email = contact.email?.trim().toLowerCase() || null;
  if (email) {
    const byLogin = await db
      .selectFrom('users')
      .select('id')
      .where('shadow', '=', 0)
      .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
      .execute();
    for (const r of byLogin) found.add(r.id);
    const byMailbox = await db
      .selectFrom('email_accounts')
      .select('user_id')
      .where((eb) => eb(eb.fn('lower', ['email_address']), '=', email))
      .execute();
    for (const r of byMailbox) found.add(r.user_id);
  }
  const numbers = phoneCandidates(contact.phone);
  if (numbers.length > 0) {
    const byPhone = await db
      .selectFrom('users')
      .select('id')
      .where('shadow', '=', 0)
      .where('phone_verified', '=', 1)
      .where('phone_number', 'in', numbers)
      .execute();
    for (const r of byPhone) found.add(r.id);
  }
  for (const id of opts.excludeUserIds ?? []) found.delete(id);
  return found.size === 1 ? [...found][0]! : null;
}

/** Every contact point a signed-in account has proved, for the reverse lookup
 *  ("which pending invites are for me?"). */
export async function provenContactsOf(
  db: Kysely<DB>,
  userId: string,
): Promise<{ emails: string[]; phone: string | null }> {
  const u = await db
    .selectFrom('users')
    .select(['email', 'phone_number', 'phone_verified'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const mailboxes = await db
    .selectFrom('email_accounts')
    .select('email_address')
    .where('user_id', '=', userId)
    .execute();
  const emails = new Set<string>();
  if (u?.email) emails.add(u.email.trim().toLowerCase());
  for (const m of mailboxes) if (m.email_address) emails.add(m.email_address.trim().toLowerCase());
  return { emails: [...emails], phone: u?.phone_verified === 1 ? (u.phone_number ?? null) : null };
}
