/**
 * ADR 0299 — a chat skill: instructions the bot loads on demand, plus an
 * optional ordered set of questions whose progress the server keeps.
 *
 * Answers are never stored here. Each step names the existing tools that save
 * what the user said, so a skill adds no second way to write anything.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../../db/schema.js';
import type { ToolName } from '../tools.js';

export interface SkillContext {
  db: Kysely<DB>;
  userId: string;
}

export interface SkillStep {
  /** Stable id: stored in `skill_runs`, so never rename one that has shipped. */
  id: string;
  /** What to ask, in the bot's words. A function when it reads config. */
  ask: string | (() => string);
  /** Tappable answers shown under the question. */
  choices?: string[];
  /** The tools that save the answer. Empty = nothing to save (e.g. "go to Settings"). */
  saveWith: ToolName[];
  /** How to save it, when the tool alone does not say. */
  howToSave?: string;
  /**
   * True when the answer is already on record, so the question is not asked.
   * Read from the data itself, never from the model.
   */
  known?: (ctx: SkillContext) => Promise<boolean>;
}

export interface Skill {
  id: string;
  title: string;
  /** One line for the list of skills in the prompt: when to start it. */
  when: string;
  /** Typed as `/<command>` in the personal chat, it starts the skill without a model. */
  command: string;
  /** Post the first question as soon as the skill starts (it needs nothing read
   *  first). False when the model must look something up before asking. */
  opensWithQuestion: boolean;
  /** Loaded when the skill starts, and repeated every turn while it runs. */
  instructions: string;
  steps: SkillStep[];
  /** Told to the model once the last step is answered or skipped. */
  finish: string;
}
