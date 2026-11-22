/**
 * PR-D.1 — bot tool flows (mocked LLM) and a 100-user / multi-group
 * stress scenario. Logs verbosely so a failed run surfaces enough
 * context to debug from the captured output.
 *
 * Mocks the factory the same way every other bot integration test does:
 * a single shared LLM stub with a `mockState.response` driven by each
 * test. `getLlmForUser` resolves to the same stub so the BYOK path is
 * exercised without needing a real provider.
 *
 * Real BYOK fallback semantics (sealed key, decrypt path) live in
 * server/src/services/llm/__tests__/factory-byok.test.ts.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup, isMember, joinGroupByCode } from '@/services/groups.service.js';
import {
  addMember,
  closeTestDb,
  createUser,
  fence,
  insertMessage,
  openTestDb,
} from '@/__test-helpers__/db.js';

// ── shared LLM stub ──────────────────────────────────────────────────

const mockState = vi.hoisted(() => ({ response: '' }));
const llmCallCounter = vi.hoisted(() => ({ getLlm: 0, getLlmForUser: 0 }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'pr-d1-mock',
    defaultModel: 'pr-d1-mock',
    supportsNativeTools: false,
    complete: async () => '[]',
    async *stream() {
      yield { type: 'text', delta: mockState.response };
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => {
      llmCallCounter.getLlm += 1;
      return llm;
    },
    getLlmForUser: async () => {
      llmCallCounter.getLlmForUser += 1;
      return llm;
    },
    resolveTurnLlm: async () => {
      llmCallCounter.getLlmForUser += 1;
      return { llm, tier: 'premium' as const };
    },
  };
});

// ── helpers ──────────────────────────────────────────────────────────

const postMessage = insertMessage;

/** `create_event` refuses a start that has already passed, so event fixtures
 *  have to be relative — a hardcoded date silently stops writing once it rots
 *  past today. */
const soon = (days = 14): string =>
  `${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}T19:00:00Z`;

async function botMessages(db: Kysely<DB>, groupId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('messages')
    .select(['body', 'created_at'])
    .where('group_id', '=', groupId)
    .where('kind', '=', 'bot')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((r) => r.body);
}

function log(label: string, payload: Record<string, unknown>): void {
  console.log(`[pr-d1] ${label}`, JSON.stringify(payload));
}

// ── fixtures ─────────────────────────────────────────────────────────

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
  llmCallCounter.getLlm = 0;
  llmCallCounter.getLlmForUser = 0;
});

afterEach(async () => {
  await closeTestDb(db);
});

// ── 1. bot tool-fence flows ──────────────────────────────────────────

describe('bot @chord tool flows (mocked LLM)', () => {
  it('create_task — adds a row to tasks', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });

    mockState.response = fence({
      name: 'create_task',
      args: { title: 'Renew passport', dueAt: '2026-06-01T17:00:00Z' },
    });

    const trigger = await postMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord remind me to renew my passport by June 1',
    });
    await runBotTurn(db, trigger, { id: group.id, kind: 'group' });

    const tasks = await db.selectFrom('tasks').selectAll().where('group_id', '=', group.id).execute();
    const replies = await botMessages(db, group.id);
    log('create_task', {
      tasksCount: tasks.length,
      title: tasks[0]?.title,
      reply: replies.at(-1),
      llmForUserCalls: llmCallCounter.getLlmForUser,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Renew passport');
    expect(llmCallCounter.getLlmForUser).toBeGreaterThan(0);
  });

  it('add_list_item — auto-creates list and inserts items', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Costco crew', kind: 'group', createdBy: uid });

    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Costco', items: ['milk', 'bread', 'eggs'] },
    });

    const trigger = await postMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord add to costco list - milk, bread, eggs',
    });
    await runBotTurn(db, trigger, { id: group.id, kind: 'group' });

    const lists = await db.selectFrom('lists').selectAll().where('group_id', '=', group.id).execute();
    const items = lists[0]
      ? await db.selectFrom('list_items').selectAll().where('list_id', '=', lists[0].id).execute()
      : [];
    log('add_list_item', {
      listsCount: lists.length,
      listName: lists[0]?.name,
      items: items.map((i) => i.text),
    });
    expect(lists).toHaveLength(1);
    expect(lists[0]?.name).toBe('Costco');
    expect(items.map((i) => i.text).sort()).toEqual(['bread', 'eggs', 'milk']);
  });

  it('create_event — inserts row into events', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });

    mockState.response = fence({
      name: 'create_event',
      args: {
        title: 'Spring potluck',
        startsAt: soon(),
        location: 'Backyard',
      },
    });

    const trigger = await postMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord schedule spring potluck May 20 6pm at the backyard',
    });
    await runBotTurn(db, trigger, { id: group.id, kind: 'group' });

    const events = await db.selectFrom('events').selectAll().where('group_id', '=', group.id).execute();
    log('create_event', {
      eventsCount: events.length,
      title: events[0]?.title,
      location: events[0]?.location,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('Spring potluck');
    expect(events[0]?.location).toBe('Backyard');
  });

  it('save_link — inserts row into saves', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Bookmarks', kind: 'group', createdBy: uid });

    mockState.response = fence({
      name: 'save_link',
      args: {
        title: 'Best ramen in Seattle',
        url: 'https://example.com/ramen',
        tags: ['food', 'seattle'],
      },
    });

    const trigger = await postMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord save https://example.com/ramen',
    });
    await runBotTurn(db, trigger, { id: group.id, kind: 'group' });

    const saves = await db.selectFrom('saves').selectAll().where('group_id', '=', group.id).execute();
    log('save_link', {
      savesCount: saves.length,
      title: saves[0]?.title,
      url: saves[0]?.url,
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.url).toBe('https://example.com/ramen');
  });

  it('multi-tool turn — task + list + event in one fence batch', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });

    mockState.response = fence(
      { name: 'create_task', args: { title: 'Pack snacks' } },
      { name: 'add_list_item', args: { listName: 'Grocery', items: ['oranges'] } },
      { name: 'create_event', args: { title: 'Picnic', startsAt: soon() } },
    );

    const trigger = await postMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord plan saturday picnic',
    });
    await runBotTurn(db, trigger, { id: group.id, kind: 'group' });

    const tasks = await db.selectFrom('tasks').selectAll().where('group_id', '=', group.id).execute();
    const lists = await db.selectFrom('lists').selectAll().where('group_id', '=', group.id).execute();
    const events = await db.selectFrom('events').selectAll().where('group_id', '=', group.id).execute();
    log('multi-tool-turn', {
      tasks: tasks.length,
      lists: lists.length,
      events: events.length,
    });
    expect(tasks).toHaveLength(1);
    expect(lists).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

