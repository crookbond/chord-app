/**
 * ADR 0322 — the tool catalogue split into a core set and topic groups.
 */
import { describe, expect, it } from 'vitest';

import {
  CORE_TOOLS,
  groupOfTool,
  groupsForText,
  groupsNamingTools,
  moreToolsDef,
  selectToolDefs,
  TOOL_GROUPS,
} from '../tool-groups.js';
import type { LlmToolDef } from '@/services/llm/types.js';

import { buildToolDefs, PERSONAL_ONLY_TOOL_NAMES, toolSchemas } from '../tools.js';

const size = (defs: LlmToolDef[]): number =>
  defs.reduce((s, d) => s + d.name.length + (d.description ?? '').length + JSON.stringify(d.parameters).length, 0);

describe('tool groups (ADR 0322)', () => {
  it('places every tool exactly once', () => {
    const placed = [...CORE_TOOLS, ...TOOL_GROUPS.flatMap((g) => g.tools)].map(String);
    const all = Object.keys(toolSchemas);
    const unplaced = all.filter((t) => !placed.includes(t));
    const twice = placed.filter((t, i) => placed.indexOf(t) !== i);
    const unknown = placed.filter((t) => !all.includes(t));
    expect({ unplaced, twice, unknown }).toEqual({ unplaced: [], twice: [], unknown: [] });
  });

  it('sends a personal "add milk" turn well under half the full catalogue', () => {
    const personal = buildToolDefs();
    const sent = selectToolDefs(personal, groupsForText('add milk to the costco list'), [moreToolsDef()]);
    expect(size(sent)).toBeLessThan(size(personal) * 0.45);
  });

  it('keeps every tool reachable through more_tools', () => {
    const desc = moreToolsDef().description;
    for (const g of TOOL_GROUPS) for (const t of g.tools) expect(desc).toContain(t);
  });

  it('picks groups from the words of the conversation', () => {
    expect(groupsForText('add milk and eggs to the costco list')).toEqual(new Set());
    expect(groupsForText('Add my flight to Denver on the 12th')).toContain('trips');
    expect(groupsForText('reply to the email from the school')).toContain('email');
    expect(groupsForText('unsubscribe me from macys')).toContain('email_settings');
    expect(groupsForText("what's mom's birthday")).toContain('people');
    expect(groupsForText('how many tokens have I used')).toContain('account');
    expect(groupsForText('am I free Thursday afternoon? check my calendar')).toContain('calendar');
  });

  it('reads tool names out of a hint', () => {
    expect(groupsNamingTools('save it with add_family_member, then set_nudge_time')).toEqual(
      new Set(['people', 'account']),
    );
    expect(groupsNamingTools('share_trip')).toEqual(new Set(['trips']));
  });

  it('sends core first and the chosen groups after, in a fixed order', () => {
    const sent = selectToolDefs(buildToolDefs(), new Set(['account', 'trips'])).map((d) => d.name);
    expect(sent.slice(0, CORE_TOOLS.length)).toEqual([...CORE_TOOLS]);
    const tripsAt = sent.indexOf('create_trip');
    const accountAt = sent.indexOf('get_billing_status');
    expect(tripsAt).toBeGreaterThan(0);
    expect(accountAt).toBeGreaterThan(tripsAt);
    expect(sent).not.toContain('read_email');
  });

  it('never adds a personal-only tool the chat was not given', () => {
    const shared = buildToolDefs().filter((d) => !PERSONAL_ONLY_TOOL_NAMES.has(d.name as never));
    const sent = selectToolDefs(shared, new Set(TOOL_GROUPS.map((g) => g.id))).map((d) => d.name);
    expect(sent.some((n) => PERSONAL_ONLY_TOOL_NAMES.has(n as never))).toBe(false);
    expect(groupOfTool('create_trip')).toBe('trips');
    expect(groupOfTool('create_task')).toBeNull();
  });
});
