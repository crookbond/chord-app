/**
 * The bot has no tool for .ics / flight-PDF / hotel-PDF / movie-poster
 * imports — those run server-side in trip_classifier on saveFile().
 * Without an explicit prompt section the LLM apologizes ("I can't add
 * calendar files to your calendar") while the server is silently doing
 * exactly that in parallel. The prompt has to forbid the apology and
 * point the bot at acknowledge-and-summarize behaviour.
 */
import { describe, expect, it } from 'vitest';

import { NATIVE_TOOL_PROMPT, TEXT_FENCE_TOOL_PROMPT } from '@/services/bot/tools.js';

describe('Auto-ingest guidance — NATIVE_TOOL_PROMPT', () => {
  it('names the file types that auto-ingest server-side', () => {
    expect(NATIVE_TOOL_PROMPT).toMatch(/\.ics|text\/calendar/i);
    expect(NATIVE_TOOL_PROMPT).toMatch(/flight/i);
    expect(NATIVE_TOOL_PROMPT).toMatch(/hotel/i);
  });

  it('forbids the "I can\'t add calendar files" confabulation', () => {
    expect(NATIVE_TOOL_PROMPT).toMatch(/I can't directly add calendar files|I can't import \.ics|I don't have a tool/i);
    expect(NATIVE_TOOL_PROMPT).toMatch(/confabulation|server actually does this|the server already/i);
  });

  it('coaches an acknowledge-then-summarize shape', () => {
    expect(NATIVE_TOOL_PROMPT).toMatch(/acknowledge|Importing the calendar|appear (?:in your calendar )?shortly|appear momentarily/i);
  });
});

describe('Auto-ingest guidance — TEXT_FENCE_TOOL_PROMPT', () => {
  it('mirrors the auto-ingest section into the text-fence variant', () => {
    expect(TEXT_FENCE_TOOL_PROMPT).toMatch(/\.ics|text\/calendar/i);
    expect(TEXT_FENCE_TOOL_PROMPT).toMatch(/I can't directly add calendar files|I can't import \.ics|I don't have a tool/i);
  });

  it('reinforces the historical-dates-stay-historical rule on the fence side too', () => {
    expect(TEXT_FENCE_TOOL_PROMPT).toMatch(/historical dates stay historical|do not re-root past years/i);
  });
});