// ── 2. group join / leave ────────────────────────────────────────────

describe('group lifecycle — join / leave', () => {
  it('user can join via invite code and then be removed', async () => {
    const owner = await createUser(db, 'owner');
    const guest = await createUser(db, 'guest');
    const group = await createGroup(db, { name: 'Open', kind: 'group', createdBy: owner });

    expect(await isMember(db, group.id, guest)).toBe(false);
    const joined = await joinGroupByCode(db, guest, group.invite_code);
    expect(joined?.id).toBe(group.id);
    expect(await isMember(db, group.id, guest)).toBe(true);

    await db
      .deleteFrom('group_members')
      .where('group_id', '=', group.id)
      .where('user_id', '=', guest)
      .execute();
    expect(await isMember(db, group.id, guest)).toBe(false);

    log('join-leave', { ownerId: owner, guestId: guest, groupId: group.id });
  });

  it('rejoining via the same invite code is idempotent', async () => {
    const owner = await createUser(db, 'owner');
    const guest = await createUser(db, 'guest');
    const group = await createGroup(db, { name: 'Idempotent', kind: 'group', createdBy: owner });

    await joinGroupByCode(db, guest, group.invite_code);
    await joinGroupByCode(db, guest, group.invite_code);

    const rows = await db
      .selectFrom('group_members')
      .select(['user_id'])
      .where('group_id', '=', group.id)
      .execute();
    log('rejoin-idempotent', { memberCount: rows.length });
    expect(rows.filter((r) => r.user_id === guest)).toHaveLength(1);
  });
});

// ── 3. 100-user / multi-group stress ─────────────────────────────────

