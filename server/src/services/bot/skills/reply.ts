/**
 * ADR 0299 addendum — a skill is a guided run, so the server moves it on.
 *
 * While a skill runs in a chat, the user's next message IS the answer to the
 * open question: it is recorded here, in code, before any model runs, and the
 * model is told what was answered and what to ask next (or how to finish).
 * Nothing depends on the model choosing to call a tool to move on — it did
 * not, in prod, and asked follow-up questions instead.
 *
 * A bare skip / later / stop (typed, or a tapped chip) is read here too and
 * answered without a model. The model keeps one way back: if the message was
 * about something else, `skill_step { action: "reopen" }` puts the question
 * back.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../../db/schema.js';
import { postSkillQuestion } from './auto-start.js';
import { activeSkill, stepSkill, type Skill, type StepView } from './index.js';

export type SkillControl = 'skip' | 'pause' | 'stop';

/** A whole message that only says skip / later / stop, or null. */
export function readSkillControl(body: string | null | undefined): SkillControl | null {
  const t = (body ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@chord\s+/, '')
    .replace(/[.!\s]+$/, '');
  if (/^(skip|skip it|skip this|skip that|pass|next|next question)$/.test(t)) return 'skip';
  if (/^(later|not now|maybe later|pause|stop for now|that's enough|thats enough|enough for now)$/.test(t)) return 'pause';
  if (/^(stop|cancel|quit|end|never mind|nevermind)$/.test(t)) return 'stop';
  return null;
}

/** What the model is told on a turn that answered a skill question. */
export interface SkillTurnNote {
  skill: Skill;
  /** The question this message answered; null when it was skipped. */
  answered: StepView | null;
  /** The next question to ask; null when that was the last one. */
  next: StepView | null;
}

export type SkillReplyResult =
  | { kind: 'none' }
  | { kind: 'posted' }
  | { kind: 'note'; note: SkillTurnNote };

/**
 * Handle a message sent while a skill runs in this chat. `posted` = the reply
 * is already in the chat; `note` = run the turn and give the model this note;
 * `none` = no skill is running here.
 */
export async function handleSkillReply(
  db: Kysely<DB>,
  input: { userId: string; groupId: string; body: string | null; replyToId: string; messageId: string },
): Promise<SkillReplyResult> {
  const active = await activeSkill(db, input.userId, input.groupId);
  if (!active || !active.step) return { kind: 'none' };
  const { skill } = active;
  const reply = { replyToId: input.replyToId, id: input.messageId };
  const control = readSkillControl(input.body);

  if (control === 'pause' || control === 'stop') {
    await stepSkill(db, { userId: input.userId, groupId: input.groupId, action: control });
    const text =
      control === 'pause'
        ? `Paused. Type /${skill.command} whenever you want to carry on.`
        : `Okay, I've stopped ${skill.title}. Type /${skill.command} to start again any time.`;
    await postSkillQuestion(db, input.groupId, text, null, reply);
    return { kind: 'posted' };
  }

  const out = await stepSkill(db, {
    userId: input.userId,
    groupId: input.groupId,
    action: control === 'skip' ? 'skip' : 'answered',
  });
  if ('error' in out) return { kind: 'none' };

  if (control === 'skip') {
    if (out.step) {
      await postSkillQuestion(db, input.groupId, `Okay, skipping that.\n\n${out.step.ask}`, out.step, reply);
      return { kind: 'posted' };
    }
    return { kind: 'note', note: { skill, answered: null, next: null } };
  }
  return { kind: 'note', note: { skill, answered: active.step, next: out.step } };
}
