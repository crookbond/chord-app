/**
 * ADR 0300 — skills stored in `skill_definitions`, picked up without a
 * deploy. Writes check the definition first (`putSkillDefinition` refuses
 * anything `checkSkillDefinition` rejects), every save keeps a version, and
 * each server copy re-reads the table every 30 seconds.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../../config/logging.js';
import type { DB } from '../../../db/schema.js';
import { TOOL_DESCRIPTIONS } from '../tools.js';
import { BUILT_IN_SKILLS, setStoredSkills } from './index.js';
import { checkSkillDefinition, type SkillDefinition } from './definition.js';
import type { Skill } from './types.js';

export const SKILL_REFRESH_MS = 30_000;

function builtInTaken(): { ids: Set<string>; commands: Set<string> } {
  return {
    ids: new Set(BUILT_IN_SKILLS.map((s) => s.id)),
    commands: new Set(BUILT_IN_SKILLS.map((s) => s.command)),
  };
}

/** Ids and commands in use by everything except the stored skill `exceptId`. */
async function takenBy(db: Kysely<DB>, exceptId: string): Promise<{ ids: Set<string>; commands: Set<string> }> {
  const taken = builtInTaken();
  const rows = await db
    .selectFrom('skill_definitions')
    .select(['id', 'definition'])
    .where('id', '!=', exceptId)
    .execute();
  for (const r of rows) {
    taken.ids.add(r.id);
    const command = (r.definition as { command?: unknown })?.command;
    if (typeof command === 'string') taken.commands.add(command);
  }
  return taken;
}

export type PutResult = { ok: true; id: string; version: number; created: boolean } | { ok: false; errors: string[] };

/** Save a skill (new, or a new version of a stored one) and offer it. */
export async function putSkillDefinition(db: Kysely<DB>, input: unknown, opts: { by?: string } = {}): Promise<PutResult> {
  const id = (input as { id?: unknown })?.id;
  const checked = checkSkillDefinition(input, await takenBy(db, typeof id === 'string' ? id : ''));
  if (!checked.ok) return checked;
  const def = checked.definition;
  const now = new Date().toISOString();
  const json = JSON.stringify(def);
  const result = await db.transaction().execute(async (trx) => {
    const prior = await trx
      .selectFrom('skill_definitions')
      .select('version')
      .where('id', '=', def.id)
      .forUpdate()
      .executeTakeFirst();
    const version = (prior?.version ?? 0) + 1;
    await trx
      .insertInto('skill_definition_versions')
      .values({ skill_id: def.id, version, definition: json, created_at: now, created_by: opts.by ?? null })
      .execute();
    await trx
      .insertInto('skill_definitions')
      .values({ id: def.id, definition: json, enabled: 1, version, updated_at: now, updated_by: opts.by ?? null })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ definition: json, version, updated_at: now, updated_by: opts.by ?? null }),
      )
      .execute();
    return { version, created: !prior };
  });
  await refreshStoredSkills(db);
  return { ok: true, id: def.id, ...result };
}

