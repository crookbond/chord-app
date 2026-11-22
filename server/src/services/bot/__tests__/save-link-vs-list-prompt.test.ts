/**
 * Guardrail tests on the "list vs save" prompt guidance (ADR 0290).
 *
 * A list is for things you tick off; a place, recipe, link to keep, book or
 * contact is kept, so it is a save — even when the user says "add X to my
 * restaurant list". The old rule sent any named destination to a list, which
 * is how a family's restaurants ended up on a list the bot then could not
 * move. These lock the wording so a prompt edit doesn't silently drop it.
 */
import { describe, expect, it } from 'vitest';

import { NATIVE_TOOL_PROMPT, TEXT_FENCE_TOOL_PROMPT } from '@/services/bot/tools.js';

describe.each([
  ['NATIVE_TOOL_PROMPT', NATIVE_TOOL_PROMPT],
  ['TEXT_FENCE_TOOL_PROMPT', TEXT_FENCE_TOOL_PROMPT],
])('%s — lists vs saves', (_name, prompt) => {
  it('says lists are for ticking off and kept things are saves', () => {
    expect(prompt).toMatch(/tick (it )?off/i);
    expect(prompt).toMatch(/save_place/);
    expect(prompt).toMatch(/add_list_item/);
  });

  it('sends a named destination for a kept thing to a save with that tag, not a list', () => {
    expect(prompt).toMatch(/to my\*{0,2} <name> list/i);
    expect(prompt).toMatch(/tags=\[<name>\]/);
    expect(prompt).not.toMatch(/NOT grouped by tag in the UI/);
  });

  it('moves a whole list with one move_list_to_saves call, never one save per item', () => {
    expect(prompt).toMatch(/move_list_to_saves/);
    expect(prompt).toMatch(/never one (`?save_place`?|save) per item/i);
  });

  it('handles two-turn categorization by saving again with the tag', () => {
    expect(prompt).toMatch(/Two-turn categorization/);
    expect(prompt).toMatch(/tags=\[<category>\]/);
  });
});
