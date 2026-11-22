/**
 * docs/notes/0191 — a person the user has not confirmed yet is PROVISIONAL:
 * facts and the relationship edge attach to its id at once (so a one-shot
 * mined thread loses nothing), it is invisible to every `people` reader, and
 * the add_person card's tap promotes it. Shapes come from the ownertest prod
 * dry-runs: Robert Wells (teacher, subject/role facts), Kate Stone (vegan
 * meal, two threads), Julia Sutton (phone).
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  runPersonExtraction,
  sanitizeFacts,
  type ExtractedPerson,
  type PersonExtractor,
} from '@/services/email/person-extraction.js';
import { decayMemories } from '@/services/memory.service.js';
import {
  createPerson,
  findPersonByEmail,
  findPersonByName,
  getPersonProfile,
  listPeopleForUser,
  listPendingPersonSuggestions,
} from '@/services/people.service.js';
import {
  confirmProposal,
  expireStale,
  rejectProposal,
  retractByProvenance,
} from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('provisional people', () => {
  let db: Kysely<DB>;
  let userId: string;

  const seedThread = async (opts: { gid: string; subject: string; fromEmail: string; fromName?: string }) => {
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
        body_text: opts.subject,
        internal_date: now,
        created_at: now,
      })
      .execute();
    return threadId;
  };

  const stubExtractor = (bySubject: Record<string, ExtractedPerson[]>): PersonExtractor => ({
    extract: (input) => Promise.resolve(bySubject[input.subject] ?? []),
  });

  /** A pre-existing person ends the bootstrap pass, so new people become proposals. */
  const endBootstrap = () =>
    createPerson(db, { ownerUserId: userId, displayName: 'Existing Person' });

  const ROBERT: ExtractedPerson = {
    name: 'Robert Wells',
    relationship: 'teacher',
    email: 'rwells@lakesideschool.org',
    confidence: 0.9,
    facts: [
      { key: 'subject', value: 'Middle School Science' },
      { key: 'role', value: 'Science Olympiad Head Coach' },
    ],
  };

  const stageRobert = async () => {
    await endBootstrap();
    await seedThread({
      gid: 'pw1',
      subject: 'Science olympiad',
      fromEmail: 'rwells@lakesideschool.org',
      fromName: 'Rob Ward',
    });
    await runPersonExtraction(db, userId, { extractor: stubExtractor({ 'Science olympiad': [ROBERT] }) });
    const provisional = await db.selectFrom('provisional_people').selectAll().executeTakeFirstOrThrow();
    const proposal = await db
      .selectFrom('proposals')
      .selectAll()
      .where('tool_name', '=', 'add_person')
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return { provisional, proposal };
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'provisional-owner');
    return async () => closeTestDb(db);
  });

  it('attaches a new person\'s facts and relationship to a provisional id, and creates no people row', async () => {
    const { provisional, proposal } = await stageRobert();

    expect(provisional).toMatchObject({
      display_name: 'Robert Wells',
      email: 'rwells@lakesideschool.org',
      proposal_id: proposal.id,
    });
    expect(JSON.parse(proposal.args_json)).toMatchObject({ provisionalPersonId: provisional.id });

    const people = await db.selectFrom('people').select('display_name').execute();
    expect(people.map((p) => p.display_name)).toEqual(['Existing Person']);

    const facts = await db
      .selectFrom('memories')
      .select(['key', 'value', 'status', 'auto_confirm_at'])
      .where('subject_type', '=', 'person')
      .where('subject_id', '=', provisional.id)
      .orderBy('key')
      .execute();
    expect(facts).toEqual([
      { key: 'role', value: 'Science Olympiad Head Coach', status: 'proposed', auto_confirm_at: null },
      { key: 'subject', value: 'Middle School Science', status: 'proposed', auto_confirm_at: null },
    ]);

    const edges = await db.selectFrom('person_relationships').selectAll().execute();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ related_id: provisional.id, relation: 'teacher', status: 'proposed' });
  });

  it('tapping the card promotes the person under the same id and confirms what was attached', async () => {
    const { provisional, proposal } = await stageRobert();

    const card = (await listPendingPersonSuggestions(db, userId)).find((s) => s.proposalId === proposal.id);
    expect(card?.detail).toContain('role: Science Olympiad Head Coach');
    expect(card?.detail).toContain('subject: Middle School Science');

    const res = await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    const people = await listPeopleForUser(db, userId);
    const robert = people.find((p) => p.displayName === 'Robert Wells');
    expect(robert?.id).toBe(provisional.id);
    expect(robert?.email).toBe('rwells@lakesideschool.org');
    expect(await db.selectFrom('provisional_people').select('id').execute()).toEqual([]);

    const profile = await getPersonProfile(db, userId, provisional.id);
    expect(profile?.facts.map((f) => f.key).sort()).toEqual(['role', 'subject']);
    expect(profile?.relationships.map((r) => r.relation)).toEqual(['teacher']);
  });

  it('a second thread about the same pending person adds to it instead of being dropped', async () => {
    await endBootstrap();
    await seedThread({ gid: 'k1', subject: 'Air India eTicket - KATE', fromEmail: 'guest.four@gmail.com' });
    await runPersonExtraction(db, userId, {
      extractor: stubExtractor({
        'Air India eTicket - KATE': [
          {
            name: 'Kate Stone',
            relationship: 'other',
            confidence: 0.9,
            facts: [{ key: 'dietary_preference', value: 'vegan meal requested on flights' }],
          },
        ],
      }),
    });
    // A later thread, after the first was mined (each thread is mined once).
    await seedThread({ gid: 'k2', subject: 'Change in Itinerary', fromEmail: 'guest.four@gmail.com' });
    await runPersonExtraction(db, userId, {
      extractor: stubExtractor({
        'Change in Itinerary': [
          {
            name: 'Kate Stone',
            confidence: 0.9,
            facts: [
              { key: 'dietary_preference', value: 'vegan meal requested on flights' },
              { key: 'travels_with', value: 'Simon Stone' },
            ],
          },
        ],
      }),
    });

    expect(await db.selectFrom('provisional_people').select('id').execute()).toHaveLength(1);
    const pending = await db
      .selectFrom('proposals')
      .select('id')
      .where('tool_name', '=', 'add_person')
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(1);
    const facts = await db
      .selectFrom('memories')
      .select(['key', 'value'])
      .where('subject_type', '=', 'person')
      .orderBy('key')
      .execute();
    expect(facts).toEqual([
      { key: 'dietary_preference', value: 'vegan meal requested on flights' },
      { key: 'travels_with', value: 'Simon Stone' },
    ]);
  });

  describe('when the card never gets a tap', () => {
    const attachedRowCounts = async (provisionalId: string) => ({
      provisional: (await db.selectFrom('provisional_people').select('id').execute()).length,
      facts: (
        await db.selectFrom('memories').select('id').where('subject_id', '=', provisionalId).execute()
      ).length,
      edges: (
        await db.selectFrom('person_relationships').select('id').where('related_id', '=', provisionalId).execute()
      ).length,
    });

    it('reject removes the provisional person, its facts and its edge', async () => {
      const { provisional, proposal } = await stageRobert();
      await rejectProposal(db, { id: proposal.id, resolvedByUserId: userId });
      expect(await attachedRowCounts(provisional.id)).toEqual({ provisional: 0, facts: 0, edges: 0 });
    });

    it('expiry removes them', async () => {
      const { provisional, proposal } = await stageRobert();
      await db
        .updateTable('proposals')
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where('id', '=', proposal.id)
        .execute();
      await expireStale(db);
      expect(await attachedRowCounts(provisional.id)).toEqual({ provisional: 0, facts: 0, edges: 0 });
    });

    it('the source email being deleted removes them', async () => {
      const { provisional } = await stageRobert();
      await retractByProvenance(db, userId, ['gmail:pw1']);
      expect(await attachedRowCounts(provisional.id)).toEqual({ provisional: 0, facts: 0, edges: 0 });
    });
  });

  it('a real person that appears before the tap receives the facts instead of losing them', async () => {
    const { provisional, proposal } = await stageRobert();
    const real = await createPerson(db, { ownerUserId: userId, displayName: 'Robert Wells' });

    const res = await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    const robertRows = (await listPeopleForUser(db, userId)).filter((p) => p.displayName === 'Robert Wells');
    expect(robertRows).toHaveLength(1);
    expect(robertRows[0]!.id).toBe(real.id);
    const onReal = await db
      .selectFrom('memories')
      .select(['key', 'status'])
      .where('subject_type', '=', 'person')
      .where('subject_id', '=', real.id)
      .orderBy('key')
      .execute();
    expect(onReal).toEqual([
      { key: 'role', status: 'confirmed' },
      { key: 'subject', status: 'confirmed' },
    ]);
    expect(
      await db.selectFrom('memories').select('id').where('subject_id', '=', provisional.id).execute(),
    ).toEqual([]);
    const edge = await db.selectFrom('person_relationships').selectAll().executeTakeFirstOrThrow();
    expect(edge).toMatchObject({ related_id: real.id, status: 'confirmed' });
  });

  it('is invisible to every people reader until promoted', async () => {
    await stageRobert();
    expect(await findPersonByEmail(db, userId, 'rwells@lakesideschool.org')).toBeNull();
    expect(await findPersonByName(db, userId, 'Robert Wells')).toBeNull();
    expect((await listPeopleForUser(db, userId)).map((p) => p.displayName)).toEqual(['Existing Person']);
  });

  it('never auto-confirms, however confident the model was', async () => {
    await endBootstrap();
    await seedThread({ gid: 'j1', subject: 'John Doe and Julia Sutton', fromEmail: 'julia@daversa.com' });
    await runPersonExtraction(db, userId, {
      extractor: stubExtractor({
        'John Doe and Julia Sutton': [
          {
            name: 'Julia Sutton',
            relationship: 'other',
            email: 'julia@daversa.com',
            confidence: 0.95,
            facts: [{ key: 'phone', value: '860-555-0135' }],
          },
        ],
      }),
    });
    const fact = await db
      .selectFrom('memories')
      .select(['key', 'value', 'status', 'auto_confirm_at'])
      .where('subject_type', '=', 'person')
      .executeTakeFirstOrThrow();
    expect(fact).toEqual({ key: 'phone', value: '860-555-0135', status: 'proposed', auto_confirm_at: null });

    expect(await decayMemories(db)).toEqual([]);
  });
});

