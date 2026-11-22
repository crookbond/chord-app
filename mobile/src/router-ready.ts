import { router } from 'expo-router';

/**
 * Run a router call from an effect that fires when a screen first mounts.
 * After a full page load (a redirect back from Stripe or OpenRouter), that
 * effect runs before the root navigator is ready, and expo-router throws
 * "Attempted to navigate before mounting the Root Layout component"; the throw
 * lands in the error boundary, so the user sees "Something went wrong" for
 * something that worked. This tries again every 100ms, for up to 2 seconds.
 */
export function whenRouterReady(go: () => void): void {
  let tries = 0;
  const attempt = () => {
    try {
      go();
    } catch {
      if (++tries < 20) setTimeout(attempt, 100);
    }
  };
  attempt();
}

/**
 * Drop query params a return redirect added (`?byok=`, `?checkout=`) without
 * leaving the screen: `router.replace` to the same path mounts a fresh copy of
 * it, which loses whatever the first copy was about to show.
 */
export function clearParamsWhenReady(names: string[]): void {
  whenRouterReady(() => router.setParams(Object.fromEntries(names.map((n) => [n, undefined]))));
}
