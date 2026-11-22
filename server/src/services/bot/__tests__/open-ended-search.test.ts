/**
 * ADR 0262 — a request Chord cannot do itself gets a search card, not a
 * borrowed one. Prod 2026-10-16: "can you generate a picture for me of a boy
 * running" → "yes" produced a Google MAPS card for "boy running", because
 * `map` was the only kind that took a free-text term.
 */
import { describe, expect, it } from 'vitest';

import { buildExternalAction } from '@/services/bot/external-actions.js';
import { NATIVE_TOOL_PROMPT, TEXT_FENCE_TOOL_PROMPT, toolSchemas } from '@/services/bot/tools.js';

describe('suggest_external_action kind=search', () => {
  it('accepts the call the prod turn needed', () => {
    const r = toolSchemas.suggest_external_action.safeParse({
      kind: 'search',
      label: 'Search images',
      query: { q: 'boy running', searchType: 'images' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown search tab', () => {
    const r = toolSchemas.suggest_external_action.safeParse({
      kind: 'search',
      label: 'Search',
      query: { q: 'x', searchType: 'maps' },
    });
    expect(r.success).toBe(false);
  });

  it('builds a Google Images search, not Maps', () => {
    const r = buildExternalAction('search', { q: 'boy running', searchType: 'images' })!;
    const u = new URL(r.url);
    expect(u.hostname).toBe('www.google.com');
    expect(u.pathname).toBe('/search');
    expect(u.searchParams.get('q')).toBe('boy running');
    expect(u.searchParams.get('udm')).toBe('2');
    expect(r.provider).toBe('Google Images');
  });

  it.each([
    ['videos', 'tbm', 'vid', 'Google Videos'],
    ['news', 'tbm', 'nws', 'Google News'],
    ['shopping', 'tbm', 'shop', 'Google Shopping'],
  ] as const)('%s opens its own tab', (searchType, key, value, provider) => {
    const r = buildExternalAction('search', { q: 'lego castle', searchType })!;
    expect(new URL(r.url).searchParams.get(key)).toBe(value);
    expect(r.provider).toBe(provider);
  });

  it('defaults to a plain web search', () => {
    const r = buildExternalAction('search', { q: 'why is the sky blue' })!;
    const u = new URL(r.url);
    expect([...u.searchParams.keys()]).toEqual(['q']);
    expect(r.provider).toBe('Google');
  });

  it('builds nothing without terms', () => {
    expect(buildExternalAction('search', {})).toBeNull();
    expect(buildExternalAction('search', { q: '   ' })).toBeNull();
  });
});

describe('prompts — what Chord cannot do', () => {
  for (const [name, prompt] of [
    ['native', NATIVE_TOOL_PROMPT],
    ['text-fence', TEXT_FENCE_TOOL_PROMPT],
  ] as const) {
    it(`${name}: sends a cannot-do request to a search card and keeps map for places`, () => {
      expect(prompt).toMatch(/cannot do at all/);
      expect(prompt).toMatch(/generate or draw a picture/);
      expect(prompt).toMatch(/kind: 'search'/);
      expect(prompt).toMatch(/map is for a real place only|`map` is for a real place only/);
    });
  }
});
