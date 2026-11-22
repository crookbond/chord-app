/**
 * ADR 0311 - the app with no network. Kernel has no harness of its own, so the
 * rules are tested here.
 */
import { describe, expect, it } from 'vitest';

import {
  bootScreen,
  enterWithSavedUser,
  fetchFailedOffline,
  isNetworkFailure,
  meCheckSettled,
  REQUEST_TIMEOUT_MS,
  requestTimeoutMs,
  meOutcomeForStatus,
  offlineProbeDelay,
  openFromSavedUserAtLaunch,
  aiConsentKnownAtLaunch,
} from '@chord/kernel';

describe('enterWithSavedUser', () => {
  it('airplane mode at launch opens the app as the saved user, not the sign-in page', () => {
    // The reported shape: token on the device, /health and /me both fail to
    // reach the server. Before, the launch fell through to the landing page.
    expect(bootScreen({ signedIn: false, hasToken: true, boot: 'offline' })).toBe('landing');
    expect(enterWithSavedUser({ hasToken: true, outcome: 'unreachable', hasSavedUser: true })).toBe(true);
  });

  it('a session the server rejected never opens the app from the saved copy', () => {
    expect(enterWithSavedUser({ hasToken: true, outcome: 'rejected', hasSavedUser: true })).toBe(false);
  });

  it('needs both a session and a saved user', () => {
    expect(enterWithSavedUser({ hasToken: false, outcome: 'unreachable', hasSavedUser: true })).toBe(false);
    expect(enterWithSavedUser({ hasToken: true, outcome: 'unreachable', hasSavedUser: false })).toBe(false);
  });

  it('on the web a saved user and no server opens offline, though no token is stored', () => {
    expect(enterWithSavedUser({ hasToken: false, outcome: 'unreachable', hasSavedUser: true, web: true })).toBe(true);
    expect(enterWithSavedUser({ hasToken: false, outcome: 'rejected', hasSavedUser: true, web: true })).toBe(false);
    expect(enterWithSavedUser({ hasToken: false, outcome: 'unreachable', hasSavedUser: false, web: true })).toBe(false);
  });
});

describe('openFromSavedUserAtLaunch', () => {
  it('a phone back after a long time opens from the saved user, without waiting on the server', () => {
    // The reported shape: token + saved user on the device, server not yet
    // answered. Before, the launch held a spinner until /health, /me and the
    // consent check returned.
    expect(bootScreen({ signedIn: false, hasToken: true, boot: 'pending' })).toBe('splash');
    expect(openFromSavedUserAtLaunch({ hasToken: true, hasSavedUser: true })).toBe(true);
  });

  it('never without a saved user, and never without a session on a phone', () => {
    expect(openFromSavedUserAtLaunch({ hasToken: true, hasSavedUser: false })).toBe(false);
    expect(openFromSavedUserAtLaunch({ hasToken: false, hasSavedUser: true })).toBe(false);
  });

  it('the web opens from its saved user too (the cookie cannot be read)', () => {
    expect(openFromSavedUserAtLaunch({ hasToken: false, hasSavedUser: true, web: true })).toBe(true);
    expect(openFromSavedUserAtLaunch({ hasToken: false, hasSavedUser: false, web: true })).toBe(false);
  });
});

describe('aiConsentKnownAtLaunch', () => {
  it('skips the consent round trip only for the user this device saw agree', () => {
    expect(aiConsentKnownAtLaunch({ userId: 'u1', agreedUserId: 'u1' })).toBe(true);
    expect(aiConsentKnownAtLaunch({ userId: 'u1', agreedUserId: 'u2' })).toBe(false);
    expect(aiConsentKnownAtLaunch({ userId: 'u1', agreedUserId: null })).toBe(false);
  });
});

describe('meOutcomeForStatus', () => {
  it('only 401/403 mean the session is over', () => {
    expect(meOutcomeForStatus(401)).toBe('rejected');
    expect(meOutcomeForStatus(403)).toBe('rejected');
    expect(meOutcomeForStatus(500)).toBe('unreachable');
    expect(meOutcomeForStatus(502)).toBe('unreachable');
  });
});

describe('isNetworkFailure', () => {
  it('recognises a request that never left the device, on every runtime', () => {
    for (const m of [
      'Network request failed',
      'Network request timed out',
      'Failed to fetch',
      'Load failed',
      'NetworkError when attempting to fetch resource.',
    ]) {
      expect(isNetworkFailure(new TypeError(m))).toBe(true);
    }
  });

  it('a server error or a bug is not "offline"', () => {
    expect(isNetworkFailure(new Error('not signed in'))).toBe(false);
    expect(isNetworkFailure(new Error('Failed to fetch'))).toBe(false); // not a TypeError
    expect(isNetworkFailure(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe('offlineProbeDelay', () => {
  it('checks after 5s, doubling to a minute, never faster than the old SSE storm', () => {
    expect(offlineProbeDelay(0)).toBe(5_000);
    expect(offlineProbeDelay(1)).toBe(10_000);
    expect(offlineProbeDelay(3)).toBe(40_000);
    expect(offlineProbeDelay(4)).toBe(60_000);
    expect(offlineProbeDelay(50)).toBe(60_000);
  });
});

describe('fetchFailedOffline', () => {
  // How each runtime reports an aborted fetch.
  const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });

  it('a request the app gave up on after a stalled connection counts as no network', () => {
    // The reported shape: Android, a connection that never answers. Before, the
    // abort was not a network failure, so the send queue and the screen waited
    // on it forever while the app still thought it was online.
    expect(fetchFailedOffline({ error: abort, timedOut: true })).toBe(true);
  });

  it('a request the caller cancelled is not a network problem', () => {
    expect(fetchFailedOffline({ error: abort, timedOut: false })).toBe(false);
  });

  it('a network failure is still one', () => {
    expect(
      fetchFailedOffline({ error: new TypeError('Network request failed'), timedOut: false }),
    ).toBe(true);
  });
});

describe('requestTimeoutMs', () => {
  it('reads wait 25s, writes a minute, the slow ones two', () => {
    expect(requestTimeoutMs({})).toBe(REQUEST_TIMEOUT_MS);
    expect(requestTimeoutMs({ method: 'get' })).toBe(25_000);
    expect(requestTimeoutMs({ method: 'POST' })).toBe(60_000);
    expect(requestTimeoutMs({ method: 'POST', long: true })).toBe(120_000);
  });
});

describe('meCheckSettled', () => {
  it('a re-check of the saved session that got no answer is asked again', () => {
    // The reported shape: opened offline as the saved user, the network came
    // back, /me still could not reach the server - and it was never re-asked,
    // so a session the server had ended stayed open on the phone.
    expect(meCheckSettled('unreachable')).toBe(false);
  });

  it('an answer about the session ends the re-checking', () => {
    expect(meCheckSettled('signed-in')).toBe(true);
    expect(meCheckSettled('rejected')).toBe(true);
  });
});
