/**
 * Deterministic contact resolution (ADR 0065).
 *
 * The mobile client normalizes device-contact numbers to E.164, hashes them
 * (same pepper as the server — see normalize.ts), and uploads
 * `{ name, phoneHashes }`. We match those hashes against verified Chord users'
 * `phone_hash` and persist the resolved matches as `contact_links` — the
 * durable name→user map the flagship's `resolveContactToUser` reads.
 *
 * Scope: a user only ever resolves *their own* uploaded contacts, and links are
 * keyed on `owner_user_id`. `resolveContactToUser` never falls back to a global
 * user search — matching a name to a person is strictly bounded to the caller's
 * own address book (upholds the strict per-scope invariant, ADR 0004/0032).
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';

export interface ResolvedContact {
  /** The owner's address-book name for this contact. */
  name: string;
  chordUserId: string;
  displayName: string;
}

/**
 * Match an owner's uploaded (name, hashed-numbers) against verified Chord users
 * and persist the hits. Returns one entry per contact that resolved. Contacts
 * with no matching Chord user are silently dropped (never persisted), so we
 * don't retain a hash of the owner's entire address book.
 */
export async function resolveContacts(
  db: Kysely<DB>,
  ownerUserId: string,
  contacts: { name: string; phoneHashes: string[] }[],
): Promise<ResolvedContact[]> {
  // Flatten every candidate hash, then one query maps hash → verified user.
  const allHashes = [...new Set(contacts.flatMap((c) => c.phoneHashes))];
  if (allHashes.length === 0) return [];

  const users = await db
    .selectFrom('users')
    .select(['id', 'phone_hash', 'display_name', 'username'])
    .where('phone_hash', 'in', allHashes)
    .where('phone_verified', '=', 1)
    .execute();

  const byHash = new Map<string, { id: string; displayName: string }>();
  for (const u of users) {
    if (!u.phone_hash) continue;
    // A user never resolves to themselves (their own number in their contacts).
    if (u.id === ownerUserId) continue;
    byHash.set(u.phone_hash, { id: u.id, displayName: u.display_name ?? u.username });
  }

  const now = new Date().toISOString();
  const resolved: ResolvedContact[] = [];
  for (const c of contacts) {
    const name = c.name.trim();
    if (!name) continue;
    // First hash that maps to a verified user wins.
    let hit: { hash: string; id: string; displayName: string } | undefined;
    for (const h of c.phoneHashes) {
      const u = byHash.get(h);
      if (u) {
        hit = { hash: h, id: u.id, displayName: u.displayName };
        break;
      }
    }
    if (!hit) continue;

    await db
      .insertInto('contact_links')
      .values({
        id: newId('cl'),
        owner_user_id: ownerUserId,
        contact_name: name,
        phone_hash: hit.hash,
        chord_user_id: hit.id,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['owner_user_id', 'phone_hash']).doUpdateSet({
          contact_name: name,
          chord_user_id: hit.id,
          updated_at: now,
        }),
      )
      .execute();

    resolved.push({ name, chordUserId: hit.id, displayName: hit.displayName });
  }
  return resolved;
}

/** The caller's resolved contacts (for GET /me/contacts). */
export async function listContactLinks(
  db: Kysely<DB>,
  ownerUserId: string,
): Promise<ResolvedContact[]> {
  const rows = await db
    .selectFrom('contact_links')
    .innerJoin('users', 'users.id', 'contact_links.chord_user_id')
    .select([
      'contact_links.contact_name as name',
      'contact_links.chord_user_id as chordUserId',
      'users.display_name as displayName',
      'users.username as username',
    ])
    .where('contact_links.owner_user_id', '=', ownerUserId)
    .orderBy('contact_links.contact_name', 'asc')
    .execute();
  return rows.map((r) => ({
    name: r.name,
    chordUserId: r.chordUserId,
    displayName: r.displayName ?? r.username,
  }));
}

export type ContactResolution =
  | { kind: 'none' }
  | { kind: 'match'; chordUserId: string; displayName: string; contactName: string }
  | { kind: 'ambiguous'; matches: ResolvedContact[] };

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve a free-text name (from the flagship "message Adrian …" ask) to a
 * Chord user, using ONLY the sender's own resolved contacts. Exact
 * (case-insensitive) name matches win; failing that, a first-name / prefix
 * match is tried so "Adrian" resolves "Adrian Gupta". Multiple distinct
 * Chord users behind the name → `ambiguous` for the caller to disambiguate.
 */
export async function resolveContactToUser(
  db: Kysely<DB>,
  senderUserId: string,
  name: string,
): Promise<ContactResolution> {
  const needle = norm(name);
  if (!needle) return { kind: 'none' };

  const rows = await db
    .selectFrom('contact_links')
    .innerJoin('users', 'users.id', 'contact_links.chord_user_id')
    .select([
      'contact_links.contact_name as name',
      'contact_links.chord_user_id as chordUserId',
      'users.display_name as displayName',
      'users.username as username',
    ])
    .where('contact_links.owner_user_id', '=', senderUserId)
    .execute();

  const candidates: ResolvedContact[] = rows.map((r) => ({
    name: r.name,
    chordUserId: r.chordUserId,
    displayName: r.displayName ?? r.username,
  }));

  const exact = candidates.filter((c) => norm(c.name) === needle);
  const pool = exact.length > 0 ? exact : candidates.filter((c) => matchesLoosely(c.name, needle));
  return decide(pool);
}

/** First-name / prefix / whole-word match, e.g. "adrian" ⊂ "Adrian Gupta". */
function matchesLoosely(contactName: string, needle: string): boolean {
  const hay = norm(contactName);
  if (hay.startsWith(needle)) return true;
  return hay.split(' ').includes(needle);
}

function decide(pool: ResolvedContact[]): ContactResolution {
  if (pool.length === 0) return { kind: 'none' };
  const distinct = [...new Map(pool.map((c) => [c.chordUserId, c])).values()];
  if (distinct.length === 1) {
    const only = distinct[0]!;
    return {
      kind: 'match',
      chordUserId: only.chordUserId,
      displayName: only.displayName,
      contactName: only.name,
    };
  }
  return { kind: 'ambiguous', matches: distinct };
}
