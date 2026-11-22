/**
 * ADR 0077 — user-declared email routing. Rules route deterministically
 * before the LLM matcher; the bot tool resolves group names exactly or
 * returns candidates for the ask-until-clear back-and-forth (never fuzzy).
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  inferRuleKind,
  listRoutingRules,
  matchRoutingRule,
  setRoutingRule,
} from '@/services/email/routing-rules.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('routing rules', () => {
  let db: Kysely<DB>;
  let userId: string;
  let familyGroupId: string;

  beforeEach(async () => {
    // Mock provider so the magics invite probe resolves (unknown message ids
    // → "not an invite") instead of deferring every thread on an OAuth error.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'router-user');
    familyGroupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: userId })).id;
    return async () => {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
      await closeTestDb(db);
    };
  });

  it('inferRuleKind: dotted no-space patterns are domains, else category keywords', () => {
    expect(inferRuleKind('lcps.org')).toBe('sender_domain');
    expect(inferRuleKind('school')).toBe('category');
    expect(inferRuleKind('school notes')).toBe('category');
  });

  it('matches sender domains (incl. subdomains) and category substrings; membership gates', async () => {
    await setRoutingRule(db, {
      userId,
      kind: 'sender_domain',
      pattern: 'lcps.org',
      targetGroupId: familyGroupId,
    });
    await setRoutingRule(db, {
      userId,
      kind: 'category',
      pattern: 'school',
      targetGroupId: familyGroupId,
    });

    expect(
      await matchRoutingRule(db, userId, { fromEmail: 'teacher@mail.lcps.org', categoryTitle: null }),
    ).toBe(familyGroupId);
    expect(
      await matchRoutingRule(db, userId, { fromEmail: 'x@other.com', categoryTitle: 'School notes' }),
    ).toBe(familyGroupId);
    expect(
      await matchRoutingRule(db, userId, { fromEmail: 'x@other.com', categoryTitle: 'Deliveries' }),
    ).toBeNull();

    // Leaving the group silently disables the rule (no scope leak).
    await db
      .deleteFrom('group_members')
      .where('group_id', '=', familyGroupId)
      .where('user_id', '=', userId)
      .execute();
    expect(
      await matchRoutingRule(db, userId, { fromEmail: 'teacher@lcps.org', categoryTitle: null }),
    ).toBeNull();
  });

  it('a rule routes the magics proposal deterministically — the LLM matcher never runs', async () => {
    await setRoutingRule(db, {
      userId,
      kind: 'category',
      pattern: 'school',
      targetGroupId: familyGroupId,
    });
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: 'cat_school',
        user_id: userId,
        parent_id: null,
        title: 'School notes',
        depth: 0,
        sort_order: 0,
        updated_at: now,
      })
      .execute();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: 'g-school-1',
        subject: 'Fall festival',
        snippet: 'Friday 5pm in the gym',
        from_email: 'pta@school.example',
        last_message_at: now,
        category_id: 'cat_school',
        classified_at: now,
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
        gmail_thread_id: 'g-school-1',
        from_email: 'pta@school.example',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        subject: 'Fall festival',
        snippet: 'Friday 5pm in the gym',
        body_text: 'Fall festival Friday 5pm in the gym',
        internal_date: now,
        created_at: now,
      })
      .execute();

    const extractor: EmailExtractor = {
      extract: () =>
        Promise.resolve({ kind: 'list', listName: 'School', item: 'Fall festival supplies' }),
    };
    const res = await runEmailMagics(db, userId, { extractor });
    expect(res.lists).toBe(1);
    expect(res.routed).toBe(1);

    const p = await db
      .selectFrom('proposals')
      .select('target_group_id')
      .where('proposed_by_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(p.target_group_id).toBe(familyGroupId);
  });

  it('set_email_route tool: exact name creates; inexact returns candidates, never a rule', async () => {
    await createGroup(db, { name: 'Doe Extended Family', kind: 'group', createdBy: userId });

    const vague = await applyToolCall(db, {
      groupId: familyGroupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: null,
      call: { name: 'set_email_route', args: { pattern: 'school', groupName: 'family' } },
    });
    expect(vague.data).toMatchObject({ ok: false, reason: 'not_found' });
    expect((vague.data as { candidates: string[] }).candidates).toEqual(
      expect.arrayContaining(['Doe Family', 'Doe Extended Family']),
    );
    expect(await listRoutingRules(db, userId)).toHaveLength(0);

    const exact = await applyToolCall(db, {
      groupId: familyGroupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: null,
      call: { name: 'set_email_route', args: { pattern: 'school', groupName: 'doe family' } },
    });
    expect(exact.data).toMatchObject({ ok: true, group: 'Doe Family', kind: 'category' });
    const rules = await listRoutingRules(db, userId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'school', targetGroupName: 'Doe Family' });

    const removed = await applyToolCall(db, {
      groupId: familyGroupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: null,
      call: {
        name: 'set_email_route',
        args: { pattern: 'school', groupName: 'Doe Family', remove: true },
      },
    });
    expect(removed.data).toMatchObject({ ok: true });
    expect(await listRoutingRules(db, userId)).toHaveLength(0);
  });
});
