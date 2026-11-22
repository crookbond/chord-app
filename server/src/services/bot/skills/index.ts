/**
 * ADR 0299 — the chat skills, and where a user is in each.
 *
 * A skill's instructions reach the model only once it starts (the prompt
 * lists one line per skill), and while it runs they are repeated every turn
 * with the current question, because a tool result does not survive a turn
 * (ADR 0093/0166). Which question is current lives in `skill_runs`, never in
 * the conversation.
 */
import type { Kysely } from 'kysely';

import type { DB, SkillRunsTable } from '../../../db/schema.js';
import { newId } from '../../../utils/ids.js';
import type { ToolName } from '../tools.js';
import { onboarding } from './onboarding.js';
import { planMyDay } from './plan-my-day.js';
import type { Skill, SkillStep } from './types.js';

export type { Skill, SkillStep } from './types.js';

/** The skills written in code. They always come first and their ids and
 *  commands cannot be taken by a stored one (ADR 0300). */
export const BUILT_IN_SKILLS: readonly Skill[] = [onboarding, planMyDay];

let storedSkills: readonly Skill[] = [];

/** Every skill offered right now: the built-ins, then the enabled stored ones. */
export function allSkills(): readonly Skill[] {
  return [...BUILT_IN_SKILLS, ...storedSkills];
}

/** Replace the stored skills (skills/store.ts, after reading the table). */
export function setStoredSkills(skills: readonly Skill[]): void {
  storedSkills = skills;
}

export function getSkill(id: string): Skill | undefined {
  return allSkills().find((s) => s.id === id);
}

export interface StepView {
  id: string;
  ask: string;
  choices?: string[];
  saveWith: ToolName[];
  howToSave?: string;
  /** 1-based position among the skill's steps, and how many there are. */
  number: number;
  total: number;
}

export type SkillStatus = 'started' | 'resumed' | 'restarted' | 'next' | 'done' | 'paused' | 'stopped';

export interface SkillOutcome {
  status: SkillStatus;
  skill: Skill;
  step: StepView | null;
}

/** `answered`/`skip` are the server's (reply.ts); the model only reopens,
 *  pauses or stops. */
export type SkillAction = 'answered' | 'skip' | 'pause' | 'stop' | 'reopen';

type RunRow = Pick<SkillRunsTable, 'skill_id' | 'status' | 'step_id'> & {
  answered: string[];
  skipped: string[];
};

function view(skill: Skill, step: SkillStep): StepView {
  return {
    id: step.id,
    ask: typeof step.ask === 'function' ? step.ask() : step.ask,
    choices: step.choices,
    saveWith: step.saveWith,
    howToSave: step.howToSave,
    number: skill.steps.indexOf(step) + 1,
    total: skill.steps.length,
  };
}

/** The first step not yet answered or skipped whose answer is not on record. */
async function nextStep(
  db: Kysely<DB>,
  userId: string,
  skill: Skill,
  done: ReadonlySet<string>,
): Promise<SkillStep | null> {
  for (const step of skill.steps) {
    if (done.has(step.id)) continue;
    if (step.known && (await step.known({ db, userId }))) continue;
    return step;
  }
  return null;
}

async function readRun(db: Kysely<DB>, userId: string, skillId: string): Promise<RunRow | undefined> {
  return db
    .selectFrom('skill_runs')
    .select(['skill_id', 'status', 'step_id', 'answered', 'skipped'])
    .where('user_id', '=', userId)
    .where('skill_id', '=', skillId)
    .executeTakeFirst();
}

