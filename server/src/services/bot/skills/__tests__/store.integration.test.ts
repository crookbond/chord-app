/**
 * ADR 0300 — a skill stored as a row is offered without a deploy, behaves like
 * a code skill, and a bad one is refused when saved (or skipped when loaded)
 * rather than reaching a user.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { parseSkillCommand } from '@/services/bot/skills/auto-start.js';
import { activeSkill, allSkills, getSkill, setStoredSkills, startSkill, stepSkill } from '@/services/bot/skills/index.js';
import { skillCatalogueBlock } from '@/services/bot/skills/prompt.js';
import {
  listSkillDefinitions,
  putSkillDefinition,
  refreshStoredSkills,
  rollbackSkill,
  setSkillEnabled,
  skillToolInventory,
  verifyStoredSkills,
} from '@/services/bot/skills/store.js';
import { CHECK_RENAMES, isToolName, TOOL_RENAMES } from '@/services/bot/skills/definition.js';
import { knownCheck } from '@/services/bot/skills/checks.js';
import { writeMemory } from '@/services/memory.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

const budget = () => ({
  id: 'budget_check',
  title: 'Monthly budget check',
  when: '"help me with my budget", "budget check"',
  command: 'budget',
  opensWithQuestion: true,
  instructions: 'You are helping the user look at their monthly spending. Ask one question at a time.',
  steps: [
    { id: 'income', ask: 'Roughly what comes in each month?', choices: ['Skip'], saveWith: ['remember_fact'] },
    { id: 'airport', ask: 'Which airport do you fly from?', saveWith: ['remember_fact'], known: 'has_fact:home_airport' },
    { id: 'goal', ask: 'What are you saving for?', choices: ['Nothing yet'], saveWith: ['create_task'] },
  ],
  finish: 'Sum up what they told you in two lines.',
});

describe('stored skills (ADR 0300)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    // Already chatting, so a turn does not open onboarding by itself.
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'hi' });
    await insertMessage(db, { groupId: personalId, senderId: userId, body: 'thanks' });
  });
  afterEach(async () => {
    setStoredSkills([]);
    await closeTestDb(db);
  });

  const say = async (body: string) => {
    const msg = await insertMessage(db, { groupId: personalId, senderId: userId, body });
    await runBotTurn(db, msg, { id: personalId, kind: 'personal' });
    return db
      .selectFrom('messages as m')
      .leftJoin('message_cards as c', 'c.message_id', 'm.id')
      .select(['m.body', 'c.cards_json'])
      .where('m.reply_to_id', '=', msg.id)
      .executeTakeFirstOrThrow();
  };

  it('a saved skill is offered at once: listed, started by its command, and run by the server', async () => {
    const put = await putSkillDefinition(db, budget(), { by: 'owner' });
    expect(put).toMatchObject({ ok: true, id: 'budget_check', version: 1, created: true });
    expect(getSkill('budget_check')?.title).toBe('Monthly budget check');
    expect(parseSkillCommand('/budget')?.id).toBe('budget_check');
    expect(await skillCatalogueBlock(db, userId)).toContain('budget_check ("Monthly budget check", or the user types /budget)');

    const opening = await say('/budget');
    expect(opening.body).toContain('Roughly what comes in each month?');
    expect(JSON.parse(opening.cards_json!)).toEqual([expect.objectContaining({ kind: 'choices', replies: ['Skip'] })]);

    // Answering moves it on in code; the airport question is skipped once known.
    await writeMemory(db, {
      groupId: personalId,
      scope: 'persona',
      personaId: userId,
      key: 'home_airport',
      value: 'EWR',
      source: 'explicit',
      status: 'confirmed',
    });
    await say('about 8k');
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('goal');
  });

  it('refuses a broken definition, and says why', async () => {
    const bad = budget();
    bad.steps[0]!.saveWith = ['make_coffee'];
    bad.steps[1]!.known = 'is_tall';
    bad.steps[2]!.id = 'income';
    const r = await putSkillDefinition(db, bad);
    expect(r.ok).toBe(false);
    const errors = !r.ok ? r.errors.join('\n') : '';
    expect(errors).toContain('there is no tool "make_coffee"');
    expect(errors).toContain('there is no check "is_tall"');
    expect(errors).toContain('"income" is used twice');
    expect(await listSkillDefinitions(db)).toEqual([]);
  });

  it('a stored skill cannot take a built-in id or command, or another stored command', async () => {
    const asOnboarding = { ...budget(), id: 'onboarding' };
    expect(await putSkillDefinition(db, asOnboarding)).toMatchObject({ ok: false });
    const asPlan = { ...budget(), command: 'plan' };
    expect(await putSkillDefinition(db, asPlan)).toMatchObject({ ok: false });
    await putSkillDefinition(db, budget());
    const twin = { ...budget(), id: 'budget_two' };
    const r = await putSkillDefinition(db, twin);
    expect(!r.ok && r.errors.join()).toContain('"/budget" is already taken');
  });

  it('disable hides it, enable brings it back, rollback restores an old version', async () => {
    await putSkillDefinition(db, budget());
    const v2 = { ...budget(), title: 'Budget, take two' };
    expect(await putSkillDefinition(db, v2)).toMatchObject({ ok: true, version: 2, created: false });
    expect(getSkill('budget_check')?.title).toBe('Budget, take two');

    await setSkillEnabled(db, 'budget_check', false);
    expect(getSkill('budget_check')).toBeUndefined();
    expect(parseSkillCommand('/budget')).toBeNull();
    await setSkillEnabled(db, 'budget_check', true);
    expect(getSkill('budget_check')).toBeDefined();

    expect(await rollbackSkill(db, 'budget_check', 1)).toMatchObject({ ok: true, version: 3 });
    expect(getSkill('budget_check')?.title).toBe('Monthly budget check');
  });

  it('a run on a question that was removed moves on instead of sticking', async () => {
    await putSkillDefinition(db, budget());
    await startSkill(db, { userId, groupId: personalId, skillId: 'budget_check' });
    await stepSkill(db, { userId, groupId: personalId, action: 'answered' });
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('airport');

    const without = budget();
    without.steps = without.steps.filter((s) => s.id !== 'airport');
    await putSkillDefinition(db, without);
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('goal');
  });

  it('a row that stopped passing is skipped on load and does not hide the others', async () => {
    await putSkillDefinition(db, budget());
    const broken = { ...budget(), id: 'broken_one', command: 'broken' };
    broken.steps[0]!.saveWith = ['a_tool_that_was_removed'];
    await db
      .insertInto('skill_definitions')
      .values({ id: 'broken_one', definition: JSON.stringify(broken), enabled: 1, version: 1, updated_at: new Date().toISOString(), updated_by: null })
      .execute();
    const loaded = await refreshStoredSkills(db);
    expect(loaded.map((s) => s.id)).toEqual(['budget_check']);
    expect(allSkills().map((s) => s.id)).toEqual(['onboarding', 'plan_my_day', 'budget_check']);
    const listed = await listSkillDefinitions(db);
    expect(listed.find((r) => r.id === 'broken_one')?.problems.join()).toContain('a_tool_that_was_removed');
  });

  it('verify: a tool the code no longer has fails the check and names the skill and the tool', async () => {
    await putSkillDefinition(db, budget());
    expect((await verifyStoredSkills(db)).broken).toEqual([]);

    // The deploy just removed create_task: the stored row still names it.
    const stale = budget();
    stale.steps[2]!.saveWith = ['create_task_v0'];
    await db
      .updateTable('skill_definitions')
      .set({ definition: JSON.stringify(stale) })
      .where('id', '=', 'budget_check')
      .execute();
    const r = await verifyStoredSkills(db, { fix: true });
    expect(r.broken).toEqual([{ id: 'budget_check', errors: ['steps.2.saveWith: there is no tool "create_task_v0"'] }]);

    // Disabled, it is reported but no longer stops a deploy.
    await setSkillEnabled(db, 'budget_check', false);
    const after = await verifyStoredSkills(db);
    expect(after.broken).toEqual([]);
    expect(after.disabledBroken.map((s) => s.id)).toEqual(['budget_check']);
  });

  it('verify --fix: a renamed tool is swapped for its new name and saved as a new version', async () => {
    const renames = TOOL_RENAMES as Record<string, string>;
    renames.make_todo = 'create_task';
    try {
      const old = budget();
      old.steps[2]!.saveWith = ['make_todo'];
      await db
        .insertInto('skill_definitions')
        .values({ id: 'budget_check', definition: JSON.stringify(old), enabled: 1, version: 1, updated_at: new Date().toISOString(), updated_by: null })
        .execute();
      // Still runs before anyone saves it: the name is swapped when read.
      await refreshStoredSkills(db);
      expect(getSkill('budget_check')?.steps[2]?.saveWith).toEqual(['create_task']);

      const r = await verifyStoredSkills(db, { fix: true });
      expect(r.broken).toEqual([]);
      expect(r.renamed).toEqual([{ id: 'budget_check', changes: ['tool make_todo → create_task'] }]);
      const row = await db.selectFrom('skill_definitions').selectAll().where('id', '=', 'budget_check').executeTakeFirstOrThrow();
      expect(row.version).toBe(2);
      expect(JSON.stringify(row.definition)).not.toContain('make_todo');
    } finally {
      delete renames.make_todo;
    }
  });

  it('every rename points at a tool or check that exists', () => {
    for (const to of Object.values(TOOL_RENAMES)) expect(isToolName(to)).toBe(true);
    for (const to of Object.values(CHECK_RENAMES)) expect(knownCheck(to)).toBeDefined();
  });

  it('the tool inventory lists every tool and which stored skills use it', async () => {
    await putSkillDefinition(db, budget());
    const tools = await skillToolInventory(db);
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.find((t) => t.tool === 'create_task')).toMatchObject({ usedBy: ['budget_check'] });
    expect(tools.find((t) => t.tool === 'set_nudge_time')?.usedBy).toEqual([]);
    expect(tools.every((t) => t.summary.length > 0 && t.summary.length <= 140)).toBe(true);
  });

  it('start_skill takes a stored skill by id and refuses an unknown one', async () => {
    await putSkillDefinition(db, budget());
    expect(await startSkill(db, { userId, groupId: personalId, skillId: 'budget_check' })).toMatchObject({
      status: 'started',
      step: { id: 'income' },
    });
    expect(await startSkill(db, { userId, groupId: personalId, skillId: 'nope' })).toEqual({ error: 'unknown_skill' });
  });
});
