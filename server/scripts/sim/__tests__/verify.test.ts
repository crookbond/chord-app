/**
 * Unit coverage for verifyTurn — exercises the new expectNoTool /
 * forbiddenTools assertions added for the recipe answer pattern, plus
 * the existing happy path so we notice if it regresses.
 */
import { describe, expect, it } from 'vitest';

import type { ChordTemplate } from '../scenarios.js';
import { type CapturedTurn, verifyTurn } from '../verify.js';

function turn(overrides: Partial<CapturedTurn> = {}): CapturedTurn {
  return {
    promptMessageId: 'm_test',
    replyMessageIds: [],
    toolCalls: [],
    cards: [],
    done: true,
    timedOut: false,
    startedAt: 0,
    durationMs: 100,
    ...overrides,
  };
}

describe('verifyTurn — happy path', () => {
  it('passes when the expected tool fires', () => {
    const tmpl: ChordTemplate = { prompt: 'x', expectTool: 'create_task' };
    const r = verifyTurn(
      tmpl,
      turn({ toolCalls: [{ name: 'create_task', status: 'ok', summary: 'ok' }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails on timeout regardless of other expectations', () => {
    const tmpl: ChordTemplate = { prompt: 'x', expectTool: 'create_task' };
    const r = verifyTurn(tmpl, turn({ timedOut: true }));
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('timeout');
  });

  it('fails with wrong-tool when a different tool fires', () => {
    const tmpl: ChordTemplate = { prompt: 'x', expectTool: 'create_task' };
    const r = verifyTurn(
      tmpl,
      turn({ toolCalls: [{ name: 'add_list_item', status: 'ok', summary: '' }] }),
    );
    expect(r.ok).toBe(false);
    const wrong = r.failures.find((f) => f.code === 'wrong-tool');
    expect(wrong).toBeDefined();
  });
});

describe('verifyTurn — expectNoTool (inline-prose pattern)', () => {
  const tmpl: ChordTemplate = {
    prompt: '@Chord give me a recipe',
    expectTool: '(none)',
    expectNoTool: true,
  };

  it('passes when no tool fires', () => {
    const r = verifyTurn(tmpl, turn({ toolCalls: [] }));
    expect(r.ok).toBe(true);
  });

  it('fails when ANY tool fires', () => {
    const r = verifyTurn(
      tmpl,
      turn({ toolCalls: [{ name: 'suggest_external_action', status: 'ok', summary: '' }] }),
    );
    expect(r.ok).toBe(false);
    const fail = r.failures.find((f) => f.code === 'unexpected-tool');
    expect(fail).toBeDefined();
    if (fail && fail.code === 'unexpected-tool') {
      expect(fail.got).toEqual(['suggest_external_action']);
    }
  });

  it('does NOT report wrong-tool when expectNoTool is set', () => {
    const r = verifyTurn(
      tmpl,
      turn({ toolCalls: [{ name: 'save_media', status: 'ok', summary: '' }] }),
    );
    expect(r.failures.some((f) => f.code === 'wrong-tool')).toBe(false);
  });

  it('still surfaces tool-error even when no tool was expected', () => {
    const r = verifyTurn(
      tmpl,
      turn({
        toolCalls: [{ name: 'save_media', status: 'error', summary: 'boom' }],
      }),
    );
    const errs = r.failures.map((f) => f.code);
    expect(errs).toContain('unexpected-tool');
    expect(errs).toContain('tool-error');
  });

  it('relaxes the assertion under mock mode', () => {
    const r = verifyTurn(
      tmpl,
      turn({ toolCalls: [{ name: 'save_media', status: 'ok', summary: '' }] }),
      { mock: true },
    );
    expect(r.failures.some((f) => f.code === 'unexpected-tool')).toBe(false);
  });
});

describe('verifyTurn — forbiddenTools', () => {
  it('reports forbidden-tool when a banned tool fires alongside the expected one', () => {
    const tmpl: ChordTemplate = {
      prompt: '@Chord show me recipes for biryani',
      expectTool: 'suggest_external_action',
      forbiddenTools: ['save_media', 'save_link'],
    };
    const r = verifyTurn(
      tmpl,
      turn({
        toolCalls: [
          { name: 'suggest_external_action', status: 'ok', summary: '' },
          { name: 'save_media', status: 'ok', summary: '' },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    const fbn = r.failures.filter((f) => f.code === 'forbidden-tool');
    expect(fbn).toHaveLength(1);
    if (fbn[0].code === 'forbidden-tool') expect(fbn[0].name).toBe('save_media');
  });

  it('passes when the expected tool fires and no forbidden tool fires', () => {
    const tmpl: ChordTemplate = {
      prompt: '@Chord show me recipes',
      expectTool: 'suggest_external_action',
      forbiddenTools: ['save_media'],
    };
    const r = verifyTurn(
      tmpl,
      turn({
        toolCalls: [{ name: 'suggest_external_action', status: 'ok', summary: '' }],
        cards: [{ kind: 'action', title: 'AllRecipes', url: 'https://www.allrecipes.com/search?q=x' }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('does not enforce forbiddenTools under mock mode', () => {
    const tmpl: ChordTemplate = {
      prompt: 'x',
      expectTool: 'suggest_external_action',
      forbiddenTools: ['save_media'],
    };
    const r = verifyTurn(
      tmpl,
      turn({
        toolCalls: [
          { name: 'suggest_external_action', status: 'ok', summary: '' },
          { name: 'save_media', status: 'ok', summary: '' },
        ],
      }),
      { mock: true },
    );
    expect(r.failures.some((f) => f.code === 'forbidden-tool')).toBe(false);
  });
});