async function writeRun(
  db: Kysely<DB>,
  input: {
    userId: string;
    groupId: string;
    skillId: string;
    status: SkillRunsTable['status'];
    stepId: string | null;
    answered: string[];
    skipped: string[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const answered = JSON.stringify(input.answered);
  const skipped = JSON.stringify(input.skipped);
  await db
    .insertInto('skill_runs')
    .values({
      id: newId('skr'),
      user_id: input.userId,
      group_id: input.groupId,
      skill_id: input.skillId,
      status: input.status,
      step_id: input.stepId,
      answered,
      skipped,
      started_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'skill_id']).doUpdateSet({
        group_id: input.groupId,
        status: input.status,
        step_id: input.stepId,
        answered,
        skipped,
        updated_at: now,
      }),
    )
    .execute();
}

/**
 * Start a skill in this chat, or pick it up where it was left. `restart`
 * forgets the answered/skipped steps (the answers themselves stay saved). A
 * skill already running here pauses: one at a time per chat.
 */
export async function startSkill(
  db: Kysely<DB>,
  input: { userId: string; groupId: string; skillId: string; restart?: boolean },
): Promise<SkillOutcome | { error: 'unknown_skill' }> {
  const skill = getSkill(input.skillId);
  if (!skill) return { error: 'unknown_skill' };

  await db
    .updateTable('skill_runs')
    .set({ status: 'paused', updated_at: new Date().toISOString() })
    .where('user_id', '=', input.userId)
    .where('group_id', '=', input.groupId)
    .where('status', '=', 'active')
    .where('skill_id', '!=', skill.id)
    .execute();

  const existing = await readRun(db, input.userId, skill.id);
  const resume = !!existing && !input.restart && (existing.status === 'active' || existing.status === 'paused');
  const answered = resume ? existing.answered : [];
  const skipped = resume ? existing.skipped : [];
  const step = await nextStep(db, input.userId, skill, new Set([...answered, ...skipped]));

  await writeRun(db, {
    userId: input.userId,
    groupId: input.groupId,
    skillId: skill.id,
    status: step ? 'active' : 'done',
    stepId: step?.id ?? null,
    answered,
    skipped,
  });
  const status: SkillStatus = !step ? 'done' : resume ? 'resumed' : existing ? 'restarted' : 'started';
  return { status, skill, step: step ? view(skill, step) : null };
}

/**
 * Move the skill running in this chat on: the open question was answered or
 * skipped (called by the server, reply.ts), or the run pauses / stops /
 * reopens its last answer (the model's only moves).
 */
export async function stepSkill(
  db: Kysely<DB>,
  input: { userId: string; groupId: string; action: SkillAction },
): Promise<SkillOutcome | { error: 'no_active_skill' }> {
  if (input.action === 'reopen') return reopenLastAnswer(db, input.userId, input.groupId);

  const active = await activeRun(db, input.userId, input.groupId);
  if (!active) return { error: 'no_active_skill' };
  const { skill, run } = active;

  if (input.action === 'pause' || input.action === 'stop') {
    const status = input.action === 'pause' ? 'paused' : 'stopped';
    await writeRun(db, { ...input, skillId: skill.id, status, stepId: run.step_id, answered: run.answered, skipped: run.skipped });
    const current = skill.steps.find((s) => s.id === run.step_id);
    return { status, skill, step: current ? view(skill, current) : null };
  }

  const current = skill.steps.find((s) => s.id === run.step_id);
  const answered = [...run.answered];
  const skipped = [...run.skipped];
  if (current) (input.action === 'answered' ? answered : skipped).push(current.id);

  const step = await nextStep(db, input.userId, skill, new Set([...answered, ...skipped]));
  await writeRun(db, {
    userId: input.userId,
    groupId: input.groupId,
    skillId: skill.id,
    status: step ? 'active' : 'done',
    stepId: step?.id ?? null,
    answered,
    skipped,
  });
  return { status: step ? 'next' : 'done', skill, step: step ? view(skill, step) : null };
}

/**
 * The server took the user's last message as the answer to the open
 * question; the model says it was about something else. Put that question
 * back. Works on a run that this answer just finished, too.
 */
async function reopenLastAnswer(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
): Promise<SkillOutcome | { error: 'no_active_skill' }> {
  const run = await db
    .selectFrom('skill_runs')
    .select(['skill_id', 'status', 'step_id', 'answered', 'skipped'])
    .where('user_id', '=', userId)
    .where('group_id', '=', groupId)
    .where('status', 'in', ['active', 'done'])
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();
  const skill = run && getSkill(run.skill_id);
  const last = run?.answered.at(-1);
  const step = last && skill?.steps.find((s) => s.id === last);
  if (!run || !skill || !step) return { error: 'no_active_skill' };
  await writeRun(db, {
    userId,
    groupId,
    skillId: skill.id,
    status: 'active',
    stepId: step.id,
    answered: run.answered.slice(0, -1),
    skipped: run.skipped,
  });
  return { status: 'next', skill, step: view(skill, step) };
}

async function activeRun(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
): Promise<{ skill: Skill; run: RunRow } | null> {
  const run = await db
    .selectFrom('skill_runs')
    .select(['skill_id', 'status', 'step_id', 'answered', 'skipped'])
    .where('user_id', '=', userId)
    .where('group_id', '=', groupId)
    .where('status', '=', 'active')
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();
  const skill = run && getSkill(run.skill_id);
  if (!run || !skill) return null;
  // The question it sits on was removed (or renamed) since: move on to the
  // next unanswered one instead of leaving the run stuck (ADR 0300).
  if (run.step_id && !skill.steps.some((s) => s.id === run.step_id)) {
    const known = new Set(skill.steps.map((s) => s.id));
    const answered = run.answered.filter((id) => known.has(id));
    const skipped = run.skipped.filter((id) => known.has(id));
    const step = await nextStep(db, userId, skill, new Set([...answered, ...skipped]));
    await writeRun(db, {
      userId,
      groupId,
      skillId: skill.id,
      status: step ? 'active' : 'done',
      stepId: step?.id ?? null,
      answered,
      skipped,
    });
    if (!step) return null;
    return { skill, run: { ...run, step_id: step.id, answered, skipped } };
  }
  return { skill, run };
}

/** The skill running in this chat and its current question, for the prompt. */
export async function activeSkill(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
): Promise<{ skill: Skill; step: StepView | null } | null> {
  const active = await activeRun(db, userId, groupId);
  if (!active) return null;
  const step = active.skill.steps.find((s) => s.id === active.run.step_id);
  return { skill: active.skill, step: step ? view(active.skill, step) : null };
}

/** How far the user is in each skill, by id. Absent = never started. */
export async function skillProgress(
  db: Kysely<DB>,
  userId: string,
): Promise<Map<string, { status: SkillRunsTable['status']; stepNumber: number | null }>> {
  const rows = await db
    .selectFrom('skill_runs')
    .select(['skill_id', 'status', 'step_id'])
    .where('user_id', '=', userId)
    .execute();
  const out = new Map<string, { status: SkillRunsTable['status']; stepNumber: number | null }>();
  for (const r of rows) {
    const skill = getSkill(r.skill_id);
    if (!skill) continue;
    const i = skill.steps.findIndex((s) => s.id === r.step_id);
    out.set(r.skill_id, { status: r.status, stepNumber: i >= 0 ? i + 1 : null });
  }
  return out;
}
