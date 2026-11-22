import { describe, expect, it } from 'vitest';

import {
  DRAFT_AUTOSAVE_MAX_WAIT_MS,
  DRAFT_AUTOSAVE_QUIET_MS,
  draftAutosaveDelay,
} from '@chord/kernel';

describe('draftAutosaveDelay', () => {
  it('waits for a quiet spell after the first change', () => {
    expect(draftAutosaveDelay(null, 1_000)).toBe(DRAFT_AUTOSAVE_QUIET_MS);
  });

  it('saves someone typing without pausing once the oldest change is 30s old', () => {
    // A keystroke every 100ms resets a plain debounce forever; this never does.
    const start = 0;
    let t = start;
    let fired = false;
    while (t < 60_000) {
      const delay = draftAutosaveDelay(start, t);
      if (delay < 100) {
        fired = true;
        break;
      }
      t += 100;
    }
    expect(fired).toBe(true);
    expect(t).toBeLessThanOrEqual(DRAFT_AUTOSAVE_MAX_WAIT_MS);
  });

  it('saves at once when a change is already overdue', () => {
    expect(draftAutosaveDelay(0, DRAFT_AUTOSAVE_MAX_WAIT_MS + 5_000)).toBe(0);
  });
});
