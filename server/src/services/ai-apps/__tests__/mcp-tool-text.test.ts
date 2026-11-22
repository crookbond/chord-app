import { describe, expect, it } from 'vitest';

import { buildToolDefs } from '../../bot/tools.js';
import { listMcpTools, PARAM_DESCRIPTIONS } from '../mcp-tools.js';

// The Claude and ChatGPT directories reject tool text that tells the model how
// to behave or which other tool to call (ADR 0335). The connector's text must
// describe what a tool does; guidance goes in the server instructions.
const DIRECTING =
  /\b(never|always|tell the user|call (it|this|get_|search|read_|update_)|use (it|this|read_|search|a threadId)|leave (it )?out|walk (them|the user)|say so|only when the user|you should|do not)\b/i;

const tools = listMcpTools(['read', 'suggest']);

function paramTexts(): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const t of tools) {
    const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: unknown }>;
    for (const [k, v] of Object.entries(props)) {
      if (typeof v?.description === 'string') out.push({ key: `${t.name}.${k}`, text: v.description });
    }
  }
  return out;
}

describe('connector tool text', () => {
  it('tool descriptions describe and never direct the model', () => {
    for (const t of tools) expect(t.description, t.name).not.toMatch(DIRECTING);
  });

  it('parameter descriptions describe and never direct the model', () => {
    for (const { key, text } of paramTexts()) expect(text, key).not.toMatch(DIRECTING);
  });

  it('every described parameter has connector text, not the bot\'s', () => {
    for (const { key, text } of paramTexts()) {
      expect(PARAM_DESCRIPTIONS[key], `${key} needs an entry in PARAM_DESCRIPTIONS`).toBeDefined();
      expect(text).toBe(PARAM_DESCRIPTIONS[key]);
    }
  });

  it('names no bot tool the connector does not offer', () => {
    const offered = new Set(tools.map((t) => t.name));
    const botTools = buildToolDefs().map((d) => d.name).filter((n) => !offered.has(n));
    const all = [...tools.map((t) => t.description), ...paramTexts().map((p) => p.text)].join('\n');
    for (const name of botTools) expect(all, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});
