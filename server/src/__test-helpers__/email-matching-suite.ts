/**
 * The email matching scenarios (search-email-matching), as a function of how
 * the mailbox was WRITTEN, so one set of expectations runs against plaintext
 * rows, blind-indexed rows and sealed rows. If the three ever disagree, the
 * index changed what search finds, which is exactly what it must not do.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

export interface MailOpts {
  subject: string;
  snippet?: string;
  fromName?: string | null;
  fromEmail?: string;
  body?: string | null;
  labels?: string[];
  at?: string;
  owner?: string;
}

export interface MatchingSuiteConfig {
  /** Create one thread with one message, however this mode writes mail. Returns the thread id. */
  seed(db: Kysely<DB>, owner: string, opts: MailOpts): Promise<string>;
  /** Runs before each test, after the database is open. */
  setup?(): void | Promise<void>;
}

export function defineEmailMatchingSuite(cfg: MatchingSuiteConfig): void {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    await cfg.setup?.();
    userId = await createUser(db, 'alice');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  async function mail(opts: MailOpts): Promise<string> {
    return cfg.seed(db, opts.owner ?? userId, opts);
  }

  interface Both {
    box: string[];
    bot: string[];
    boxHits: Awaited<ReturnType<typeof searchHits>>['hits'];
  }

  /** Thread ids each surface returned, in the order it returned them. */
  async function both(query: string, forUser = userId, forGroup = personalId): Promise<Both> {
    const box = await searchHits(db, {
      userId: forUser,
      groupId: forGroup,
      crossGroup: true,
      query,
      limit: 50,
    });
    const bot = await searchEverything(db, {
      userId: forUser,
      groupId: forGroup,
      crossGroup: true,
      query,
      perCategory: 25,
    });
    const boxHits = box.hits.filter((h) => h.entityType === 'email');
    return {
      box: boxHits.map((h) => h.entityId),
      bot: bot.emails.map((e) => e.id),
      boxHits,
    };
  }

  /** Same id set on both surfaces; returns it sorted. */
  async function agreed(query: string): Promise<string[]> {
    const r = await both(query);
    expect([...r.bot].sort()).toEqual([...r.box].sort());
    return [...r.box].sort();
  }

  describe('a sender is found without saying "from:"', () => {
    it('matches on the sender display name alone', async () => {
      const t = await mail({
        subject: 'Weekly update',
        snippet: 'Nothing to see here',
        fromName: 'Loudoun Schools',
        fromEmail: 'news@lcps.example',
      });
      await mail({ subject: 'Unrelated', fromName: 'Someone Else' });

      expect(await agreed('loudoun')).toEqual([t]);
    });

    it('matches on the sender address alone', async () => {
      const t = await mail({
        subject: 'Statement ready',
        snippet: 'Your statement is available',
        fromEmail: 'billing@brightwater.example',
      });
      await mail({ subject: 'Unrelated' });

      expect(await agreed('brightwater')).toEqual([t]);
    });

    it('matches a sender domain fragment that FTS cannot tokenize as a word', async () => {
      const t = await mail({ subject: 'Hello', fromEmail: 'office@lcps.example' });

      expect(await agreed('lcps.example')).toEqual([t]);
    });

    it('finds a thread when the sender name and a subject word are both typed', async () => {
      const t = await mail({
        subject: 'Pickup times change',
        fromName: 'Loudoun Schools',
      });

      expect(await agreed('loudoun pickup')).toEqual([t]);
    });

    it('treats a subject-only mention of a name as a match, where from: would not', async () => {
      const inSubject = await mail({ subject: 'Lunch with Loudoun', fromName: 'Sam' });
      const fromThem = await mail({ subject: 'Hello', fromName: 'Loudoun Schools' });

      expect(await agreed('loudoun')).toEqual([inSubject, fromThem].sort());

      const narrowed = await both('from:loudoun');
      expect(narrowed.box).toEqual([fromThem]);
      expect(narrowed.bot).toEqual([fromThem]);
    });

    it('shows the sender name as the hit title when the subject is empty', async () => {
      await mail({ subject: '', fromName: 'Ms Chen', snippet: 'permission slip' });

      const r = await both('chen');
      expect(r.boxHits.map((h) => h.title)).toEqual(['Ms Chen']);
    });

    it('shows the address when there is neither subject nor name', async () => {
      await mail({ subject: '', fromEmail: 'chen@school.example', snippet: 'permission slip' });

      const r = await both('permission');
      expect(r.boxHits.map((h) => h.title)).toEqual(['chen@school.example']);
    });
  });

  describe('keyword matching on email', () => {
    it('stems: "schools" finds "School pickup"', async () => {
      const t = await mail({ subject: 'School pickup' });
      expect(await agreed('schools')).toEqual([t]);
    });

    it('stems the other way: "cancel" finds "cancelled"', async () => {
      const t = await mail({ subject: 'Your booking was cancelled' });
      expect(await agreed('cancel')).toEqual([t]);
    });

    it('matches a prefix: "plumb" finds "plumber"', async () => {
      const t = await mail({ subject: 'The plumber is coming' });
      expect(await agreed('plumb')).toEqual([t]);
    });

    it('is case-insensitive, including in the sender', async () => {
      const t = await mail({ subject: 'Plumber visit', fromName: 'ACME Plumbing' });
      expect(await agreed('PLUMBER')).toEqual([t]);
      expect(await agreed('acme')).toEqual([t]);
      expect(await agreed('AcMe')).toEqual([t]);
    });

    it('ORs the words: one matching word is enough', async () => {
      const t = await mail({ subject: 'The plumber is coming' });
      expect(await agreed('plumber xyzzynonword')).toEqual([t]);
    });

    it('ignores stopwords: "what is the plumber" behaves like "plumber"', async () => {
      const t = await mail({ subject: 'The plumber is coming' });
      expect(await agreed('what is the plumber')).toEqual([t]);
    });

    it('returns nothing for a query that is only stopwords', async () => {
      await mail({ subject: 'What is the plan for the day' });
      expect(await agreed('what is the')).toEqual([]);
    });

    it('returns nothing for a word nobody wrote', async () => {
      await mail({ subject: 'The plumber is coming' });
      expect(await agreed('zzqqxxnotaword')).toEqual([]);
    });

    it('finds a word that appears only in the snippet', async () => {
      const t = await mail({ subject: 'Update', snippet: 'Bring the permission slip on Friday' });
      expect(await agreed('permission')).toEqual([t]);
    });

    it('finds a word that appears only in the body', async () => {
      const t = await mail({
        subject: 'Update',
        snippet: 'See details',
        body: 'Please bring the swimming kit on Thursday',
      });
      expect(await agreed('swimming')).toEqual([t]);
    });
  });

  describe('short queries and literal codes', () => {
    it('does not run a two-character query at all', async () => {
      await mail({ subject: 'ab test results' });
      expect(await agreed('ab')).toEqual([]);
    });

    it('finds a code inside a token through the literal arm: "512" finds "UA512"', async () => {
      const t = await mail({ subject: 'Booking UA512 confirmed' });
      expect(await agreed('512')).toEqual([t]);
    });

    it('finds a code in the sender address', async () => {
      const t = await mail({ subject: 'Hello', fromEmail: 'ua512@airline.example' });
      expect(await agreed('ua512')).toEqual([t]);
    });

    it('finds a confirmation code that only the body carries', async () => {
      const t = await mail({
        subject: 'Your itinerary',
        body: 'Confirmation code: KX8QP2. Show this at the desk.',
      });
      expect(await agreed('KX8QP2')).toEqual([t]);
      expect(await agreed('kx8qp2')).toEqual([t]);
    });
  });

  describe('characters that are special to LIKE', () => {
    // The literal arm builds a LIKE pattern from the query. `%` and `_` in what
    // someone typed must match themselves, not act as wildcards.
    it('"50%" finds "50% off" and not "5000 things"', async () => {
      const sale = await mail({ subject: 'Everything 50% off this weekend' });
      await mail({ subject: 'About 5000 things we did' });

      const r = await both('50%');
      expect(r.bot).toEqual([sale]);
      expect(r.box).toEqual([sale]);
    });

    it('"a_b" finds "a_b" and not "axb"', async () => {
      const literal = await mail({ subject: 'Ticket a_b confirmed' });
      await mail({ subject: 'Ticket axb confirmed' });

      const r = await both('a_b');
      expect(r.bot).toEqual([literal]);
      expect(r.box).toEqual([literal]);
    });

    it('a backslash in the query is matched literally and does not throw', async () => {
      const t = await mail({ subject: 'Path C:\\temp\\report ready' });

      const r = await both('C:\\temp');
      expect(r.bot).toEqual([t]);
      expect(r.box).toEqual([t]);
    });

    it('a lone percent sign does not match every thread', async () => {
      await mail({ subject: 'Plumber visit' });
      await mail({ subject: 'School pickup' });

      expect(await agreed('%%%')).toEqual([]);
    });
  });

  describe('accents and non-latin text', () => {
    // Pinned as-is. `extractKeywords` drops any non a-z0-9 character, so accents
    // are not folded and non-latin scripts have no FTS tokens. A rewrite should
    // decide these deliberately.
    it('finds an accented sender by the accented spelling', async () => {
      const t = await mail({ subject: 'Hello', fromName: 'José Núñez' });
      expect(await agreed('José')).toEqual([t]);
    });

    it('does not find an accented sender by the unaccented spelling', async () => {
      await mail({ subject: 'Hello', fromName: 'José Núñez' });
      expect(await agreed('jose')).toEqual([]);
    });

    it('finds non-latin text only through the literal arm', async () => {
      const t = await mail({ subject: '学校の連絡 明日' });
      expect(await agreed('学校の連絡')).toEqual([t]);
    });

    it('an apostrophe name matches its base spelling', async () => {
      const t = await mail({ subject: "Meeting with O'Brien" });
      expect(await agreed('brien')).toEqual([t]);
    });
  });

  describe('which threads are searchable', () => {
    it('finds archived and sent mail, and never trashed mail', async () => {
      const archived = await mail({ subject: 'Zebrafish archived note', labels: ['CATEGORY_UPDATES'] });
      const sent = await mail({ subject: 'Zebrafish sent note', labels: ['SENT'] });
      await mail({ subject: 'Zebrafish trashed note', labels: ['TRASH'] });

      expect(await agreed('zebrafish')).toEqual([archived, sent].sort());
    });

    it('finds spam-labelled mail (only TRASH is excluded)', async () => {
      const spam = await mail({ subject: 'Zebrafish spam note', labels: ['SPAM'] });
      expect(await agreed('zebrafish')).toEqual([spam]);
    });

    it("never returns another user's mail on either surface", async () => {
      const bob = await createUser(db, 'bob');
      await mail({ subject: 'Zebrafish for bob', owner: bob });
      const mine = await mail({ subject: 'Zebrafish for alice' });

      expect(await agreed('zebrafish')).toEqual([mine]);

      const bobsPersonal = (await ensurePersonalGroup(db, bob)).id;
      const asBob = await both('zebrafish', bob, bobsPersonal);
      expect(asBob.box).toHaveLength(1);
      expect(asBob.bot).toEqual(asBob.box);
      expect(asBob.box).not.toContain(mine);
    });

    it('does not search mail from a shared group chat', async () => {
      await mail({ subject: 'Zebrafish private note' });
      const shared = await db
        .insertInto('groups')
        .values({
          id: newId('g'),
          name: 'Family',
          kind: 'group',
          invite_code: 'FAMSRCH1',
          ingest_email: 'fam@chord.app',
          created_by: userId,
          adults_only: 0,
          mirror_inbound: 0,
          created_at: new Date().toISOString(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await addMember(db, shared.id, userId, 'owner');

      const box = await searchHits(db, {
        userId,
        groupId: shared.id,
        crossGroup: false,
        query: 'zebrafish',
      });
      const bot = await searchEverything(db, {
        userId,
        groupId: shared.id,
        crossGroup: false,
        query: 'zebrafish',
      });
      expect(box.hits.filter((h) => h.entityType === 'email')).toEqual([]);
      expect(bot.emails).toEqual([]);
    });
  });

  describe('ordering and limits', () => {
    it('the box puts the stronger match first', async () => {
      const weak = await mail({ subject: 'Zebrafish', at: '2026-09-01T10:00:00.000Z' });
      const strong = await mail({
        subject: 'Zebrafish zebrafish zebrafish',
        snippet: 'zebrafish care',
        at: '2026-08-01T10:00:00.000Z',
      });

      const r = await both('zebrafish');
      expect(r.box).toEqual([strong, weak]);
    });

    it('equal matches are newest first, on both surfaces', async () => {
      const older = await mail({ subject: 'Zebrafish note', at: '2026-08-01T10:00:00.000Z' });
      const newer = await mail({ subject: 'Zebrafish note', at: '2026-09-01T10:00:00.000Z' });

      const r = await both('zebrafish');
      expect(r.box).toEqual([newer, older]);
      expect(r.bot).toEqual([newer, older]);
    });

    it('the bot path caps results per category', async () => {
      for (let i = 0; i < 12; i++) {
        await mail({ subject: `Zebrafish note ${i}`, at: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString() });
      }
      const bot = await searchEverything(db, {
        userId,
        groupId: personalId,
        crossGroup: true,
        query: 'zebrafish',
        perCategory: 5,
      });
      expect(bot.emails).toHaveLength(5);
    });

    it('a body-only match is not buried under subject matches', async () => {
      const bodyOnly = await mail({
        subject: 'Update',
        body: 'zebrafish zebrafish zebrafish zebrafish',
        at: '2026-09-02T10:00:00.000Z',
      });
      const subjectOnly = await mail({ subject: 'Zebrafish', at: '2026-09-01T10:00:00.000Z' });

      const r = await both('zebrafish');
      expect(new Set(r.box)).toEqual(new Set([bodyOnly, subjectOnly]));
    });
  });

  describe('empty and degenerate queries', () => {
    it('an empty or blank query returns nothing', async () => {
      await mail({ subject: 'Anything at all' });
      expect(await agreed('')).toEqual([]);
      expect(await agreed('   ')).toEqual([]);
    });

    it('a query of only punctuation returns nothing rather than everything', async () => {
      await mail({ subject: 'Anything at all' });
      expect(await agreed('!!!')).toEqual([]);
      expect(await agreed('???')).toEqual([]);
    });

    it('tsquery syntax typed by a user is inert', async () => {
      const t = await mail({ subject: 'Zebrafish note' });
      expect(await agreed("zebrafish & !(x) | 'y'")).toEqual([t]);
      expect(await agreed(':*')).toEqual([]);
    });
  });

}