describe('sanitizeFacts', () => {
  it('normalizes keys, drops unusable ones, clips values, dedupes and caps', () => {
    const out = sanitizeFacts([
      { key: ' Home Phone ', value: '  860-555-0135 ' },
      { key: '!!!', value: 'dropped: no usable key' },
      { key: '9lives', value: 'dropped: key must start with a letter' },
      { key: 'role', value: '' },
      { key: 'notes', value: 'x'.repeat(500) },
      { key: 'home_phone', value: '860-555-0135' },
    ]);
    expect(out.map((f) => f.key)).toEqual(['home_phone', 'notes']);
    expect(out[1]!.value).toHaveLength(200);

    const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    expect(sanitizeFacts(many)).toHaveLength(8);
  });

  it('drops booking and account identifiers but keeps facts about the person (Kate Stone, Air India eTicket)', () => {
    const out = sanitizeFacts([
      { key: 'ticket_number', value: '098 2185021966' },
      { key: 'frequent_flyer_number', value: '312475570' },
      { key: 'special_service_request', value: 'VGML - VEGAN MEAL - CONFIRMED' },
      { key: 'Booking Reference', value: '7CTFHU' },
      { key: 'confirmation_code', value: 'KX8QP2' },
      { key: 'account_number', value: '00123456' },
      { key: 'allergy', value: 'peanuts' },
      { key: 'role', value: 'Science Olympiad Head Coach' },
      { key: 'organization', value: 'Lakeside School' },
    ]);
    expect(out.map((f) => f.key)).toEqual(['special_service_request', 'allergy', 'role', 'organization']);
  });
});
