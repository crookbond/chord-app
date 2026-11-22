/**
 * ADR 0300 — the example skills in docs/ops/skills/examples are meant to be
 * copied, so each one must still pass the save-time checks: a renamed or
 * removed tool fails here, in CI, instead of in someone's terminal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BUILT_IN_SKILLS } from '@/services/bot/skills/index.js';
import { checkSkillDefinition } from '@/services/bot/skills/definition.js';

const dir = fileURLToPath(new URL('../../../../../../docs/ops/skills/examples/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('example skills', () => {
  it('there are examples to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes the save-time checks', (file) => {
    const taken = {
      ids: new Set(BUILT_IN_SKILLS.map((s) => s.id)),
      commands: new Set(BUILT_IN_SKILLS.map((s) => s.command)),
    };
    const checked = checkSkillDefinition(JSON.parse(readFileSync(`${dir}${file}`, 'utf8')), taken);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(checked.ok && `${checked.skill.id}.json`).toBe(file);
  });

  it('no two examples share an id or a command', () => {
    const defs = files.map((f) => JSON.parse(readFileSync(`${dir}${f}`, 'utf8')) as { id: string; command: string });
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.command)).size).toBe(defs.length);
  });
});
