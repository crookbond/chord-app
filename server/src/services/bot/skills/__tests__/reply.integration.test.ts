/**
 * ADR 0299 addendum — a skill is a guided run, moved on by the server.
 *
 * The prod failure: `/plan`, the overview, "Anything else you need to fit in
 * today?", the user answered "lunch and squash" — and the model asked
 * follow-up questions instead of calling skill_step, so the run sat on the
 * same question and no plan came. Here the reply itself moves the run on,
 * before any model, for every skill.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { activeSkill, startSkill } from '@/services/bot/skills/index.js';
import { skillTurnBlock } from '@/services/bot/skills/prompt.js';
import { handleSkillReply, readSkillControl } from '@/services/bot/skills/reply.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('a skill is moved on by the server (ADR 0299)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    // Already chatting, so the turn does not open onboarding by itself.
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'hi' });
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'thanks' });
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const say = async (body: string) => {
    const msg = await insertMessage(db, { groupId: personalId, senderId: userId, body });
    await runBotTurn(db, msg, { id: personalId, kind: 'personal' });
    return msg.id;
  };
  const replyTo = (triggerId: string) =>
    db
      .selectFrom('messages as m')
      .leftJoin('message_cards as c', 'c.message_id', 'm.id')
      .select(['m.body', 'm.chord_visible', 'c.cards_json'])
      .where('m.reply_to_id', '=', triggerId)
      .executeTakeFirstOrThrow();
  const runStatus = (skillId: string) =>
    db
      .selectFrom('skill_runs')
      .select(['status', 'step_id'])
      .where('user_id', '=', userId)
      .where('skill_id', '=', skillId)
      .executeTakeFirst();

  it('the prod /plan transcript: answering the question finishes the run', async () => {
    await say('/plan');
    expect((await runStatus('plan_my_day'))?.step_id).toBe('extras');
    await say('lunch and squash');
    expect(await runStatus('plan_my_day')).toMatchObject({ status: 'done', step_id: null });
  });

  it('tells the model what was answered and what to ask next, or how to finish', async () => {
    await startSkill(db, { userId, groupId: personalId, skillId: 'onboarding' });
    const r = await handleSkillReply(db, { userId, groupId: personalId, body: 'Just me', replyToId: 'x', messageId: 'y' });
    expect(r.kind).toBe('note');
    if (r.kind !== 'note') return;
    const block = skillTurnBlock(r.note);
    expect(block).toContain('THIS message is the user\'s answer to the question "Who is in your family?');
    expect(block).toContain('add_family_member');
    expect(block).toContain('(2 of');
    expect(block).toContain('skill_step { action: "reopen" }');

    await startSkill(db, { userId, groupId: personalId, skillId: 'plan_my_day' });
    const p = await handleSkillReply(db, { userId, groupId: personalId, body: 'lunch and squash', replyToId: 'x', messageId: 'z' });
    if (p.kind !== 'note') throw new Error('expected a note');
    expect(p.note.next).toBeNull();
    expect(skillTurnBlock(p.note)).toContain('That was the last question. Now: Now give the plan');
  });

  it('skip, later and stop are handled in code, without a model', async () => {
    expect(readSkillControl('Skip')).toBe('skip');
    expect(readSkillControl('not now.')).toBe('pause');
    expect(readSkillControl('stop')).toBe('stop');
    expect(readSkillControl('skip the gym today')).toBeNull();

    await say('/onboard');
    const skip = await say('Skip');
    const skipped = await replyTo(skip);
    expect(skipped.body).toContain('Okay, skipping that.');
    expect(skipped.body).toContain('birthdays');
    expect((await runStatus('onboarding'))?.step_id).toBe('birthdays');

    const later = await say('later');
    expect((await replyTo(later)).body).toContain('/onboard');
    expect((await runStatus('onboarding'))?.status).toBe('paused');
  });

  it('a turn that saved something while a skill runs is still a bubble, with the next question\'s chips', async () => {
    await say('/onboard');
    // The mock model fires create_task (a write tool) for "remind me to …".
    const id = await say('remind me to call the school tomorrow');
    const reply = await replyTo(id);
    expect(reply.chord_visible).toBe(1);
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('birthdays');
    expect(JSON.parse(reply.cards_json ?? '[]')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'choices', replies: ['Skip'] })]),
    );
  });

  it('the first message of a fresh user is not taken as an answer', async () => {
    const fresh = await createUser(db, 'new');
    const pg = (await ensurePersonalGroup(db, fresh)).id;
    const msg = await insertMessage(db, { groupId: pg, senderId: fresh, body: 'hello' });
    await runBotTurn(db, msg, { id: pg, kind: 'personal' });
    expect((await activeSkill(db, fresh, pg))?.step?.id).toBe('household');
  });
});
