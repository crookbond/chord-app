/**
 * `isWhereIsPrompt` — detects "where is X?" / "find X" / "directions
 * to X" question shapes so the bot-turn runner can trigger a
 * strict-mode retry when the LLM produces prose like "I opened X in
 * Maps" without actually calling `suggest_external_action`.
 */
import { describe, expect, it } from 'vitest';

import { isWhereIsPrompt } from '@/services/bot/bot.service.js';

describe('isWhereIsPrompt — matches', () => {
  it.each([
    'where is Dos Caminos?',
    'Where is Alice',
    "where's the closest pharmacy",
    'find my phone',
    'find where is Sam',
    'directions to JFK',
    'how do I get to Penn Station',
    'how do we get to the restaurant',
    'locate Ben',
  ])('matches: %s', (s) => {
    expect(isWhereIsPrompt(s)).toBe(true);
  });
});

describe('isWhereIsPrompt — does NOT match', () => {
  it.each([
    'add task to resolve bugs',
    'remind me tomorrow',
    'what should we have for dinner?',
    'I like that restaurant',
    'put on the calendar',
    'tell the Chord group about the change',
  ])('skips: %s', (s) => {
    expect(isWhereIsPrompt(s)).toBe(false);
  });
});
