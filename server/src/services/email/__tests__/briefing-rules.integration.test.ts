/**
 * ADR 0161 — per-user briefing-exclusion rules. Deterministic matching
 * (mirrors bulk-gate.ts's isMinable/routing-rules.ts's matchRoutingRule
 * test style) plus the resolveBriefingPattern decision tree and the
 * set_briefing_exclusion/list_briefing_exclusions bot tools.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  listBriefingRules,
  matchBriefingRule,
  resolveBriefingPattern,
  setBriefingRule,
  type BriefingRule,
} from '@/services/email/briefing-rules.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('briefing exclusion rules', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'briefing-user');
    personalGroupId = (await createGroup(db, { name: 'Me', kind: 'personal', createdBy: userId })).id;
    return async () => {
      await closeTestDb(db);
    };
  });

  describe('matchBriefingRule', () => {
    const cases: Array<{
      name: string;
      rules: BriefingRule[];
      thread: { fromEmail: string | null; categoryTitle: string | null; subject: string | null };
      want: boolean;
    }> = [
      {
        name: 'empty rule set never matches',
        rules: [],
        thread: { fromEmail: 'x@rippling.com', categoryTitle: null, subject: null },
        want: false,
      },
      {
        name: 'sender_domain matches the domain',
        rules: [{ id: '1', kind: 'sender_domain', pattern: 'rippling.com' }],
        thread: { fromEmail: 'notifications@rippling.com', categoryTitle: null, subject: null },
        want: true,
      },
      {
        name: 'sender_domain matches a subdomain',
        rules: [{ id: '1', kind: 'sender_domain', pattern: 'rippling.com' }],
        thread: { fromEmail: 'hr@mail.rippling.com', categoryTitle: null, subject: null },
        want: true,
      },
      {
        name: 'sender_domain does not match a look-alike domain',
        rules: [{ id: '1', kind: 'sender_domain', pattern: 'rippling.com' }],
        thread: { fromEmail: 'x@not-rippling.com', categoryTitle: null, subject: null },
        want: false,
      },
      {
        name: 'sender_email matches only the exact address',
        rules: [{ id: '1', kind: 'sender_email', pattern: 'notifications@rippling.com' }],
        thread: { fromEmail: 'other@rippling.com', categoryTitle: null, subject: null },
        want: false,
      },
      {
        name: 'category matches a substring, case-insensitively',
        rules: [{ id: '1', kind: 'category', pattern: 'social' }],
        thread: { fromEmail: null, categoryTitle: 'Social updates', subject: null },
        want: true,
      },
      {
        name: 'subject_keyword matches a substring of the subject',
        rules: [{ id: '1', kind: 'subject_keyword', pattern: 'birthday' }],
        thread: { fromEmail: null, categoryTitle: null, subject: 'Happy Birthday, Aris!' },
        want: true,
      },
      {
        name: 'no rule matches an unrelated thread',
        rules: [
          { id: '1', kind: 'sender_domain', pattern: 'rippling.com' },
          { id: '2', kind: 'subject_keyword', pattern: 'birthday' },
        ],
        thread: { fromEmail: 'mom@gmail.com', categoryTitle: 'Friends & family', subject: 'Dinner Friday?' },
        want: false,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        expect(matchBriefingRule(c.rules, c.thread)).toBe(c.want);
      });
    }
  });

  describe('resolveBriefingPattern', () => {
    it('an address resolves to sender_email', async () => {
      const r = await resolveBriefingPattern(db, userId, 'notifications@rippling.com');
      expect(r).toMatchObject({ ok: true, kind: 'sender_email', pattern: 'notifications@rippling.com' });
    });

    it('a dotted no-space pattern resolves to sender_domain', async () => {
      const r = await resolveBriefingPattern(db, userId, 'rippling.com');
      expect(r).toMatchObject({ ok: true, kind: 'sender_domain', pattern: 'rippling.com' });
    });

    it('a matching category title resolves to category', async () => {
      const now = new Date().toISOString();
      await db
        .insertInto('email_categories')
        .values({
          id: 'cat_social',
          user_id: userId,
          parent_id: null,
          title: 'Social & professional',
          depth: 0,
          sort_order: 0,
          updated_at: now,
        })
        .execute();
      const r = await resolveBriefingPattern(db, userId, 'social');
      expect(r).toMatchObject({ ok: true, kind: 'category', pattern: 'social' });
    });

    it('a sender name matching exactly one domain in the user\'s mail auto-resolves to sender_domain', async () => {
      const now = new Date().toISOString();
      await db
        .insertInto('email_threads')
        .values({
          id: newId('et'),
          user_id: userId,
          gmail_thread_id: 'g-rip-1',
          subject: 'Happy Birthday!',
          snippet: '',
          from_name: 'Rippling',
          from_email: 'notifications@rippling.com',
          last_message_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const r = await resolveBriefingPattern(db, userId, 'Rippling');
      expect(r).toMatchObject({ ok: true, kind: 'sender_domain', pattern: 'rippling.com' });
    });

    it('a sender name matching more than one domain returns candidates', async () => {
      const now = new Date().toISOString();
      for (const [gid, email] of [
        ['g-a', 'bill@acme-corp.com'],
        ['g-b', 'bill@acme-support.com'],
      ] as const) {
        await db
          .insertInto('email_threads')
          .values({
            id: newId('et'),
            user_id: userId,
            gmail_thread_id: gid,
            subject: 'Hi',
            snippet: '',
            from_name: 'Bill',
            from_email: email,
            last_message_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      const r = await resolveBriefingPattern(db, userId, 'Bill');
      expect(r.ok).toBe(false);
      expect((r as { candidates: string[] }).candidates.sort()).toEqual([
        'acme-corp.com',
        'acme-support.com',
      ]);
    });

    it('no domain/category/sender match falls back to subject_keyword', async () => {
      const r = await resolveBriefingPattern(db, userId, 'PTA fundraiser');
      expect(r).toMatchObject({ ok: true, kind: 'subject_keyword', pattern: 'pta fundraiser' });
    });
  });

  it('set_briefing_exclusion / list_briefing_exclusions tools: add, list, remove', async () => {
    const groupId = personalGroupId;

    const add = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: null,
      call: { name: 'set_briefing_exclusion', args: { pattern: 'rippling.com' } },
    });
    expect(add.data).toMatchObject({ ok: true, kind: 'sender_domain', pattern: 'rippling.com' });

    const rules = await listBriefingRules(db, userId);
    expect(rules).toMatchObject([{ kind: 'sender_domain', pattern: 'rippling.com' }]);

    const list = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: null,
      call: { name: 'list_briefing_exclusions', args: {} },
    });
    expect(list.data).toMatchObject({ rules: [{ kind: 'sender_domain', pattern: 'rippling.com' }] });

    const removed = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: null,
      call: { name: 'set_briefing_exclusion', args: { pattern: 'rippling.com', remove: true } },
    });
    expect(removed.data).toMatchObject({ ok: true });
    expect(await listBriefingRules(db, userId)).toHaveLength(0);
  });

  it('re-adding an existing rule is idempotent (no duplicate row, no error)', async () => {
    await setBriefingRule(db, { userId, kind: 'sender_domain', pattern: 'rippling.com' });
    await setBriefingRule(db, { userId, kind: 'sender_domain', pattern: 'rippling.com' });
    expect(await listBriefingRules(db, userId)).toHaveLength(1);
  });
});
