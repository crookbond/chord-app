/**
 * ADR 0065 — deterministic contact resolution + the sender-scoped name resolver.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  listContactLinks,
  resolveContactToUser,
  resolveContacts,
} from '@/services/contacts/contacts.service.js';
import { hashPhone } from '@/services/phone/normalize.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function setVerifiedPhone(db: Kysely<DB>, userId: string, e164: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ phone_number: e164, phone_hash: hashPhone(e164), phone_verified: 1 })
    .where('id', '=', userId)
    .execute();
}

/** A user with a hash but NOT verified — must not resolve. */
async function setUnverifiedPhone(db: Kysely<DB>, userId: string, e164: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ phone_number: e164, phone_hash: hashPhone(e164), phone_verified: 0 })
    .where('id', '=', userId)
    .execute();
}

describe('resolveContacts', () => {
  let db: Kysely<DB>;
  let alice: string;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('resolves only verified Chord users and persists those links', async () => {
    const bob = await createUser(db, 'bob', 'Bob Smith');
    const carol = await createUser(db, 'carol', 'Carol Jones');
    await setVerifiedPhone(db, bob, '+15552001111');
    await setVerifiedPhone(db, carol, '+15552002222');

    const resolved = await resolveContacts(db, alice, [
      { name: 'Bob Smith', phoneHashes: [hashPhone('+15552001111')] },
      { name: 'Carol', phoneHashes: [hashPhone('+15552002222')] },
      { name: 'Stranger', phoneHashes: [hashPhone('+15559998888')] },
    ]);

    expect(resolved.map((r) => r.chordUserId).sort()).toEqual([bob, carol].sort());
    expect(resolved.find((r) => r.chordUserId === bob)?.displayName).toBe('Bob Smith');

    // Only the two matches were persisted; the stranger was dropped.
    const links = await listContactLinks(db, alice);
    expect(links).toHaveLength(2);
  });

  it('does not resolve an unverified user or the caller themselves', async () => {
    const frank = await createUser(db, 'frank');
    await setUnverifiedPhone(db, frank, '+15552003333');
    await setVerifiedPhone(db, alice, '+15552000000'); // alice's own number

    const resolved = await resolveContacts(db, alice, [
      { name: 'Frank', phoneHashes: [hashPhone('+15552003333')] },
      { name: 'Me', phoneHashes: [hashPhone('+15552000000')] },
    ]);
    expect(resolved).toEqual([]);
  });

  it('upserts on re-upload — no duplicate links', async () => {
    const bob = await createUser(db, 'bob', 'Bob Smith');
    await setVerifiedPhone(db, bob, '+15552001111');
    const contacts = [{ name: 'Bob', phoneHashes: [hashPhone('+15552001111')] }];
    await resolveContacts(db, alice, contacts);
    await resolveContacts(db, alice, [{ name: 'Bobby', phoneHashes: [hashPhone('+15552001111')] }]);
    const links = await listContactLinks(db, alice);
    expect(links).toHaveLength(1);
    expect(links[0].name).toBe('Bobby'); // latest name wins
  });
});

describe('resolveContactToUser', () => {
  let db: Kysely<DB>;
  let alice: string;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('matches exactly and by first name, scoped to the caller', async () => {
    const bob = await createUser(db, 'bob', 'Bob Smith');
    await setVerifiedPhone(db, bob, '+15552001111');
    await resolveContacts(db, alice, [
      { name: 'Bob Smith', phoneHashes: [hashPhone('+15552001111')] },
    ]);

    const byFull = await resolveContactToUser(db, alice, 'Bob Smith');
    expect(byFull).toMatchObject({ kind: 'match', chordUserId: bob });
    const byFirst = await resolveContactToUser(db, alice, 'bob');
    expect(byFirst).toMatchObject({ kind: 'match', chordUserId: bob });
  });

  it('returns ambiguous when one name maps to two users', async () => {
    const dan = await createUser(db, 'dan');
    const evan = await createUser(db, 'evan');
    await setVerifiedPhone(db, dan, '+15552004444');
    await setVerifiedPhone(db, evan, '+15552005555');
    await resolveContacts(db, alice, [
      { name: 'Sam', phoneHashes: [hashPhone('+15552004444')] },
      { name: 'Sam', phoneHashes: [hashPhone('+15552005555')] },
    ]);

    const r = await resolveContactToUser(db, alice, 'Sam');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.matches.map((m) => m.chordUserId).sort()).toEqual([dan, evan].sort());
    }
  });

  it('never leaks another user\'s contacts', async () => {
    const bob = await createUser(db, 'bob', 'Bob Smith');
    const carol = await createUser(db, 'carol', 'Carol Jones');
    await setVerifiedPhone(db, bob, '+15552001111');
    await setVerifiedPhone(db, carol, '+15552002222');
    // Only bob has Carol in his address book.
    await resolveContacts(db, bob, [
      { name: 'Carol', phoneHashes: [hashPhone('+15552002222')] },
    ]);

    expect((await resolveContactToUser(db, bob, 'Carol')).kind).toBe('match');
    // Alice has no contacts at all → Carol resolves to nothing for her.
    expect(await resolveContactToUser(db, alice, 'Carol')).toEqual({ kind: 'none' });
  });

  it('returns none for an unknown name', async () => {
    expect(await resolveContactToUser(db, alice, 'Nobody')).toEqual({ kind: 'none' });
  });
});
