import { describe, expect, it } from 'vitest';

import {
  isAuthFailure,
  isTransientProviderFailure,
} from '@/services/email-accounts/imap-api.js';

/**
 * Only a real credential rejection may be classified as an auth failure: that
 * verdict flags the account `reconnect`, which the bulk sync paths skip and
 * which the UI can only clear by asking for the app password again. Yahoo
 * throttles with an auth-SHAPED error, so a loose reading makes the user
 * re-type a password that was never wrong.
 */
describe('imap auth-failure classification', () => {
  it('treats a genuine credential rejection as auth failure', () => {
    expect(isAuthFailure({ authenticationFailed: true, responseText: 'Invalid credentials' })).toBe(
      true,
    );
    expect(isAuthFailure({ responseText: '[AUTHENTICATIONFAILED] Invalid credentials' })).toBe(true);
    expect(isAuthFailure({ message: 'LOGIN failed' })).toBe(true);
    expect(isAuthFailure({ authenticationFailed: true })).toBe(true);
  });

  it('does not blame the password for a provider throttle', () => {
    // Yahoo sets authenticationFailed on its rate-limit response.
    expect(
      isAuthFailure({
        authenticationFailed: true,
        responseText: '[UNAVAILABLE] Temporary system problem. Please try again later.',
      }),
    ).toBe(false);
    expect(
      isAuthFailure({ authenticationFailed: true, responseText: 'Request is throttled' }),
    ).toBe(false);
    expect(isAuthFailure({ responseText: '[LIMIT] Too many simultaneous connections' })).toBe(
      false,
    );
  });

  it('does not blame the password for a network fault', () => {
    expect(isAuthFailure({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isAuthFailure({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })).toBe(false);
    expect(isAuthFailure({ message: 'Command timed out' })).toBe(false);
    // The old regex matched any message containing "login".
    expect(isAuthFailure({ message: 'LOGIN command timed out' })).toBe(false);
  });

  it('leaves unrelated errors unclassified', () => {
    expect(isAuthFailure(new Error('mailbox does not exist'))).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});

/**
 * `isAuthFailure` returning false covers "transient" AND "any ordinary bug", so
 * routes cannot use it to decide a status code. In prod Yahoo's
 * `[LIMIT] AUTHENTICATE Rate limit hit` reached the express handler as a 500
 * "unhandled error" — Chord blamed for someone else's throttle, and nothing the
 * client could act on.
 */
describe('transient provider failure', () => {
  it('recognises the throttle prod actually returned', () => {
    expect(
      isTransientProviderFailure({
        authenticationFailed: true,
        responseText: 'AUTHENTICATE Rate limit hit.',
      }),
    ).toBe(true);
    expect(isTransientProviderFailure({ responseText: '[LIMIT] Too many connections' })).toBe(true);
    expect(isTransientProviderFailure({ code: 'ECONNRESET' })).toBe(true);
  });

  it('is not the complement of isAuthFailure', () => {
    const dead = { authenticationFailed: true, responseText: 'Invalid credentials' };
    expect(isAuthFailure(dead)).toBe(true);
    expect(isTransientProviderFailure(dead)).toBe(false);

    // An ordinary bug is neither — it must keep reaching the 500 handler.
    const bug = new Error('cannot read properties of undefined');
    expect(isAuthFailure(bug)).toBe(false);
    expect(isTransientProviderFailure(bug)).toBe(false);
  });
});
