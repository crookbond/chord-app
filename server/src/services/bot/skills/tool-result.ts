/**
 * ADR 0299 — what start_skill / skill_step hand back to the model, and the
 * tappable answers card for the question it is about to ask.
 */
import type { BotCard } from '@chord/kernel';

import type { SkillOutcome, StepView } from './index.js';
import { askInstruction } from './prompt.js';

export function choicesCard(step: StepView): BotCard | undefined {
  if (!step.choices?.length) return undefined;
  return {
    kind: 'choices',
    // The question is already the message; bridges print "Reply with — a · b".
    title: 'Reply with',
    subtitle: step.choices.join(' · '),
    replies: step.choices,
  };
}

type Outcome = SkillOutcome | { error: 'unknown_skill' } | { error: 'no_active_skill' } | { error: 'wrong_step' };

export function skillToolResult(
  name: string,
  outcome: Outcome,
): { summary: string; data: unknown; card?: BotCard } {
  if ('error' in outcome) {
    return {
      summary: `${name}: ${outcome.error}`,
      data: {
        ok: false,
        reason: outcome.error,
        instruction:
          outcome.error === 'unknown_skill'
            ? 'There is no skill by that id. Use one from the Skills list.'
            : 'No skill question is open in this chat. Do not say you moved anything on.',
      },
    };
  }

  const { status, skill, step } = outcome;
  const summary = `${name}: ${skill.id} ${status}${step ? ` → ${step.id}` : ''}`;
  if (status === 'paused' || status === 'stopped') {
    return {
      summary,
      data: {
        ok: true,
        status,
        instruction:
          status === 'paused'
            ? `Paused. Tell them in one line they can type /${skill.command} to carry on any time.`
            : `Stopped. Acknowledge in one line and do not bring ${skill.title} up again.`,
      },
    };
  }
  if (!step) {
    return { summary, data: { ok: true, status: 'done', finish: skill.finish } };
  }
  const starting = name === 'start_skill';
  return {
    summary,
    data: {
      ok: true,
      status,
      ...(starting ? { instructions: skill.instructions } : {}),
      step,
      instruction: starting
        ? askInstruction(step)
        : `The question is open again; nothing was saved for it. Deal with what the user said, then ${askInstruction(step)}`,
    },
    card: choicesCard(step),
  };
}
