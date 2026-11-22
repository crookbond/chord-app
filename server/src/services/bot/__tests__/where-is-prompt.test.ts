/**
 * Guardrail tests on the "where is X?" prompt guidance.
 *
 * Both the native and text-fence prompts must instruct the model to
 * actually call `suggest_external_action` (not hallucinate "I opened X
 * in Maps for you") and route person vs. place correctly. These tests
 * lock the wording so future prompt edits don't accidentally drop the
 * mandatory-call clause or the anti-confabulation guardrail that the
 * 2026-05-12 regression revealed.
 */
import { describe, expect, it } from 'vitest';

import { NATIVE_TOOL_PROMPT, TEXT_FENCE_TOOL_PROMPT } from '@/services/bot/tools.js';

describe('NATIVE_TOOL_PROMPT — where is X routing', () => {
  it('mentions the find_person branch with kind="find_person"', () => {
    expect(NATIVE_TOOL_PROMPT).toMatch(/find_person/);
    expect(NATIVE_TOOL_PROMPT).toMatch(/Find My/);
  });

  it('mentions the map branch with kind="map"', () => {
    expect(NATIVE_TOOL_PROMPT).toMatch(/kind: 'map'/);
    expect(NATIVE_TOOL_PROMPT).toMatch(/Open in Maps/);
  });

  it('declares the tool call mandatory', () => {
    expect(NATIVE_TOOL_PROMPT).toMatch(/mandatory|MANDATORY|must call/i);
  });

  it('includes the anti-confabulation guardrail', () => {
    // The exact phrase varies; check for an explicit "do not claim" + a
    // recognisable confabulation phrase.
    expect(NATIVE_TOOL_PROMPT).toMatch(/ANTI-CONFABULATION|may NOT write|do not claim/i);
    expect(NATIVE_TOOL_PROMPT).toMatch(/I opened|I pulled up|here's the map/i);
  });
});

describe('TEXT_FENCE_TOOL_PROMPT — where is X routing', () => {
  it('mentions both branches', () => {
    expect(TEXT_FENCE_TOOL_PROMPT).toMatch(/find_person/);
    expect(TEXT_FENCE_TOOL_PROMPT).toMatch(/kind: 'map'/);
  });

  it('warns against the "I opened in Maps" confabulation', () => {
    expect(TEXT_FENCE_TOOL_PROMPT).toMatch(/I opened|emitted the tool|no tool, no card/i);
  });
});