export async function setSkillEnabled(db: Kysely<DB>, id: string, enabled: boolean): Promise<boolean> {
  const res = await db
    .updateTable('skill_definitions')
    .set({ enabled: enabled ? 1 : 0, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .executeTakeFirst();
  await refreshStoredSkills(db);
  return Number(res.numUpdatedRows) > 0;
}

/** Make an earlier version current again (saved as a new version). */
export async function rollbackSkill(db: Kysely<DB>, id: string, version: number, opts: { by?: string } = {}): Promise<PutResult> {
  const row = await db
    .selectFrom('skill_definition_versions')
    .select('definition')
    .where('skill_id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (!row) return { ok: false, errors: [`no version ${version} of "${id}"`] };
  return putSkillDefinition(db, row.definition, opts);
}

export interface StoredSkillRow {
  id: string;
  title: string;
  command: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  /** Why the loader skips it, when it does. */
  problems: string[];
}

export async function listSkillDefinitions(db: Kysely<DB>): Promise<StoredSkillRow[]> {
  const rows = await db.selectFrom('skill_definitions').selectAll().orderBy('id').execute();
  const builtIn = builtInTaken();
  return rows.map((r) => {
    const def = r.definition as Partial<SkillDefinition>;
    const checked = checkSkillDefinition(r.definition, builtIn);
    return {
      id: r.id,
      title: String(def?.title ?? ''),
      command: String(def?.command ?? ''),
      enabled: r.enabled === 1,
      version: r.version,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      problems: checked.ok ? [] : checked.errors,
    };
  });
}

export async function getSkillDefinition(db: Kysely<DB>, id: string, version?: number): Promise<unknown | null> {
  if (version !== undefined) {
    const v = await db
      .selectFrom('skill_definition_versions')
      .select('definition')
      .where('skill_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirst();
    return v?.definition ?? null;
  }
  const row = await db.selectFrom('skill_definitions').select('definition').where('id', '=', id).executeTakeFirst();
  return row?.definition ?? null;
}

/**
 * Read the enabled rows into the skill list. A row that no longer passes the
 * checks, or whose id or command a built-in or an earlier row took, is
 * skipped and logged; one bad row never hides the rest.
 */
export async function refreshStoredSkills(db: Kysely<DB>): Promise<readonly Skill[]> {
  const rows = await db
    .selectFrom('skill_definitions')
    .select(['id', 'definition'])
    .where('enabled', '=', 1)
    .orderBy('id')
    .execute();
  const taken = builtInTaken();
  const skills: Skill[] = [];
  for (const row of rows) {
    const checked = checkSkillDefinition(row.definition, taken);
    if (!checked.ok) {
      logger.warn('stored skill skipped', { skillId: row.id, errors: checked.errors });
      continue;
    }
    taken.ids.add(checked.skill.id);
    taken.commands.add(checked.skill.command);
    skills.push(checked.skill);
  }
  setStoredSkills(skills);
  return skills;
}

export interface SkillVerifyResult {
  /** Enabled skills this code cannot run, and why. A deploy stops on any. */
  broken: Array<{ id: string; errors: string[] }>;
  /** Disabled skills that would not load if enabled. Reported, never fatal. */
  disabledBroken: Array<{ id: string; errors: string[] }>;
  /** Skills that named a renamed tool or check; saved with the new name when `fix`. */
  renamed: Array<{ id: string; changes: string[] }>;
}

/**
 * Can this code run every stored skill? Run by each deploy with the NEW code
 * against the live table, before the services restart (ADR 0300): a skill
 * naming a tool this code no longer has stops the deploy, naming the skill
 * and the tool. With `fix`, a skill that only named a renamed tool is saved
 * with the new name.
 */
export async function verifyStoredSkills(db: Kysely<DB>, opts: { fix?: boolean } = {}): Promise<SkillVerifyResult> {
  const rows = await db.selectFrom('skill_definitions').select(['id', 'definition', 'enabled']).orderBy('id').execute();
  const result: SkillVerifyResult = { broken: [], disabledBroken: [], renamed: [] };
  for (const row of rows) {
    const checked = checkSkillDefinition(row.definition, builtInTaken());
    if (!checked.ok) {
      (row.enabled === 1 ? result.broken : result.disabledBroken).push({ id: row.id, errors: checked.errors });
      continue;
    }
    if (checked.renamed.length) {
      result.renamed.push({ id: row.id, changes: checked.renamed });
      if (opts.fix) await putSkillDefinition(db, checked.definition, { by: 'deploy (renamed tool)' });
    }
  }
  if (opts.fix) await refreshStoredSkills(db);
  return result;
}

export interface ToolUse {
  tool: string;
  /** First sentence of the tool's description. */
  summary: string;
  /** Stored skills that name it, enabled or not. */
  usedBy: string[];
}

/** Every tool a skill may name in `saveWith`, and which stored skills name it. */
export async function skillToolInventory(db: Kysely<DB>): Promise<ToolUse[]> {
  const usedBy = new Map<string, Set<string>>();
  const rows = await db.selectFrom('skill_definitions').select(['id', 'definition']).execute();
  for (const row of rows) {
    const steps = (row.definition as { steps?: Array<{ saveWith?: unknown }> })?.steps ?? [];
    for (const step of steps) {
      for (const tool of Array.isArray(step.saveWith) ? step.saveWith : []) {
        if (typeof tool !== 'string') continue;
        if (!usedBy.has(tool)) usedBy.set(tool, new Set());
        usedBy.get(tool)!.add(row.id);
      }
    }
  }
  return (Object.keys(TOOL_DESCRIPTIONS) as Array<keyof typeof TOOL_DESCRIPTIONS>)
    .sort()
    .map((tool) => {
      const text = TOOL_DESCRIPTIONS[tool].replace(/\s+/g, ' ').trim();
      const first = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
      return {
        tool,
        summary: first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first,
        usedBy: [...(usedBy.get(tool) ?? [])].sort(),
      };
    });
}

/** Load stored skills now and every `SKILL_REFRESH_MS`. Returns a stop function. */
export function startSkillRegistry(db: Kysely<DB>): () => void {
  const load = () =>
    refreshStoredSkills(db).catch((err) => logger.warn('stored skills refresh failed', { err }));
  void load();
  const timer = setInterval(load, SKILL_REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
