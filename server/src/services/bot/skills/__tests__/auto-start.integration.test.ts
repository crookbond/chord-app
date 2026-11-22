/**
 * ADR 0299 addendum — onboarding starts by itself on first use, and `/onboard`
 * (or any skill's command) starts it any time, both without a model.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { activeSkill, startSkill, stepSkill } from '@/services/bot/skills/index.js';
import { maybeStartOnboarding, parseSkillCommand } from '@/services/bot/skills/auto-start.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('starting onboarding (ADR 0299)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const botMessages = () =>
    db
      .selectFrom('messages as m')
      .leftJoin('message_cards as c', 'c.message_id', 'm.id')
      .select(['m.id', 'm.body', 'c.cards_json'])
      .where('m.group_id', '=', personalId)
      .where('m.sender_id', 'is', null)
      .orderBy('m.created_at')
      .execute();
  const say = async (body: string) => {
    const msg = await insertMessage(db, { groupId: personalId, senderId: userId, body });
    await runBotTurn(db, msg, { id: personalId, kind: 'personal' });
  };

  it('on first use, posts the first question with its answers', async () => {
    expect(await maybeStartOnboarding(db, userId, { post: true })).toBe(true);
    const [opening] = await botMessages();
    expect(opening?.body).toContain('Let me get to know you');
    expect(opening?.body).toContain('Who is in your family?');
    expect(JSON.parse(opening!.cards_json!)).toEqual([expect.objectContaining({ kind: 'choices', replies: ['Just me'] })]);
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('household');
  });

  it('happens once: a second first-use moment does nothing', async () => {
    await maybeStartOnboarding(db, userId, { post: true });
    expect(await maybeStartOnboarding(db, userId, { post: true })).toBe(false);
    expect(await botMessages()).toHaveLength(1);
  });

  it('is not first use for someone already chatting, or for a taster account', async () => {
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'hi' });
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'what is on today' });
    expect(await maybeStartOnboarding(db, userId, { post: true })).toBe(false);

    const shadow = await createUser(db, 'taster');
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', shadow).execute();
    expect(await maybeStartOnboarding(db, shadow, { post: true })).toBe(false);
  });

  it('a first message in the personal chat opens onboarding for that turn', async () => {
    await say('hello');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('household');
  });

  it('reads the slash command, nothing else', () => {
    expect(parseSkillCommand('/onboard')?.id).toBe('onboarding');
    expect(parseSkillCommand('  /Onboard ')?.id).toBe('onboarding');
    expect(parseSkillCommand('/plan')?.id).toBe('plan_my_day');
    expect(parseSkillCommand('/onboard me please')).toBeNull();
    expect(parseSkillCommand('please /onboard')).toBeNull();
    expect(parseSkillCommand('/nope')).toBeNull();
  });

  it('/onboard starts it for an existing user and posts the question as the turn\'s reply', async () => {
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'hi' });
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'thanks' });
    await say('/onboard');
    const replies = await botMessages();
    expect(replies.at(-1)?.body).toContain('Who is in your family?');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('household');
  });

  it('/onboard resumes a paused run where it was, and restarts a finished one', async () => {
    await startSkill(db, { userId, groupId: personalId, skillId: 'onboarding' });
    await stepSkill(db, { userId, groupId: personalId, action: 'skip' });
    await stepSkill(db, { userId, groupId: personalId, action: 'pause' });
    await say('/onboard');
    expect((await botMessages()).at(-1)?.body).toContain('Picking up where we left off');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('birthdays');

    await stepSkill(db, { userId, groupId: personalId, action: 'stop' });
    await say('/onboard');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('household');
  });
});
