/**
 * ADR 0300 — a skill stored as data: the JSON shape, and turning it into a
 * `Skill`. Everything a code skill can say is here except code: `known` names
 * a check from `checks.ts` and `ask` is plain text.
 *
 * Checked when saved and again when loaded, so a definition that names a tool
 * removed since it was saved is skipped rather than offered.
 */
import { z } from 'zod';

import { toolSchemas, type ToolName } from '../tools.js';
import { knownCheck } from './checks.js';
import type { Skill } from './types.js';

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolSchemas, name);
}

const ID = /^[a-z][a-z0-9_]{1,39}$/;
const COMMAND = /^[a-z][a-z0-9_-]{1,19}$/;

const stepSchema = z.object({
  id: z.string().regex(ID, 'a step id is lower-case letters, digits and _'),
  ask: z.string().trim().min(1).max(600),
  choices: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
  saveWith: z.array(z.string()).max(6).default([]),
  howToSave: z.string().trim().max(600).optional(),
  known: z.string().max(80).optional(),
});

export const skillDefinitionSchema = z.object({
  id: z.string().regex(ID, 'an id is lower-case letters, digits and _'),
  title: z.string().trim().min(1).max(60),
  when: z.string().trim().min(1).max(300),
  command: z.string().regex(COMMAND, 'a command is lower-case letters, digits, - and _'),
  opensWithQuestion: z.boolean().default(false),
  instructions: z.string().trim().min(1).max(3000),
  steps: z.array(stepSchema).max(20),
  finish: z.string().trim().min(1).max(2000),
});

export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

/**
 * A tool or check that was renamed, old name → new name. A stored skill that
 * names the old one keeps working (the name is swapped when it is read), and
 * `npm run skill -- verify --fix`, which every deploy runs, saves the new
 * name as a new version. Add an entry in the same change that renames the
 * tool. A tool REMOVED outright has no entry: the deploy stops instead, so a
 * person decides what the skill should do now.
 */
export const TOOL_RENAMES: Readonly<Record<string, string>> = {};
export const CHECK_RENAMES: Readonly<Record<string, string>> = {};

/** The definition with renamed tools and checks swapped for their new names. */
function applyRenames(def: SkillDefinition): { definition: SkillDefinition; renamed: string[] } {
  const renamed: string[] = [];
  const steps = def.steps.map((step) => {
    const saveWith = step.saveWith.map((tool) => {
      const to = Object.hasOwn(TOOL_RENAMES, tool) ? TOOL_RENAMES[tool]! : tool;
      if (to !== tool) renamed.push(`tool ${tool} → ${to}`);
      return to;
    });
    let known = step.known;
    if (known && Object.hasOwn(CHECK_RENAMES, known)) {
      renamed.push(`check ${known} → ${CHECK_RENAMES[known]}`);
      known = CHECK_RENAMES[known];
    }
    return { ...step, saveWith, known };
  });
  return { definition: { ...def, steps }, renamed };
}

export type DefinitionResult =
  | { ok: true; definition: SkillDefinition; skill: Skill; renamed: string[] }
  | { ok: false; errors: string[] };

/**
 * Check a definition and build its `Skill`. `taken` is every id and command
 * already in use by some other skill (built-ins and other rows).
 */
export function checkSkillDefinition(
  input: unknown,
  taken: { ids: ReadonlySet<string>; commands: ReadonlySet<string> } = { ids: new Set(), commands: new Set() },
): DefinitionResult {
  const parsed = skillDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`) };
  }
  const { definition: def, renamed } = applyRenames(parsed.data);
  const errors: string[] = [];
  if (taken.ids.has(def.id)) errors.push(`id: "${def.id}" is already a skill`);
  if (taken.commands.has(def.command)) errors.push(`command: "/${def.command}" is already taken`);
  const stepIds = new Set<string>();
  def.steps.forEach((step, i) => {
    if (stepIds.has(step.id)) errors.push(`steps.${i}.id: "${step.id}" is used twice`);
    stepIds.add(step.id);
    for (const tool of step.saveWith) {
      if (!isToolName(tool)) errors.push(`steps.${i}.saveWith: there is no tool "${tool}"`);
    }
    if (step.known && !knownCheck(step.known)) errors.push(`steps.${i}.known: there is no check "${step.known}"`);
  });
  if (errors.length) return { ok: false, errors };

  const skill: Skill = {
    id: def.id,
    title: def.title,
    when: def.when,
    command: def.command,
    opensWithQuestion: def.opensWithQuestion,
    instructions: def.instructions,
    finish: def.finish,
    steps: def.steps.map((step) => ({
      id: step.id,
      ask: step.ask,
      choices: step.choices,
      saveWith: step.saveWith as ToolName[],
      howToSave: step.howToSave,
      known: step.known ? knownCheck(step.known) : undefined,
    })),
  };
  return { ok: true, definition: def, skill, renamed };
}
