/**
 * Where an email address the model wants to send to, invite or save is
 * allowed to come from. Prod 2026-10-30: the model handed over twelve
 * mailing lists as `name@example.com`, and the same model writes the
 * recipients of a chat-drafted email, the guests of an event and the address
 * of a family invite. A card shows the address before the tap, but a
 * plausible guess reads as right, and mail sent to a stranger cannot be
 * taken back - so an address must have a source, not just a shape.
 *
 * Known = the user typed it in the conversation, it is a sender or recipient
 * in their own mail, it is on a person they saved or a family-plan entry,
 * it is the account address of someone they share a chat with, or their
 * phone's Contacts returned it during this turn.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function addressesIn(text: string): string[] {
  return [...new Set((text.match(ADDRESS) ?? []).map((a) => a.toLowerCase()))];
}

/** Addresses the phone's Contacts returned this turn (ADR 0212): not stored
 *  anywhere, so held per turn only, in memory like the other per-turn state. */
const seenByTurn = new Map<string, { at: number; emails: Set<string> }>();
const SEEN_TTL_MS = 30 * 60_000;
const MAX_TURNS = 2000;

export function noteAddressesSeen(turnId: string | null | undefined, emails: Iterable<string>): void {
  if (!turnId) return;
  const now = Date.now();
  const entry = seenByTurn.get(turnId) ?? { at: now, emails: new Set<string>() };
  for (const e of emails) if (e) entry.emails.add(e.trim().toLowerCase());
  entry.at = now;
  seenByTurn.set(turnId, entry);
  if (seenByTurn.size > MAX_TURNS) {
    for (const [k, v] of seenByTurn) if (v.at < now - SEEN_TTL_MS || seenByTurn.size > MAX_TURNS) seenByTurn.delete(k);
  }
}

function seenThisTurn(turnId: string | null | undefined): Set<string> {
  if (!turnId) return new Set();
  const entry = seenByTurn.get(turnId);
  return entry && entry.at >= Date.now() - SEEN_TTL_MS ? entry.emails : new Set();
}

/**
 * The addresses in `addresses` with no source. `typedByUser` is the user's
 * own words; null means no person is behind this call (ingest, a confirmed
 * card), and then nothing is checked - the check happened when the card was
 * staged, or the address came from a file or a feed, not from the model.
 */
export async function unknownAddresses(
  db: Kysely<DB>,
  userId: string,
  addresses: string[],
  typedByUser: string | null,
  turnId?: string | null,
): Promise<string[]> {
  if (typedByUser === null) return [];
  // Whole addresses only: a substring test let `bob@x.com` pass because the
  // user typed `notbob@x.com.evil`.
  const typed = new Set(addressesIn(typedByUser));
  const seen = seenThisTurn(turnId);
  const out: string[] = [];
  for (const address of new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))) {
    if (typed.has(address) || seen.has(address)) continue;
    if (!(await isKnownAddress(db, userId, address))) out.push(address);
  }
  return out;
}

async function isKnownAddress(db: Kysely<DB>, userId: string, address: string): Promise<boolean> {
  const inMail = await db
    .selectFrom('email_messages')
    .select('id')
    .where('user_id', '=', userId)
    // Equality on each recipient, not a LIKE over the JSON text: `_` and `%`
    // are legal in an address and are LIKE wildcards, so `a_b@x.com` was
    // "known" from mail to `axb@x.com`.
    .where((eb) =>
      eb.or([
        eb(sql<string>`lower(from_email)`, '=', address),
        sql<boolean>`exists (select 1 from jsonb_array_elements_text(to_emails || cc_emails) r(addr) where lower(r.addr) = ${address})`,
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  if (inMail) return true;
  const person = await db
    .selectFrom('people')
    .select('id')
    .where('owner_user_id', '=', userId)
    .where(sql<string>`lower(email)`, '=', address)
    .limit(1)
    .executeTakeFirst();
  if (person) return true;
  const family = await db
    .selectFrom('family_members')
    .select('id')
    .where('owner_user_id', '=', userId)
    .where(sql<string>`lower(email)`, '=', address)
    .limit(1)
    .executeTakeFirst();
  if (family) return true;
  const member = await db
    .selectFrom('users as u')
    .innerJoin('group_members as them', 'them.user_id', 'u.id')
    .innerJoin('group_members as me', 'me.group_id', 'them.group_id')
    .select('u.id')
    .where('me.user_id', '=', userId)
    .where(sql<string>`lower(u.email)`, '=', address)
    .limit(1)
    .executeTakeFirst();
  return !!member;
}

/** What the model is told when an address has no source. */
export function unknownAddressInstruction(unknown: string[]): string {
  return (
    `NOTHING was sent, invited or saved: ${unknown.join(', ')} ` +
    (unknown.length === 1 ? 'is' : 'are') +
    " not in the user's mail, People, family plan or contacts, and the user did not type " +
    (unknown.length === 1 ? 'it' : 'them') +
    '. Never guess an address. Look it up (get_contact_info, search) or ask the user for it, then call again.'
  );
}

export const __testing = {
  reset(): void {
    seenByTurn.clear();
  },
};
