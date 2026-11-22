/**
 * How a name becomes a person (or a Chord user), and how far the matching
 * goes. There are four separate resolvers with four separate rules, and none
 * of them had its rule pinned: the people book (exact, case-insensitive),
 * provisional people (email first, then name), the contact resolver (exact,
 * then first-name / prefix / whole-word, asks when two users fit), and the
 * email extractor's anchor (email, then name) that decides whether a person
 * seen in mail is new.
 *
 * Every limit below is real behaviour today: no nicknames, no accent folding,
 * no first-name-only match against the people book. They are pinned so a
 * change to any of them is a decision.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { resolveContacts, resolveContactToUser } from '@/services/contacts/contacts.service.js';
import {
  runPersonExtraction,
  type ExtractedPerson,
  type PersonExtractor,
} from '@/services/email/person-extraction.js';
import {
  createPerson,
  createProvisionalPerson,
  findPersonByEmail,
  findPersonByName,
  findProvisionalPerson,
} from '@/services/people.service.js';
import { hashPhone } from '@/services/phone/normalize.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let alice: string;

beforeEach(async () => {
  db = await openTestDb();
  alice = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('findPersonByName: the people book', () => {
  it('matches exactly, ignoring case and surrounding whitespace', async () => {
    const p = await createPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });

    expect((await findPersonByName(db, alice, 'Sara Chen'))?.id).toBe(p.id);
    expect((await findPersonByName(db, alice, 'sara chen'))?.id).toBe(p.id);
    expect((await findPersonByName(db, alice, '  SARA CHEN  '))?.id).toBe(p.id);
  });

  it('does not match a first name alone, a surname alone, or a longer name', async () => {
    await createPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });

    expect(await findPersonByName(db, alice, 'Sara')).toBeNull();
    expect(await findPersonByName(db, alice, 'Chen')).toBeNull();
    expect(await findPersonByName(db, alice, 'Sara Chen Jr')).toBeNull();
  });

  it('does not collapse inner whitespace', async () => {
    await createPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });
    expect(await findPersonByName(db, alice, 'Sara  Chen')).toBeNull();
  });

  it('does not fold accents or know nicknames', async () => {
    await createPerson(db, { ownerUserId: alice, displayName: 'José Núñez' });
    await createPerson(db, { ownerUserId: alice, displayName: 'Robert Wells' });

    expect(await findPersonByName(db, alice, 'Jose Nunez')).toBeNull();
    expect(await findPersonByName(db, alice, 'José Núñez')).not.toBeNull();
    expect(await findPersonByName(db, alice, 'Bob Ward')).toBeNull();
  });

  it('is scoped to the owner: another user never sees the row', async () => {
    const bob = await createUser(db, 'bob');
    await createPerson(db, { ownerUserId: bob, displayName: 'Sara Chen' });

    expect(await findPersonByName(db, alice, 'Sara Chen')).toBeNull();
    expect(await findPersonByName(db, bob, 'Sara Chen')).not.toBeNull();
  });

  it('with two people of the same name, silently returns one of them', async () => {
    // createPerson has no uniqueness check, and the lookup returns the first
    // row it finds. Pinned as the current contract: callers cannot tell that
    // the name was ambiguous.
    const first = await createPerson(db, { ownerUserId: alice, displayName: 'Sam Lee' });
    const second = await createPerson(db, { ownerUserId: alice, displayName: 'Sam Lee' });

    const hit = await findPersonByName(db, alice, 'Sam Lee');
    expect([first.id, second.id]).toContain(hit?.id);
  });

  it('finds nothing for an empty name', async () => {
    await createPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });
    expect(await findPersonByName(db, alice, '')).toBeNull();
    expect(await findPersonByName(db, alice, '   ')).toBeNull();
  });
});

describe('findPersonByEmail: the anchor a sender address gives', () => {
  it('matches case-insensitively and trims', async () => {
    const p = await createPerson(db, {
      ownerUserId: alice,
      displayName: 'Sara Chen',
      email: 'Sara@School.Example',
    });

    expect((await findPersonByEmail(db, alice, 'sara@school.example'))?.id).toBe(p.id);
    expect((await findPersonByEmail(db, alice, '  SARA@SCHOOL.EXAMPLE '))?.id).toBe(p.id);
  });

  it('is stored lowercased and trimmed', async () => {
    const p = await createPerson(db, {
      ownerUserId: alice,
      displayName: '  Sara Chen ',
      email: '  Sara@School.Example ',
    });
    expect(p.email).toBe('sara@school.example');
    expect(p.displayName).toBe('Sara Chen');
  });

  it('never matches a person who has no email, and an empty address matches nothing', async () => {
    await createPerson(db, { ownerUserId: alice, displayName: 'No Email' });

    expect(await findPersonByEmail(db, alice, '')).toBeNull();
    expect(await findPersonByEmail(db, alice, '   ')).toBeNull();
  });

  it('does not match on the domain or a fragment of the address', async () => {
    await createPerson(db, {
      ownerUserId: alice,
      displayName: 'Sara Chen',
      email: 'sara@school.example',
    });

    expect(await findPersonByEmail(db, alice, 'school.example')).toBeNull();
    expect(await findPersonByEmail(db, alice, 'sara')).toBeNull();
  });

  it('is scoped to the owner', async () => {
    const bob = await createUser(db, 'bob');
    await createPerson(db, { ownerUserId: bob, displayName: 'Sara', email: 'sara@school.example' });
    expect(await findPersonByEmail(db, alice, 'sara@school.example')).toBeNull();
  });
});

describe('findProvisionalPerson: email first, then name', () => {
  it('prefers the email match over a different person with the same name', async () => {
    const byEmail = await createProvisionalPerson(db, {
      ownerUserId: alice,
      displayName: 'Sara Chen (school)',
      email: 'sara@school.example',
    });
    await createProvisionalPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });

    const hit = await findProvisionalPerson(db, alice, {
      email: 'SARA@school.example',
      name: 'Sara Chen',
    });
    expect(hit?.id).toBe(byEmail.id);
  });

  it('falls back to an exact case-insensitive name when the email misses', async () => {
    const p = await createProvisionalPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });

    const hit = await findProvisionalPerson(db, alice, {
      email: 'someone.else@x.example',
      name: ' sara chen ',
    });
    expect(hit?.id).toBe(p.id);
  });

  it('does not match a first name', async () => {
    await createProvisionalPerson(db, { ownerUserId: alice, displayName: 'Sara Chen' });
    expect(await findProvisionalPerson(db, alice, { name: 'Sara' })).toBeNull();
  });

  it('is scoped to the owner', async () => {
    const bob = await createUser(db, 'bob');
    await createProvisionalPerson(db, { ownerUserId: bob, displayName: 'Sara Chen' });
    expect(await findProvisionalPerson(db, alice, { name: 'Sara Chen' })).toBeNull();
  });
});

describe('resolveContactToUser: a name to a Chord user, from your own contacts', () => {
  async function linked(name: string, username: string, phone: string): Promise<string> {
    const id = await createUser(db, username, name);
    await db
      .updateTable('users')
      .set({ phone_number: phone, phone_hash: hashPhone(phone), phone_verified: 1 })
      .where('id', '=', id)
      .execute();
    return id;
  }
  async function addressBook(...entries: Array<{ name: string; phone: string }>): Promise<void> {
    await resolveContacts(
      db,
      alice,
      entries.map((e) => ({ name: e.name, phoneHashes: [hashPhone(e.phone)] })),
    );
  }

  it('an exact name beats a looser match on another contact', async () => {
    const adri = await linked('Adri', 'adri', '+15553000001');
    await linked('Adrian Gupta', 'adrian', '+15553000002');
    await addressBook(
      { name: 'Adri', phone: '+15553000001' },
      { name: 'Adrian Gupta', phone: '+15553000002' },
    );

    // "Adri" is a prefix of "Adrian Gupta" too, but the exact contact wins
    // outright instead of turning into an ambiguity.
    const r = await resolveContactToUser(db, alice, 'Adri');
    expect(r).toMatchObject({ kind: 'match', chordUserId: adri });
  });

  it('matches a prefix of the contact name', async () => {
    const adrian = await linked('Adrian Gupta', 'adrian', '+15553000002');
    await addressBook({ name: 'Adrian Gupta', phone: '+15553000002' });

    expect(await resolveContactToUser(db, alice, 'Adri')).toMatchObject({
      kind: 'match',
      chordUserId: adrian,
    });
  });

  it('matches a whole word anywhere in the name, such as a surname', async () => {
    const adrian = await linked('Adrian Gupta', 'adrian', '+15553000002');
    await addressBook({ name: 'Adrian Gupta', phone: '+15553000002' });

    expect(await resolveContactToUser(db, alice, 'Gupta')).toMatchObject({
      kind: 'match',
      chordUserId: adrian,
    });
  });

  it('does not match the middle of a word', async () => {
    await linked('Adrian Gupta', 'adrian', '+15553000002');
    await addressBook({ name: 'Adrian Gupta', phone: '+15553000002' });

    expect(await resolveContactToUser(db, alice, 'hinav')).toEqual({ kind: 'none' });
    expect(await resolveContactToUser(db, alice, 'upta')).toEqual({ kind: 'none' });
  });

  it('ignores case and collapses inner whitespace in both the query and the contact', async () => {
    const adrian = await linked('Adrian Gupta', 'adrian', '+15553000002');
    await addressBook({ name: 'Adrian   Gupta', phone: '+15553000002' });

    expect(await resolveContactToUser(db, alice, '  adrian  GUPTA ')).toMatchObject({
      kind: 'match',
      chordUserId: adrian,
    });
  });

  it('two different people sharing a first name are ambiguous, not a guess', async () => {
    const s1 = await linked('Sam Lee', 'samlee', '+15553000003');
    const s2 = await linked('Sam Park', 'sampark', '+15553000004');
    await addressBook(
      { name: 'Sam Lee', phone: '+15553000003' },
      { name: 'Sam Park', phone: '+15553000004' },
    );

    const r = await resolveContactToUser(db, alice, 'Sam');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.matches.map((m) => m.chordUserId).sort()).toEqual([s1, s2].sort());
    }
    expect(await resolveContactToUser(db, alice, 'Sam Lee')).toMatchObject({
      kind: 'match',
      chordUserId: s1,
    });
  });

  it('a nickname does not resolve unless the contact is saved under it', async () => {
    await linked('Robert Wells', 'robert', '+15553000005');
    await addressBook({ name: 'Robert Wells', phone: '+15553000005' });

    expect(await resolveContactToUser(db, alice, 'Bob')).toEqual({ kind: 'none' });
  });

  it('never resolves to a Chord user who is not in your address book', async () => {
    await linked('Carol Jones', 'carol', '+15553000006');
    expect(await resolveContactToUser(db, alice, 'Carol')).toEqual({ kind: 'none' });
  });

  it('an empty name resolves to nothing', async () => {
    expect(await resolveContactToUser(db, alice, '   ')).toEqual({ kind: 'none' });
  });
});

describe('the email extractor anchors a person to who you already know', () => {
  async function seedThread(subject: string, fromEmail: string): Promise<void> {
    const now = new Date().toISOString();
    const threadId = newId('et');
    const gid = newId('gt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: alice,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: fromEmail,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: alice,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        from_email: fromEmail,
        to_emails: JSON.stringify(['me@example.com']),
        cc_emails: JSON.stringify([]),
        subject,
        snippet: subject,
        body_text: subject,
        internal_date: now,
        created_at: now,
      })
      .execute();
  }

  const extractor = (people: ExtractedPerson[]): PersonExtractor => ({
    extract: () => Promise.resolve(people),
  });

  async function pendingAddPerson(): Promise<number> {
    const rows = await db
      .selectFrom('proposals')
      .select('id')
      .where('proposed_by_user_id', '=', alice)
      .where('tool_name', '=', 'add_person')
      .where('status', '=', 'pending')
      .execute();
    return rows.length;
  }

  /** Someone already in the book (so this is not the bootstrap pass), then one
   *  thread mentioning `seen`, run through the extractor. */
  async function run(seen: Partial<ExtractedPerson> & { name: string }): Promise<number> {
    await createPerson(db, {
      ownerUserId: alice,
      displayName: 'Sara Chen',
      email: 'sara@school.example',
    });
    await seedThread('Picture day', 'office@school.example');
    await runPersonExtraction(db, alice, {
      extractor: extractor([{ relationship: 'friend', confidence: 0.9, ...seen }]),
    });
    return pendingAddPerson();
  }

  it('does not propose someone whose name matches exactly, whatever the case', async () => {
    expect(await run({ name: 'sara chen' })).toBe(0);
  });

  it('does not propose someone whose email matches, even under a different name', async () => {
    expect(await run({ name: 'Sarah C.', email: 'SARA@school.example' })).toBe(0);
  });

  it('does propose when the same person is named by first name only', async () => {
    // Pinned: "Sara" is not "Sara Chen" to the anchor, so mail that only says
    // "Sara" creates a suggestion. A rewrite that matches first names has to
    // handle the two-Saras case, which this rule sidesteps.
    expect(await run({ name: 'Sara' })).toBe(1);
  });

  it('does propose when the spelling differs by an accent or a nickname', async () => {
    expect(await run({ name: 'Sára Chen' })).toBe(1);
  });

  it('does propose a genuinely new person', async () => {
    expect(await run({ name: 'Coach Dan' })).toBe(1);
  });
});
