/**
 * ADR 0299 — chat skills. Pinned here: progress lives on the server (a later
 * turn knows the open question without the earlier tool result), a question
 * whose answer is already on record is never asked, the model can only
 * reopen / pause / stop (the server records answers, reply.ts), one skill runs
 * per chat, and the tools work in the personal 1:1 only.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { activeSkill, startSkill, stepSkill } from '@/services/bot/skills/index.js';
import { activeSkillBlock, skillCatalogueBlock } from '@/services/bot/skills/prompt.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('chat skills (ADR 0299)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let sharedId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    sharedId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const call = (name: string, args: Record<string, unknown>, groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tz: 'America/New_York',
      call: { name, args } as never,
    });

  const dataOf = (r: Awaited<ReturnType<typeof call>>) => r.data as Record<string, any>;
  const step = (action: 'answered' | 'skip') => stepSkill(db, { userId, groupId: personalId, action });

  it('starts onboarding on the first question and offers its answers as chips', async () => {
    const r = await call('start_skill', { skill: 'onboarding' });
    const d = dataOf(r);
    expect(d.status).toBe('started');
    expect(d.step.id).toBe('household');
    expect(d.instructions).toContain('ONE question at a time');
    expect(r.card).toMatchObject({ kind: 'choices', replies: ['Just me'] });
  });

  it('skips questions whose answer is already saved', async () => {
    await call('add_person', { displayName: 'Ben', notes: 'son, 9' });
    await call('add_important_date', { personName: 'Ben', kind: 'birthday', date: '0000-05-08', recurs: true });
    const d = dataOf(await call('start_skill', { skill: 'onboarding' }));
    expect(d.step.id).toBe('school');
  });

  it('a later turn finds the open question from the server, and an answer saved for a later question skips it', async () => {
    await call('start_skill', { skill: 'onboarding' });
    // Next turn: the user names the family AND a birthday in one message.
    await call('add_person', { displayName: 'Ben', notes: 'son, 9' });
    await call('add_important_date', { personName: 'Ben', kind: 'birthday', date: '0000-05-08', recurs: true });
    const open = await activeSkill(db, userId, personalId);
    expect(open?.step?.id).toBe('household');
    const d = await step('answered');
    expect('step' in d && d.step?.id).toBe('school');
  });

  it('the model cannot move a skill on, only reopen a question the server took as answered', async () => {
    await call('start_skill', { skill: 'onboarding' });
    expect((await call('skill_step', { action: 'answered' })).summary).toMatch(/invalid|reject/i);
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('household');

    await step('answered');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('birthdays');
    const d = dataOf(await call('skill_step', { action: 'reopen' }));
    expect(d.step.id).toBe('household');
    expect(d.instruction).toContain('nothing was saved for it');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('household');
  });

  it('walks to the end and says what to do when finished', async () => {
    await call('start_skill', { skill: 'onboarding' });
    let d: Awaited<ReturnType<typeof step>> = { error: 'no_active_skill' };
    for (let i = 0; i < 10; i += 1) {
      d = await step('skip');
      if ('status' in d && d.status === 'done') break;
    }
    expect('status' in d && d.status).toBe('done');
    expect('skill' in d && d.skill.finish).toContain('Setup is complete');
    expect(await activeSkill(db, userId, personalId)).toBeNull();
    expect(await skillCatalogueBlock(db, userId)).toContain('onboarding ("Getting to know you", or the user types /onboard): start when');
    expect(await skillCatalogueBlock(db, userId)).toContain('This user: done.');
  });

  it('pauses and resumes where it was, and restart begins again', async () => {
    await call('start_skill', { skill: 'onboarding' });
    await step('skip');
    await call('skill_step', { action: 'pause' });
    expect(await activeSkill(db, userId, personalId)).toBeNull();
    expect(await skillCatalogueBlock(db, userId)).toContain('paused at question 2 of');

    const resumed = dataOf(await call('start_skill', { skill: 'onboarding' }));
    expect(resumed.status).toBe('resumed');
    expect(resumed.step.id).toBe('birthdays');

    const again = dataOf(await call('start_skill', { skill: 'onboarding', restart: true }));
    expect(again.status).toBe('restarted');
    expect(again.step.id).toBe('household');
  });

  it('runs one skill per chat: starting another pauses the first', async () => {
    await call('start_skill', { skill: 'onboarding' });
    const d = dataOf(await call('start_skill', { skill: 'plan_my_day' }));
    expect(d.step.id).toBe('extras');
    expect((await activeSkill(db, userId, personalId))?.skill.id).toBe('plan_my_day');
    const block = await activeSkillBlock(db, userId, personalId);
    expect(block).toContain('## Skill in progress: Plan my day');
    expect(block).toContain('Anything else you need to fit in today?');
    expect(block).toContain('do not call skill_step');

    const done = await step('answered');
    expect('status' in done && done.status).toBe('done');
    expect('skill' in done && done.skill.finish).toContain('Create them only if the user says yes');
    expect(await skillCatalogueBlock(db, userId)).toContain('paused at question 1 of');
  });

  it('works in the personal chat only', async () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('start_skill')).toBe(true);
    expect(PERSONAL_ONLY_TOOL_NAMES.has('skill_step')).toBe(true);
    const d = dataOf(await call('start_skill', { skill: 'onboarding' }, sharedId));
    expect(d.reason).toBe('personal_only');
    expect(await activeSkill(db, userId, sharedId)).toBeNull();
  });

  it('a skill_step with nothing running says so instead of claiming progress', async () => {
    const d = dataOf(await call('skill_step', { action: 'pause' }));
    expect(d.reason).toBe('no_active_skill');
  });

  it('an unknown skill id is refused', async () => {
    expect(await startSkill(db, { userId, groupId: personalId, skillId: 'nope' })).toEqual({ error: 'unknown_skill' });
    expect(await stepSkill(db, { userId, groupId: personalId, action: 'skip' })).toEqual({ error: 'no_active_skill' });
  });
});
