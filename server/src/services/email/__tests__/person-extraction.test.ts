/**
 * ADR 0076 — people/family facts from email. Bootstrap auto-writes
 * high-confidence facts on the first pass (cold start); steady state stages
 * proposals through the existing consent surfaces; bulk/noreply senders are
 * skipped without an LLM call; confirming a staged add_person creates the
 * people row through the normal tool path. One thread is capped at
 * THREAD_PERSON_CAP people, a date already pending never stages twice, and a
 * sweep heals duplicates that predate those guards.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  addToNameList,
  parsePersonExtraction,
  runPersonExtraction,
  type ExtractedPerson,
  type PersonExtractor,
} from '@/services/email/person-extraction.js';
import { listImportantDayOccurrences, listPeopleForUser } from '@/services/people.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('parsePersonExtraction', () => {
  it('narrows well-formed persons and drops low-confidence + junk', () => {
    const raw = JSON.stringify({
      persons: [
        {
          name: 'Alice',
          relationship: 'Spouse',
          email: 'Alice@Example.com',
          confidence: 0.95,
          dates: [{ kind: 'birthday', date: '0000-05-12' }, { kind: 'nonsense', date: 'xx' }],
          facts: [{ key: 'hobby', value: 'tennis' }, { key: '', value: 'drop me' }],
        },
        { name: 'Low Conf', confidence: 0.3 },
        { notAName: true },
      ],
    });
    const out = parsePersonExtraction(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'Alice',
      relationship: 'spouse',
      email: 'alice@example.com',
      dates: [{ kind: 'birthday', date: '0000-05-12' }],
      facts: [{ key: 'hobby', value: 'tennis' }],
    });
  });

  it('returns [] for junk and empty results', () => {
    expect(parsePersonExtraction('not json')).toEqual([]);
    expect(parsePersonExtraction('{"persons":[]}')).toEqual([]);
  });
});

describe('runPersonExtraction', () => {
  let db: Kysely<DB>;
  let userId: string;

  const seedThread = async (opts: {
    gid: string;
    subject: string;
    fromEmail: string;
    fromName?: string;
    body?: string;
  }) => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: opts.gid,
        subject: opts.subject,
        snippet: opts.subject,
        from_name: opts.fromName ?? null,
        from_email: opts.fromEmail,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: opts.gid,
        from_name: opts.fromName ?? null,
        from_email: opts.fromEmail,
        to_emails: JSON.stringify(['me@example.com']),
        cc_emails: JSON.stringify([]),
        subject: opts.subject,
        snippet: opts.subject,
        body_text: opts.body ?? opts.subject,
        internal_date: now,
        created_at: now,
      })
      .execute();
    return threadId;
  };

  const stubExtractor = (bySubject: Record<string, ExtractedPerson[]>): PersonExtractor & {
    calls: string[];
  } => {
    const calls: string[] = [];
    return {
      calls,
      extract: (input) => {
        calls.push(input.subject);
        return Promise.resolve(bySubject[input.subject] ?? []);
      },
    };
  };

  /** A pre-existing person ends the bootstrap pass, so writes become proposals. */
  const endBootstrap = async () => {
    await db
      .insertInto('people')
      .values({
        id: newId('p'),
        owner_user_id: userId,
        display_name: 'Existing Person',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
  };

  const pendingCount = async (toolName: string): Promise<number> => {
    const rows = await db
      .selectFrom('proposals')
      .select('id')
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', toolName)
      .where('status', '=', 'pending')
      .execute();
    return rows.length;
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'person-learner');
    return async () => closeTestDb(db);
  });

  it('bootstrap: first pass auto-writes high-confidence people + dates + confirmed memories', async () => {
    await seedThread({
      gid: 'tp1',
      subject: 'Weekend plans',
      fromEmail: 'alice@example.com',
      fromName: 'Alice',
    });
    const extractor = stubExtractor({
      'Weekend plans': [
        {
          name: 'Alice',
          relationship: 'spouse',
          email: 'alice@example.com',
          confidence: 0.95,
          dates: [{ kind: 'birthday', date: '0000-05-12' }],
        },
        { name: 'Maybe Friend', relationship: 'friend', confidence: 0.65 },
      ],
    });

    const res = await runPersonExtraction(db, userId, { extractor });
    expect(res.bootstrapped).toBe(1);
    expect(res.personProposals).toBe(1); // the low-confidence friend proposes even during bootstrap

    const people = await listPeopleForUser(db, userId);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ displayName: 'Alice', email: 'alice@example.com' });
    expect(people[0].importantDates).toHaveLength(1);

    const memories = await db
      .selectFrom('memories')
      .select(['key', 'value', 'status'])
      .where('persona_id', '=', userId)
      .execute();
    expect(memories).toContainEqual({ key: 'spouse_name', value: 'Alice', status: 'confirmed' });
  });

  it("ADR 0333: a second child from another email is added to kid_name, never replaces the first", async () => {
    await seedThread({ gid: 'k1', subject: 'Ben field trip', fromEmail: 'school@example.org' });
    await seedThread({ gid: 'k2', subject: 'Nolan recital', fromEmail: 'music@example.org' });
    const extractor = stubExtractor({
      'Ben field trip': [{ name: 'Ben Doe', relationship: 'son', confidence: 0.95 }],
      'Nolan recital': [{ name: 'Nolan Doe', relationship: 'son', confidence: 0.95 }],
    });
    await runPersonExtraction(db, userId, { extractor });

    const live = await db
      .selectFrom('memories')
      .select(['value', 'status'])
      .where('key', '=', 'kid_name')
      .where('superseded_by', 'is', null)
      .execute();
    const confirmed = live.filter((m) => m.status === 'confirmed').map((m) => m.value);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].split(', ').sort()).toEqual(['Ben Doe', 'Nolan Doe']);
  });

  it('addToNameList keeps each name once and does not split a name containing "and"', () => {
    expect(addToNameList(null, 'Ben')).toBe('Ben');
    expect(addToNameList('Ben', 'nolan')).toBe('Ben, nolan');
    expect(addToNameList('Ben, Nolan', 'ben')).toBe('Ben, Nolan');
    expect(addToNameList('Brandon', 'Ben')).toBe('Brandon, Ben');
  });

  it('addToNameList treats a short name as the full one already listed, and keeps two different Bens', () => {
    expect(addToNameList('Ben Doe, Nolan Doe', 'Ben')).toBe('Ben Doe, Nolan Doe');
    expect(addToNameList('Ben, Nolan Doe', 'Ben Doe')).toBe('Ben Doe, Nolan Doe');
    expect(addToNameList('Ben Doe', 'Ben Rao')).toBe('Ben Doe, Ben Rao');
  });

  it('ADR 0333: three children from three emails are all kept, a short repeat adds nothing', async () => {
    await seedThread({ gid: 'c1', subject: 'Ben field trip', fromEmail: 'school@example.org' });
    await seedThread({ gid: 'c2', subject: 'Nolan recital', fromEmail: 'music@example.org' });
    await seedThread({ gid: 'c3', subject: 'Maya swim meet', fromEmail: 'swim@example.org' });
    await seedThread({ gid: 'c4', subject: 'Ben dentist', fromEmail: 'dentist@example.org' });
    const extractor = stubExtractor({
      'Ben field trip': [{ name: 'Ben Doe', relationship: 'son', confidence: 0.95 }],
      'Nolan recital': [{ name: 'Nolan Doe', relationship: 'son', confidence: 0.95 }],
      'Maya swim meet': [{ name: 'Maya Doe', relationship: 'daughter', confidence: 0.95 }],
      'Ben dentist': [{ name: 'Ben', relationship: 'son', confidence: 0.95 }],
    });
    await runPersonExtraction(db, userId, { extractor });

    const confirmed = await db
      .selectFrom('memories')
      .select('value')
      .where('key', '=', 'kid_name')
      .where('status', '=', 'confirmed')
      .where('superseded_by', 'is', null)
      .execute();
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].value.split(', ').sort()).toEqual(['Ben Doe', 'Maya Doe', 'Nolan Doe']);
  });

  it('steady state: existing people mean proposals, not writes; marker makes re-runs inert', async () => {
    // A pre-existing person ends bootstrap.
    await db
      .insertInto('people')
      .values({
        id: newId('p'),
        owner_user_id: userId,
        display_name: 'Existing Person',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await seedThread({ gid: 'tp2', subject: 'Soccer schedule', fromEmail: 'coach@club.org' });
    const extractor = stubExtractor({
      'Soccer schedule': [{ name: 'Coach Dan', relationship: 'coach', confidence: 0.9 }],
    });

    const first = await runPersonExtraction(db, userId, { extractor });
    expect(first.bootstrapped).toBe(0);
    expect(first.personProposals).toBe(1);
    expect(await listPeopleForUser(db, userId)).toHaveLength(1); // nothing auto-written

    const second = await runPersonExtraction(db, userId, { extractor });
    expect(second.processed).toBe(0); // person_processed_at marker
    expect(extractor.calls).toHaveLength(1);
  });

  it('skips bulk and noreply senders without calling the extractor', async () => {
    await seedThread({ gid: 'tp3', subject: 'Job alerts', fromEmail: 'jobs-noreply@linkedin.com' });
    await seedThread({ gid: 'tp4', subject: 'Order shipped', fromEmail: 'no-reply@shop.com' });
    const extractor = stubExtractor({});
    const res = await runPersonExtraction(db, userId, { extractor });
    expect(res.processed).toBe(2);
    expect(extractor.calls).toHaveLength(0);
  });

  it('confirming a staged add_person creates the people row for the confirming user', async () => {
    await db
      .insertInto('people')
      .values({
        id: newId('p'),
        owner_user_id: userId,
        display_name: 'Existing Person',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await seedThread({ gid: 'tp5', subject: 'Playdate?', fromEmail: 'sara@example.com' });
    const extractor = stubExtractor({
      'Playdate?': [
        {
          name: 'Sara',
          relationship: 'friend',
          email: 'sara@example.com',
          confidence: 0.9,
          dates: [{ kind: 'birthday', date: '0000-03-03' }],
        },
      ],
    });
    await runPersonExtraction(db, userId, { extractor });

    const proposals = await db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .execute();
    const personProp = proposals.find((p) => p.tool_name === 'add_person')!;
    const dateProp = proposals.find((p) => p.tool_name === 'add_important_date')!;
    expect(personProp.provenance).toBe('gmail:tp5');

    const c1 = await confirmProposal(db, { id: personProp.id, resolvedByUserId: userId });
    expect(c1.ok).toBe(true);
    const c2 = await confirmProposal(db, { id: dateProp.id, resolvedByUserId: userId });
    expect(c2.ok).toBe(true);

    const people = await listPeopleForUser(db, userId);
    const sara = people.find((p) => p.displayName === 'Sara');
    expect(sara).toBeDefined();
    expect(sara!.email).toBe('sara@example.com');
    expect(sara!.importantDates).toHaveLength(1);

    // The confirmed recurring birthday feeds the morning-scan window.
    const days = await listImportantDayOccurrences(db, userId, 366);
    expect(days.some((d) => d.personName === 'Sara' && d.kind === 'birthday')).toBe(true);
  });

  it('known people only accrue new dates (no duplicate person proposals)', async () => {
    await db
      .insertInto('people')
      .values({
        id: newId('p'),
        owner_user_id: userId,
        display_name: 'Alice',
        email: 'alice@example.com',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await seedThread({ gid: 'tp6', subject: 'Anniversary!', fromEmail: 'alice@example.com' });
    const extractor = stubExtractor({
      'Anniversary!': [
        {
          name: 'Alice',
          email: 'alice@example.com',
          confidence: 0.9,
          dates: [{ kind: 'anniversary', date: '0000-06-20' }],
        },
      ],
    });
    const res = await runPersonExtraction(db, userId, { extractor });
    expect(res.personProposals).toBe(0);
    expect(res.dateProposals).toBe(1);
  });

  it('caps one thread at THREAD_PERSON_CAP people', async () => {
    await endBootstrap();
    await seedThread({ gid: 'tp7', subject: 'Class list', fromEmail: 'office@school.org' });
    const extractor = stubExtractor({
      'Class list': Array.from({ length: 9 }, (_, i) => ({
        name: `Teacher ${i}`,
        confidence: 0.9,
      })),
    });
    const res = await runPersonExtraction(db, userId, { extractor });
    expect(res.personProposals).toBe(5);
  });

  it('a date already pending does not stage again from a second thread', async () => {
    await endBootstrap();
    const extractor = stubExtractor({
      'Party plans': [
        { name: 'Sara', confidence: 0.9, dates: [{ kind: 'birthday', date: '0000-06-03' }] },
      ],
      // Same person + birthday, and a YEAR this time: identity ignores it.
      'Re: Party plans': [
        { name: 'Sara', confidence: 0.9, dates: [{ kind: 'birthday', date: '1990-06-03' }] },
      ],
    });

    await seedThread({ gid: 'tp8', subject: 'Party plans', fromEmail: 'sara@example.com' });
    const first = await runPersonExtraction(db, userId, { extractor });
    expect(first).toMatchObject({ personProposals: 1, dateProposals: 1 });

    await seedThread({ gid: 'tp9', subject: 'Re: Party plans', fromEmail: 'sara@example.com' });
    const second = await runPersonExtraction(db, userId, { extractor });
    expect(second).toMatchObject({ personProposals: 0, dateProposals: 0 });

    expect(await pendingCount('add_person')).toBe(1);
    expect(await pendingCount('add_important_date')).toBe(1);
  });

  it("docs/notes/0189: a known person's attribute facts attach to THEM, not the asker", async () => {
    await db
      .insertInto('people')
      .values({
        id: newId('p'),
        owner_user_id: userId,
        display_name: 'Alice',
        email: 'alice@example.com',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    const person = await db
      .selectFrom('people')
      .select('id')
      .where('display_name', '=', 'Alice')
      .executeTakeFirstOrThrow();

    await seedThread({ gid: 'tp10', subject: 'Dinner idea', fromEmail: 'alice@example.com' });
    const extractor = stubExtractor({
      'Dinner idea': [
        {
          name: 'Alice',
          email: 'alice@example.com',
          confidence: 0.9,
          facts: [{ key: 'favorite_cuisine', value: 'sushi' }],
        },
      ],
    });
    await runPersonExtraction(db, userId, { extractor });

    const onAsker = await db
      .selectFrom('memories')
      .select(['key', 'value'])
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', userId)
      .where('key', '=', 'favorite_cuisine')
      .execute();
    expect(onAsker).toHaveLength(0);

    const onPerson = await db
      .selectFrom('memories')
      .select(['key', 'value', 'subject_type', 'subject_id'])
      .where('subject_type', '=', 'person')
      .where('subject_id', '=', person.id)
      .execute();
    expect(onPerson).toContainEqual(
      expect.objectContaining({ key: 'favorite_cuisine', value: 'sushi', subject_id: person.id }),
    );
  });

  it('docs/notes/0189: a stated relationship also writes a person_relationships edge, always proposed', async () => {
    await seedThread({ gid: 'tp11', subject: 'Hi', fromEmail: 'alice@example.com', fromName: 'Alice' });
    const extractor = stubExtractor({
      Hi: [{ name: 'Alice', relationship: 'spouse', email: 'alice@example.com', confidence: 0.95 }],
    });
    const res = await runPersonExtraction(db, userId, { extractor });
    expect(res.bootstrapped).toBeGreaterThan(0); // this is the first pass: person auto-created

    const edges = await db
      .selectFrom('person_relationships')
      .selectAll()
      .where('owner_user_id', '=', userId)
      .execute();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      subject_type: 'user',
      subject_id: userId,
      related_type: 'person',
      relation: 'spouse',
      // Never lighter-barred, even though the person itself was auto-written.
      status: 'proposed',
    });
  });

  it("docs/notes/0189: a linked attachment's extracted text reaches the extraction prompt", async () => {
    await endBootstrap();
    const personal = await ensurePersonalGroup(db, userId);
    const threadId = await seedThread({ gid: 'tp12', subject: 'School form', fromEmail: 'office@school.org' });
    await db
      .insertInto('attachments')
      .values({
        id: newId('att'),
        scope_kind: 'group',
        scope_id: personal.id,
        uploaded_by: userId,
        filename: 'form.pdf',
        mime_type: 'application/pdf',
        size: 100,
        path: '/tmp/form.pdf',
        summary: 'Permission slip for Ben, teacher Ms. Patel',
        extracted_text: null,
        image_meta: null,
        pinned: 0,
        indexed_at: new Date().toISOString(),
        origin_email_thread_id: threadId,
        created_at: new Date().toISOString(),
      })
      .execute();

    let seenAttachmentText: string | null | undefined;
    await runPersonExtraction(db, userId, {
      extractor: {
        extract: async (input) => {
          seenAttachmentText = input.attachmentText;
          return [];
        },
      },
    });
    expect(seenAttachmentText).toContain('Ms. Patel');
  });

  it('an unmapped relationship ("other") stages the person but no junk `other_name` fact', async () => {
    // Prod dry-run shape (ownertest, "John Doe and Julia Sutton"): the model
    // returns relationship "other" at 0.60 with a phone fact.
    await endBootstrap();
    await seedThread({
      gid: 'tp13',
      subject: 'John Doe and Julia Sutton',
      fromEmail: 'julia@daversa.com',
      fromName: 'Julia Sutton',
    });
    const extractor = stubExtractor({
      'John Doe and Julia Sutton': [
        {
          name: 'Julia Sutton',
          relationship: 'other',
          email: 'julia@daversa.com',
          confidence: 0.6,
          facts: [{ key: 'phone', value: '860-555-0135' }],
        },
      ],
    });
    const res = await runPersonExtraction(db, userId, { extractor });

    expect(res.personProposals).toBe(1);
    const junk = await db
      .selectFrom('memories')
      .select(['key', 'value'])
      .where('key', '=', 'other_name')
      .execute();
    expect(junk).toEqual([]);
    // The one memory is Julia's phone, attached to her provisional person
    // (docs/notes/0191) — not a fact about the user.
    expect(res.memoryProposals).toBe(1);
    const onAsker = await db
      .selectFrom('memories')
      .select('key')
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', userId)
      .execute();
    expect(onAsker).toEqual([]);
  });

  it('a known person with relationship "other" gets no edge; a teacher gets an edge but no memory', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    for (const name of ['Julia Sutton', 'Ms. Patel']) {
      await db
        .insertInto('people')
        .values({
          id: newId('p'),
          owner_user_id: userId,
          display_name: name,
          notes: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
    }
    await seedThread({ gid: 'tp14', subject: 'Intro', fromEmail: 'julia@daversa.com' });
    await seedThread({ gid: 'tp15', subject: 'Class news', fromEmail: 'office@school.org' });
    const extractor = stubExtractor({
      Intro: [{ name: 'Julia Sutton', relationship: 'other', confidence: 0.9 }],
      'Class news': [{ name: 'Ms. Patel', relationship: 'teacher', confidence: 0.9 }],
    });
    await runPersonExtraction(db, userId, { extractor });

    const edges = await db
      .selectFrom('person_relationships')
      .select(['relation'])
      .where('owner_user_id', '=', userId)
      .execute();
    expect(edges).toEqual([{ relation: 'teacher' }]);

    const memories = await db
      .selectFrom('memories')
      .select('key')
      .where('group_id', '=', personal.id)
      .where('subject_type', '=', 'user')
      .execute();
    expect(memories).toEqual([]); // teacher has no asker-side vocabulary key
  });

  it('sweeps duplicates that predate the staging guards', async () => {
    await endBootstrap();
    const personal = await ensurePersonalGroup(db, userId);
    for (const name of ['Coach Dan', 'coach  dan!']) {
      await createProposal(db, {
        groupId: personal.id,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'add_person',
        args: { displayName: name },
        provenance: 'gmail:legacy',
      });
    }
    for (const date of ['0000-06-03', '1990-06-03']) {
      await createProposal(db, {
        groupId: personal.id,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'add_important_date',
        args: { personName: 'Sara', kind: 'birthday', date, recurs: true },
        provenance: 'gmail:legacy',
      });
    }
    expect(await pendingCount('add_person')).toBe(2);
    expect(await pendingCount('add_important_date')).toBe(2);

    await runPersonExtraction(db, userId, { extractor: stubExtractor({}) });

    expect(await pendingCount('add_person')).toBe(1);
    expect(await pendingCount('add_important_date')).toBe(1);
  });
});
