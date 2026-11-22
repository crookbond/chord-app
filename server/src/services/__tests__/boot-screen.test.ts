/**
 * ADR 0254 - the root route must not show the sign-in page to someone who is
 * already signed in. Kernel has no harness of its own, so the rule is tested here.
 */
import { describe, expect, it } from 'vitest';

import { bootReturnPath, bootScreen, deviceMayHaveSession } from '@chord/kernel';

describe('bootReturnPath', () => {
  it('a web refresh of the Messages list comes back to it, not to Email', () => {
    // The real shape: /groups with no user loaded redirects to /?next=/groups,
    // and boot used to land on launchTab() (/email on the web) regardless.
    expect(bootReturnPath('/groups', '/email')).toBe('/groups');
  });

  it('falls back to the launch tab with nothing, or nothing in-app, to return to', () => {
    expect(bootReturnPath(undefined, '/email')).toBe('/email');
    expect(bootReturnPath(['/groups'], '/email')).toBe('/email');
    expect(bootReturnPath('https://evil.example', '/email')).toBe('/email');
    expect(bootReturnPath('//evil.example', '/email')).toBe('/email');
    expect(bootReturnPath('/\\evil.example', '/email')).toBe('/email');
    expect(bootReturnPath('/', '/email')).toBe('/email');
    expect(bootReturnPath('/?next=/groups', '/email')).toBe('/email');
  });
});

describe('bootScreen', () => {
  it('a device with a session holds a splash while the server answers, not the sign-in page', () => {
    // The real shape of the bug: token in storage, /health + /me still in flight.
    expect(bootScreen({ signedIn: false, hasToken: true, boot: 'pending' })).toBe('splash');
  });

  it('goes straight to the app once the server has said who it is', () => {
    expect(bootScreen({ signedIn: true, hasToken: true, boot: 'pending' })).toBe('app');
    expect(bootScreen({ signedIn: true, hasToken: true, boot: 'ready' })).toBe('app');
  });

  it('a token the server no longer honours ends on the landing page, not a spinner', () => {
    expect(bootScreen({ signedIn: false, hasToken: true, boot: 'ready' })).toBe('landing');
  });

  it('a server that cannot be reached lets the landing page explain it', () => {
    expect(bootScreen({ signedIn: false, hasToken: true, boot: 'offline' })).toBe('landing');
  });

  it('a visitor with no session sees the landing page at once, with no wait', () => {
    expect(bootScreen({ signedIn: false, hasToken: false, boot: 'pending' })).toBe('landing');
  });

  it('waits one beat for storage to answer rather than guessing', () => {
    expect(bootScreen({ signedIn: false, hasToken: null, boot: 'pending' })).toBe('splash');
  });
});

describe('bootScreen on the web, where the session cookie is invisible to the page', () => {
  it('holds the splash while /me is asked, though no token is stored', () => {
    // The web app no longer keeps a token, so "no token" says nothing there.
    expect(bootScreen({ signedIn: false, hasToken: false, boot: 'pending', web: true })).toBe('splash');
    expect(bootScreen({ signedIn: false, hasToken: null, boot: 'pending', web: true })).toBe('splash');
  });

  it('opens the app once /me answers with the cookie', () => {
    expect(bootScreen({ signedIn: true, hasToken: false, boot: 'pending', web: true })).toBe('app');
  });

  it('a visitor sees the landing page once /me said nobody is signed in', () => {
    expect(bootScreen({ signedIn: false, hasToken: false, boot: 'ready', web: true })).toBe('landing');
    expect(bootScreen({ signedIn: false, hasToken: false, boot: 'offline', web: true })).toBe('landing');
  });

  it('a phone still decides from its stored token', () => {
    expect(deviceMayHaveSession({ web: false, hasToken: false })).toBe(false);
    expect(deviceMayHaveSession({ web: false, hasToken: null })).toBe(null);
    expect(deviceMayHaveSession({ web: true, hasToken: false })).toBe(true);
  });
});
