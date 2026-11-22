/**
 * ADR 0300 — add, change and switch off chat skills stored as data. A saved
 * skill is offered by every server copy within 30 seconds; no deploy.
 *
 * Usage:
 *   npm run skill --workspace=server -- put <file.json> [--by <name>]
 *   npm run skill --workspace=server -- check <file.json>
 *   npm run skill --workspace=server -- list
 *   npm run skill --workspace=server -- show <id> [--version <n>]
 *   npm run skill --workspace=server -- disable <id>
 *   npm run skill --workspace=server -- enable <id>
 *   npm run skill --workspace=server -- rollback <id> <version> [--by <name>]
 *   npm run skill --workspace=server -- tools      (every tool a skill may name, and who uses it)
 *   npm run skill --workspace=server -- checks     (every check `known` may name)
 *   npm run skill --workspace=server -- verify [--fix]   (can this code run every stored skill?)
 *
 * The definition format is in docs/ops/skills.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { openDb } from '../db/index.js';
import { ensureDataDirs } from '../db/paths.js';
import { BUILT_IN_SKILLS } from '../services/bot/skills/index.js';
import { checkSkillDefinition } from '../services/bot/skills/definition.js';
import {
  getSkillDefinition,
  listSkillDefinitions,
  putSkillDefinition,
  rollbackSkill,
  setSkillEnabled,
  skillToolInventory,
  verifyStoredSkills,
} from '../services/bot/skills/store.js';
import { KNOWN_CHECKS } from '../services/bot/skills/checks.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson(file: string | undefined): unknown {
  if (!file) throw new Error('give the definition file');
  // npm runs this from server/; a path is meant from where it was typed.
  const full = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
  return JSON.parse(readFileSync(full, 'utf8'));
}

function fail(errors: string[]): void {
  console.error(`refused:\n  ${errors.join('\n  ')}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'checks') {
    for (const name of Object.keys(KNOWN_CHECKS).sort()) console.log(name);
    console.log('has_fact:<key>   (a confirmed fact about the user with that key)');
    return;
  }
  if (cmd === 'check') {
    // No database: only the definition's own checks, plus the built-ins' ids.
    const checked = checkSkillDefinition(readJson(a), {
      ids: new Set(BUILT_IN_SKILLS.map((s) => s.id)),
      commands: new Set(BUILT_IN_SKILLS.map((s) => s.command)),
    });
    if (checked.ok) console.log(`ok: ${checked.skill.id} (/${checked.skill.command}), ${checked.skill.steps.length} questions`);
    else fail(checked.errors);
    return;
  }

  ensureDataDirs();
  const db = openDb();
  try {
    if (cmd === 'put') {
      const r = await putSkillDefinition(db, readJson(a), { by: arg('--by') });
      if (r.ok) console.log(`${r.created ? 'added' : 'updated'} ${r.id}, version ${r.version}. Offered within 30 seconds.`);
      else fail(r.errors);
    } else if (cmd === 'tools') {
      for (const t of await skillToolInventory(db)) {
        console.log(`${t.tool}\t${t.usedBy.length ? `used by ${t.usedBy.join(', ')}` : '-'}\t${t.summary}`);
      }
    } else if (cmd === 'verify') {
      const r = await verifyStoredSkills(db, { fix: process.argv.includes('--fix') });
      for (const s of r.renamed) {
        console.log(`${s.id}: ${s.changes.join(', ')}${process.argv.includes('--fix') ? ' (saved)' : ' (run with --fix to save)'}`);
      }
      for (const s of r.disabledBroken) console.log(`${s.id} (disabled): ${s.errors.join('; ')}`);
      if (r.broken.length) {
        fail(
          r.broken.map((s) => `${s.id}: ${s.errors.join('; ')}`).concat(
            'Edit and put each skill again, or disable it, then deploy again.',
          ),
        );
      } else {
        console.log('every enabled stored skill can run on this code');
      }
    } else if (cmd === 'list') {
      const rows = await listSkillDefinitions(db);
      for (const s of BUILT_IN_SKILLS) console.log(`${s.id}\t/${s.command}\tbuilt in`);
      for (const r of rows) {
        const state = !r.enabled ? 'disabled' : r.problems.length ? `SKIPPED: ${r.problems.join('; ')}` : 'enabled';
        console.log(`${r.id}\t/${r.command}\tv${r.version}\t${state}\t${r.updatedAt}${r.updatedBy ? ` by ${r.updatedBy}` : ''}`);
      }
    } else if (cmd === 'show') {
      if (!a) return fail(['give a skill id']);
      const version = arg('--version');
      const def = await getSkillDefinition(db, a, version ? Number(version) : undefined);
      if (!def) return fail([`no stored skill "${a}"${version ? ` version ${version}` : ''}`]);
      console.log(JSON.stringify(def, null, 2));
    } else if (cmd === 'disable' || cmd === 'enable') {
      if (!a) return fail(['give a skill id']);
      if (await setSkillEnabled(db, a, cmd === 'enable')) console.log(`${a} ${cmd}d`);
      else fail([`no stored skill "${a}"`]);
    } else if (cmd === 'rollback') {
      const version = Number(b);
      if (!a || !Number.isInteger(version)) return fail(['give a skill id and a version number']);
      const r = await rollbackSkill(db, a, version, { by: arg('--by') });
      if (r.ok) console.log(`${r.id} is now version ${version}'s definition, saved as version ${r.version}`);
      else fail(r.errors);
    } else {
      fail(['commands: put, check, list, show, disable, enable, rollback, tools, checks, verify']);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
