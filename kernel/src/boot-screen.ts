/**
 * ADR 0254 - what the root route shows while the app works out who is there.
 *
 * It used to show the marketing page and sign-in card from the first frame and
 * only switch once `/health` and then `/me` had both answered, so a person who
 * was already signed in watched the sign-in page every time they opened the
 * app. A session token on the device is the cheap, local hint that someone is
 * probably signed in: hold a plain splash until the server says whether the
 * token still holds, and show the landing page at once to anyone without one.
 */
export type BootScreen = 'splash' | 'app' | 'landing';

export function bootScreen(a: {
  /** The server has confirmed who this is. */
  signedIn: boolean;
  /** A session token is stored on this device; null = not read yet. */
  hasToken: boolean | null;
  /** The boot check (`/health`, `/me`) - pending until it has finished. */
  boot: 'pending' | 'ready' | 'offline';
  /**
   * The web app: its session is an httpOnly cookie page script cannot see,
   * so there is no local hint and only `/me` can say who is there.
   */
  web?: boolean;
}): BootScreen {
  if (a.signedIn) return 'app';
  const hint = deviceMayHaveSession({ web: a.web ?? false, hasToken: a.hasToken });
  if (hint === null) return 'splash';
  if (hint && a.boot === 'pending') return 'splash';
  return 'landing';
}

/**
 * Could someone be signed in on this device? A phone answers from the token
 * it stores (null until storage has been read); the web app cannot know
 * without asking the server, so it always says maybe.
 */
export function deviceMayHaveSession(a: { web: boolean; hasToken: boolean | null }): boolean | null {
  if (a.web) return true;
  return a.hasToken;
}

/**
 * Where the root route sends a signed-in user once boot is done: back to the
 * screen that sent them here to be signed in (a web refresh of /groups starts
 * with no user loaded), else the launch tab. Only an in-app path counts -
 * never another site, never back to the root route itself.
 */
export function bootReturnPath(next: unknown, fallback: string): string {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  if (next === '/' || next.startsWith('/?')) return fallback;
  return next;
}