describe('stress — 100 users, multiple groups, cross-messaging', () => {
  it('creates 100 users, distributes them across 8 groups, runs cross-messages and a sample of bot turns', async () => {
    const startedAt = Date.now();

    // 1. 100 users.
    const userIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      userIds.push(await createUser(db, `u${i.toString().padStart(3, '0')}`));
    }
    log('users-created', { count: userIds.length });

    // 2. 8 groups owned by the first 8 users.
    const groupIds: string[] = [];
    for (let g = 0; g < 8; g++) {
      const group = await createGroup(db, {
        name: `Group ${g}`,
        kind: 'group',
        createdBy: userIds[g]!,
      });
      groupIds.push(group.id);
    }
    log('groups-created', { count: groupIds.length });

    // 3. Distribute users — each user joins 2 groups (round-robin).
    const failures: Array<{ scenario: string; userId: string; err: string }> = [];
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i]!;
      const a = groupIds[i % groupIds.length]!;
      const b = groupIds[(i + 3) % groupIds.length]!;
      for (const gid of [a, b]) {
        if (await isMember(db, gid, uid)) continue;
        try {
          await addMember(db, gid, uid);
        } catch (err) {
          failures.push({ scenario: 'add_member', userId: uid, err: (err as Error).message });
        }
      }
    }

    const memberCounts = await Promise.all(
      groupIds.map(async (gid) =>
        db
          .selectFrom('group_members')
          .select(({ fn }) => fn.count<number>('user_id').as('n'))
          .where('group_id', '=', gid)
          .executeTakeFirstOrThrow(),
      ),
    );
    log('membership-distribution', {
      perGroup: memberCounts.map((r) => Number(r.n)),
      failures: failures.length,
    });

    // 4. Cross-group chatter — each user posts one message in each of their
    // groups. This is the in-group "to each other" surface, since the
    // product has no DM channel; group messages are the comms layer.
    let messagesPosted = 0;
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i]!;
      const myGroups = await db
        .selectFrom('group_members')
        .select(['group_id'])
        .where('user_id', '=', uid)
        .execute();
      for (const { group_id } of myGroups) {
        try {
          await postMessage(db, {
            groupId: group_id,
            senderId: uid,
            body: `hello from u${i} in ${group_id.slice(0, 6)}`,
          });
          messagesPosted += 1;
        } catch (err) {
          failures.push({ scenario: 'post_message', userId: uid, err: (err as Error).message });
        }
      }
    }
    log('messages-posted', { messagesPosted, failures: failures.length });

    // 5. Pick 5 users in 5 different groups to @-mention the bot. Drives
    // runBotTurn and exercises getLlmForUser per turn. Mix of tools.
    const tasks = [
      {
        body: '@Chord remind me to call vet tomorrow',
        response: fence({ name: 'create_task', args: { title: 'Call vet' } }),
        check: async (gid: string) =>
          (await db.selectFrom('tasks').select('id').where('group_id', '=', gid).execute()).length,
      },
      {
        body: '@Chord add milk to grocery list',
        response: fence({ name: 'add_list_item', args: { listName: 'Grocery', items: ['milk'] } }),
        check: async (gid: string) =>
          (await db.selectFrom('lists').select('id').where('group_id', '=', gid).execute()).length,
      },
      {
        body: '@Chord schedule tea time saturday 4pm',
        response: fence({
          name: 'create_event',
          args: { title: 'Tea time', startsAt: soon() },
        }),
        check: async (gid: string) =>
          (await db.selectFrom('events').select('id').where('group_id', '=', gid).execute()).length,
      },
      {
        body: '@Chord save https://example.com/article',
        response: fence({
          name: 'save_link',
          args: { title: 'Article', url: 'https://example.com/article' },
        }),
        check: async (gid: string) =>
          (await db.selectFrom('saves').select('id').where('group_id', '=', gid).execute()).length,
      },
      {
        body: '@Chord plan family game night',
        response: fence(
          { name: 'create_task', args: { title: 'Bring snacks' } },
          { name: 'create_event', args: { title: 'Game night', startsAt: soon() } },
        ),
        check: async (gid: string) =>
          (await db.selectFrom('tasks').select('id').where('group_id', '=', gid).execute()).length +
          (await db.selectFrom('events').select('id').where('group_id', '=', gid).execute()).length,
      },
    ];

    const turnsBefore = llmCallCounter.getLlmForUser;
    const turnResults: Array<{
      scenario: string;
      groupId: string;
      sideEffectCount: number;
      ok: boolean;
    }> = [];

    for (let n = 0; n < tasks.length; n++) {
      const t = tasks[n]!;
      const uid = userIds[n + 10]!;          // pick a non-owner
      const gid = groupIds[n % groupIds.length]!;
      // Make sure this user is in that group; if not, add them.
      if (!(await isMember(db, gid, uid))) {
        await addMember(db, gid, uid);
      }

      mockState.response = t.response;

      let ok = true;
      try {
        const trigger = await postMessage(db, { groupId: gid, senderId: uid, body: t.body });
        await runBotTurn(db, trigger, { id: gid, kind: 'group' });
      } catch (err) {
        ok = false;
        failures.push({
          scenario: `bot_turn:${t.body.slice(0, 40)}`,
          userId: uid,
          err: (err as Error).message,
        });
      }

      const count = await t.check(gid).catch(() => -1);
      turnResults.push({ scenario: t.body, groupId: gid, sideEffectCount: count, ok });
    }

    log('bot-turns', {
      turns: turnResults.length,
      results: turnResults,
      llmForUserCallsDelta: llmCallCounter.getLlmForUser - turnsBefore,
    });

    // 6. Final summary.
    const totals = {
      users: userIds.length,
      groups: groupIds.length,
      messagesPosted,
      botTurns: turnResults.length,
      failures: failures.length,
      elapsedMs: Date.now() - startedAt,
      llmForUserCalls: llmCallCounter.getLlmForUser,
    };
    log('summary', totals);
    if (failures.length > 0) log('failures', { failures });

    expect(failures, 'no failures expected in stress run').toHaveLength(0);
    expect(turnResults.every((r) => r.ok && r.sideEffectCount > 0)).toBe(true);
  }, 30_000);
});
