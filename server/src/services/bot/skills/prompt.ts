/**
 * ADR 0299 — what the prompt says about skills: one line per skill (with the
 * user's progress in it), and, while one runs, its instructions and what to
 * ask. The server moves the run on (reply.ts); the model is only ever told
 * what was answered and what comes next.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../../db/schema.js';
import { activeSkill, allSkills, skillProgress, type StepView } from './index.js';
import type { SkillTurnNote } from './reply.js';

export async function skillCatalogueBlock(db: Kysely<DB>, userId: string): Promise<string> {
  const progress = await skillProgress(db, userId);
  const lines = allSkills().map((s) => {
    const p = progress.get(s.id);
    const where = !p
      ? 'not started'
      : p.status === 'done'
        ? 'done'
        : p.status === 'stopped'
          ? 'stopped by the user'
          : p.stepNumber
            ? `${p.status} at question ${p.stepNumber} of ${s.steps.length}`
            : p.status;
    return `- ${s.id} ("${s.title}", or the user types /${s.command}): start when ${s.when}. This user: ${where}.`;
  });
  // Onboarding opens by itself on first use (auto-start.ts); after that it
  // runs only when asked, so the bot never offers it on its own.
  return (
    '## Skills\nGuided conversations you can run. To run one, call start_skill with its id; it returns what to do. ' +
    'Start one only when the user asks for it.\n' +
    lines.join('\n')
  );
}

/** How to ask a question. The answer is recorded from the user's next message,
 *  so the model never moves the run on itself. */
export function askInstruction(step: StepView): string {
  return [
    `Ask this question now (${step.number} of ${step.total}), in your own short words, as the end of your reply: "${step.ask}"`,
    step.choices?.length
      ? `Tappable answers are shown under your reply: ${step.choices.map((c) => `"${c}"`).join(', ')}.`
      : '',
    'Do not ask anything else, and do not call skill_step: the server records their next message as the answer.',
  ]
    .filter(Boolean)
    .join(' ');
}

function saveInstruction(step: StepView): string {
  const save =
    step.saveWith.length > 0
      ? `Save what it says with: ${step.saveWith.join(', ')}.`
      : 'There is nothing to save for this one.';
  return [save, step.howToSave ?? '', 'If it gives nothing to save ("just me", "none", "no"), save nothing.']
    .filter(Boolean)
    .join(' ');
}

const NOT_AN_ANSWER =
  'If THIS message is clearly not an answer to that question (it is about something else), deal with what it asks instead, save nothing for the question, and call skill_step { action: "reopen" } so the question is asked again later. If the user wants to stop for now, call skill_step { action: "pause" }; to end it for good, "stop".';

/** The turn that answered a question: what was answered, then what to do. */
export function skillTurnBlock(note: SkillTurnNote): string {
  const { skill, answered, next } = note;
  const lines = [`## Skill in progress: ${skill.title}`, skill.instructions];
  if (answered) {
    lines.push(
      `THIS message is the user's answer to the question "${answered.ask}". ${saveInstruction(answered)}`,
      NOT_AN_ANSWER,
    );
  } else {
    lines.push('The user skipped the last question.');
  }
  lines.push(next ? `Then: ${askInstruction(next)}` : `That was the last question. Now: ${skill.finish}`);
  return lines.join('\n');
}

/** A turn while a skill is open that did not come from an answer (the run
 *  was just started, or reopened): the question still needs asking. */
export async function activeSkillBlock(db: Kysely<DB>, userId: string, groupId: string): Promise<string> {
  const active = await activeSkill(db, userId, groupId);
  if (!active || !active.step) return '';
  return [
    `## Skill in progress: ${active.skill.title}`,
    active.skill.instructions,
    'Answer anything the user asked first, then ' + askInstruction(active.step),
  ].join('\n');
}
