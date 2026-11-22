/**
 * ADR 0267 — the user's own email sorting rules and categories. The model is
 * faked and deliberately IGNORES the rules it is told, so what is pinned here
 * is that the rules still win: told to the model, then applied to its answer.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addSortRule,
  applySortRules,
  createUserCategory,
  listSortRules,
  removeSortRules,
  ruleMatches,
  type SortRule,
} from '@/services/email/sort-rules.service.js';
import { newId } from '@/utils/ids.js';
import { closeParallelHandle, closeTestDb, createUser, openParallelHandle, openTestDb } from '@/__test-helpers__/db.js';

const seen = vi.hoisted(() => ({ systems: [] as string[] }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'rules-mock',
    defaultModel: 'rules-mock',
    supportsNativeTools: false,
    // Puts everything in Newsletters, whatever the rules say.
    complete: async (messages: { role: string; content: string }[]) => {
      seen.systems.push(messages[0]!.content);
      const ids = (JSON.parse(messages[1]!.content) as { threads: { gmailThreadId: string }[] }).threads.map(
        (t) => t.gmailThreadId,
      );
      return JSON.stringify({
        assignments: ids.map((id) => ({
          gmailThreadId: id,
          path: ['Newsletters', 'Local'],
          confidence: 0.9,
          action: 'informational',
        })),
      });
    },
    async *stream() {},
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

const rule = (r: Partial<SortRule>): SortRule => ({
  category: 'Finance',
  rule: 'always',
  createdAt: '2026-10-18T00:00:00Z',
  ...r,
});

describe('matching', () => {
  it('a domain covers its subdomains and addresses, not look-alikes', () => {
    const r = { from: 'chase.com' };
    expect(ruleMatches(r, { fromEmail: 'alerts@chase.com', subject: '' })).toBe(true);
    expect(ruleMatches(r, { fromEmail: 'no-reply@mail.chase.com', subject: '' })).toBe(true);
    expect(ruleMatches(r, { fromEmail: 'x@notchase.com', subject: '' })).toBe(false);
  });

  it('a full address matches only that address; subject words ignore case', () => {
    expect(ruleMatches({ from: 'coach@club.org' }, { fromEmail: 'Coach@Club.org', subject: '' })).toBe(true);
    expect(ruleMatches({ from: 'coach@club.org' }, { fromEmail: 'admin@club.org', subject: '' })).toBe(false);
    expect(ruleMatches({ subject: 'invoice' }, { fromEmail: null, subject: 'Your INVOICE #42' })).toBe(true);
  });

  it('a rule with nothing to match matches nothing', () => {
    expect(ruleMatches({}, { fromEmail: 'a@b.com', subject: 'x' })).toBe(false);
  });
});

describe('applySortRules', () => {
  const resolve = (t: string) => (t === 'Credit card statements' ? ['Finance', 'Credit card statements'] : [t]);
  const chase = { fromEmail: 'alerts@chase.com', subject: 'Statement' };

  it('"always" sets the path, resolved into the existing tree', () => {
    expect(applySortRules(['Newsletters'], chase, [rule({ from: 'chase.com', category: 'Credit card statements' })], resolve)).toEqual([
      'Finance',
      'Credit card statements',
    ]);
  });

  it('"never" cuts the category and everything below it', () => {
    const never = rule({ from: 'chase.com', category: 'Credit card statements', rule: 'never' });
    expect(applySortRules(['Finance', 'Credit card statements'], chase, [never], resolve)).toEqual(['Finance']);
    const top = rule({ from: 'chase.com', category: 'Finance', rule: 'never' });
    expect(applySortRules(['Finance', 'Credit card statements'], chase, [top], resolve)).toBeNull();
  });

  it('rules for other mail change nothing', () => {
    expect(applySortRules(['Travel'], chase, [rule({ from: 'united.com' })], resolve)).toEqual(['Travel']);
  });
});

describe('with a database', () => {
  let db: Kysely<DB>;
  let userId: string;
  let prior: { classifier: string; batch: number };

  async function thread(gid: string, from: string, subject: string, categoryTitle: string | null = null) {
    const now = new Date().toISOString();
    let categoryId: string | null = null;
    if (categoryTitle) {
      categoryId = `${userId}:mk:${categoryTitle.toLowerCase().replace(/\W+/g, '-')}`;
      await db
        .insertInto('email_categories')
        .values({ id: categoryId, user_id: userId, parent_id: null, title: categoryTitle, updated_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    const threadRowId = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRowId,
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: from,
        last_message_at: now,
        classifier_version: 1,
        classified_at: now,
        category_id: categoryId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    // The classifier carries earlier categories forward from this table, as a
    // real earlier pass would have left them.
    if (categoryId) {
      await db
        .insertInto('email_message_categories')
        .values({ id: newId('emc'), user_id: userId, thread_id: threadRowId, category_id: categoryId, assigned_at: now, confidence: 0.9 })
        .execute();
    }
  }

  const pathOf = async (gid: string): Promise<string | null> => {
    const row = await db
      .selectFrom('email_threads')
      .leftJoin('email_categories', 'email_categories.id', 'email_threads.category_id')
      .select(['email_categories.title as title'])
      .where('email_threads.user_id', '=', userId)
      .where('email_threads.gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    return row.title ?? null;
  };

  beforeEach(async () => {
    seen.systems.length = 0;
    db = await openTestDb();
    userId = await createUser(db, 'sorter');
    prior = { classifier: env.EMAIL_CLASSIFIER, batch: env.EMAIL_CLASSIFIER_BATCH_SIZE };
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = 100;
    await thread('chase-1', 'alerts@chase.com', 'Your statement', 'Newsletters');
    await thread('pta-1', 'news@pta.example', 'PTA weekly', 'Newsletters');
    await thread('other-1', 'friend@example.com', 'Dinner?', 'Newsletters');
  });

  afterEach(async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = prior.classifier;
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = prior.batch;
    await closeTestDb(db);
  });

  it('an "always" rule re-sorts existing mail, even when the model ignores it', async () => {
    const out = await addSortRule(db, userId, { from: 'chase.com', category: 'Finance', rule: 'always' });
    expect(out).toMatchObject({ ok: true, requeued: 1, newCategory: true });

    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await runLlmClassifier(db, userId);

    expect(await pathOf('chase-1')).toBe('Finance');
    // Not re-queued, so not re-sorted: the rule touched only matching mail.
    expect(await pathOf('other-1')).toBe('Newsletters');
    expect(seen.systems[0]).toContain('Mail from chase.com always goes in "Finance".');
  });

  it('a "never" rule keeps matching mail out of a category the model put it in', async () => {
    expect(await addSortRule(db, userId, { from: 'pta.example', category: 'Newsletters', rule: 'never' })).toMatchObject({
      ok: true,
      requeued: 1,
    });
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await runLlmClassifier(db, userId);
    // The model said Newsletters › Local; the rule cuts Newsletters and below.
    expect(await pathOf('pta-1')).toBeNull();
    expect(seen.systems[0]).toContain('never goes in "Newsletters"');
  });

  it('refuses a "never" rule for a category that does not exist, and one with nothing to match', async () => {
    expect(await addSortRule(db, userId, { from: 'pta.example', category: 'Newsleters', rule: 'never' })).toMatchObject({
      ok: false,
      reason: 'not_found',
      candidates: [],
    });
    expect(await addSortRule(db, userId, { category: 'Finance', rule: 'always' })).toEqual({
      ok: false,
      reason: 'needs_match',
    });
    expect((await listSortRules(db, userId)).rules).toEqual([]);
  });

  it('a new category is told to the model with what belongs in it, and recent mail is re-sorted', async () => {
    const out = await createUserCategory(db, userId, { title: "Kids' sports", about: 'practice, games and team emails' });
    expect(out).toMatchObject({ ok: true, requeued: 3, existed: false });
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await runLlmClassifier(db, userId);
    expect(seen.systems[0]).toContain(`Category "Kids' sports" (top-level): practice, games and team emails.`);
  });

  it('removing a rule re-queues its mail so it is sorted the ordinary way again', async () => {
    await addSortRule(db, userId, { from: 'chase.com', category: 'Finance', rule: 'always' });
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await runLlmClassifier(db, userId);
    expect(await pathOf('chase-1')).toBe('Finance');

    expect(await removeSortRules(db, userId, { from: 'chase.com' })).toEqual({
      ok: true,
      removedRules: 1,
      removedCategory: false,
    });
    await runLlmClassifier(db, userId);
    expect(await pathOf('chase-1')).toBe('Local');
  });

  it('saying the same rule again replaces it rather than stacking a copy', async () => {
    await addSortRule(db, userId, { from: 'chase.com', category: 'Newsletters', rule: 'always' });
    await addSortRule(db, userId, { from: 'CHASE.com', category: 'newsletters', rule: 'never' });
    expect((await listSortRules(db, userId)).rules).toEqual([
      expect.objectContaining({ from: 'chase.com', category: 'Newsletters', rule: 'never' }),
    ]);
  });

  describe('chat tools', () => {
    let groupId: string;
    beforeEach(async () => {
      groupId = (await createGroup(db, { name: 'Me', kind: 'personal', createdBy: userId })).id;
    });
    const call = (name: string, args: Record<string, unknown>) =>
      applyToolCall(db, { groupId, actorUserId: userId, provenance: null, call: { name: name as 'list_email_sort_rules', args } });

    it('are personal-chat only', () => {
      for (const n of ['add_email_sort_rule', 'create_email_category', 'list_email_sort_rules', 'remove_email_sort_rule']) {
        expect(PERSONAL_ONLY_TOOL_NAMES.has(n as Parameters<typeof PERSONAL_ONLY_TOOL_NAMES.has>[0])).toBe(true);
      }
    });

    it('add, list and remove round-trip', async () => {
      const added = await call('add_email_sort_rule', { from: 'chase.com', category: 'Finance', rule: 'always' });
      expect(added.data).toMatchObject({ ok: true, rule: { from: 'chase.com', category: 'Finance' } });
      await call('create_email_category', { title: 'Home repairs', about: 'contractor emails' });
      const listed = await call('list_email_sort_rules', {});
      expect(listed.data).toMatchObject({
        ok: true,
        rules: [expect.objectContaining({ from: 'chase.com' })],
        categories: expect.arrayContaining([expect.objectContaining({ title: 'Home repairs' })]),
      });
      const removed = await call('remove_email_sort_rule', { category: 'Home repairs' });
      expect(removed.data).toEqual({ ok: true, removedRules: 0, removedCategory: true });
    });
  });
});

describe('sort rules under concurrent writes', () => {
  // Audit: addSortRule / createUserCategory read the list, changed it and
  // wrote it back with no lock, so two at once kept only one.
  let db: Kysely<DB>;
  let par: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    par = openParallelHandle(db);
    userId = await createUser(db, 'sorter');
  });
  afterEach(async () => {
    await closeParallelHandle(par);
    await closeTestDb(db);
  });

  it('rules and categories added at once all land', async () => {
    const from = Array.from({ length: 5 }, (_, i) => `teacher${i}@school.example`);
    await Promise.all(from.map((f) => addSortRule(par, userId, { from: f, category: `Class ${f}`, rule: 'always' })));
    const { rules, categories } = await listSortRules(db, userId);
    expect(rules.map((r) => r.from).sort()).toEqual([...from].sort());
    expect(categories).toHaveLength(5);
  });

  it('saying a rule again at the cap replaces it rather than refusing', async () => {
    await createUserCategory(db, userId, { title: 'Bulk' });
    for (let i = 0; i < 100; i++) {
      const r = await addSortRule(db, userId, { from: `s${i}@x.example`, category: 'Bulk', rule: 'always' });
      expect(r.ok).toBe(true);
    }
    const again = await addSortRule(db, userId, { from: 's0@x.example', category: 'Bulk', rule: 'always' });
    expect(again.ok).toBe(true);
    const more = await addSortRule(db, userId, { from: 'new@x.example', category: 'Bulk', rule: 'always' });
    expect(more).toEqual({ ok: false, reason: 'too_many' });
  });
});
