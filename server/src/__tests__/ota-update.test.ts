import { describe, expect, it } from 'vitest';

import {
  OTA_CHECK_MIN_GAP_MS,
  shouldCheckForUpdate,
  shouldShowUpdateBanner,
  updateDismissKey,
} from '@chord/kernel';

describe('shouldCheckForUpdate (ADR 0216)', () => {
  const launch = 1_000_000;

  it('does not check again right after the launch check', () => {
    expect(shouldCheckForUpdate(launch, launch + 60_000)).toBe(false);
  });

  it('checks once the gap has passed', () => {
    expect(shouldCheckForUpdate(launch, launch + OTA_CHECK_MIN_GAP_MS)).toBe(true);
  });
});

describe('shouldShowUpdateBanner (ADR 0216)', () => {
  it('stays hidden when nothing is downloaded', () => {
    expect(
      shouldShowUpdateBanner({ isUpdatePending: false, pendingUpdateId: 'u1', dismissedKey: null }),
    ).toBe(false);
  });

  it('shows a downloaded update', () => {
    expect(
      shouldShowUpdateBanner({ isUpdatePending: true, pendingUpdateId: 'u1', dismissedKey: null }),
    ).toBe(true);
  });

  it('"Later" hides that update, and a newer one asks again', () => {
    const dismissedKey = updateDismissKey('u1');
    expect(
      shouldShowUpdateBanner({ isUpdatePending: true, pendingUpdateId: 'u1', dismissedKey }),
    ).toBe(false);
    expect(
      shouldShowUpdateBanner({ isUpdatePending: true, pendingUpdateId: 'u2', dismissedKey }),
    ).toBe(true);
  });

  it('"Later" works even when the pending update has no id', () => {
    const dismissedKey = updateDismissKey(undefined);
    expect(
      shouldShowUpdateBanner({ isUpdatePending: true, pendingUpdateId: undefined, dismissedKey }),
    ).toBe(false);
  });
});
