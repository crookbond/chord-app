/**
 * Prod, 26 Oct (after the PR 171 OTA): tapping the Email tab closed the iPhone
 * app. The tab asks whether the phone keeps mail (`deviceMailReady`), which
 * lazily loaded `expo-secure-store` inside a try/catch. The installed build
 * predates that package's native module, so the package's own module threw
 * "Cannot find native module 'ExpoSecureStore'" while loading - and Metro's
 * loader reports a throw from a module loaded outside another module's load as
 * FATAL before the caller's catch runs. These tests run Metro's real loader.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { loadOptionalNative } from '@chord/kernel';

const metroRequireSource = readFileSync(
  join(dirname(createRequire(import.meta.url).resolve('metro-runtime/package.json')), 'src/polyfills/require.js'),
  'utf8',
);

const SECURE_STORE = 7;

/** Metro's module loader as a release build runs it, with expo-secure-store missing its native half. */
function releaseApp() {
  const fatal: Error[] = [];
  const ctx: Record<string, unknown> = {
    __DEV__: false,
    __METRO_GLOBAL_PREFIX__: '',
    ErrorUtils: { reportFatalError: (e: Error) => fatal.push(e) },
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(metroRequireSource, ctx);
  (ctx.__d as (factory: () => void, id: number, deps: number[]) => void)(() => {
    // expo-secure-store/build/ExpoSecureStore.js: requireNativeModule('ExpoSecureStore')
    throw new Error("Cannot find native module 'ExpoSecureStore'");
  }, SECURE_STORE, []);
  const metroRequire = ctx.__r as (id: number) => unknown;
  return { fatal, importSecureStore: () => Promise.resolve().then(() => metroRequire(SECURE_STORE)) };
}

describe('loading a package whose native module the build lacks', () => {
  it('is fatal even inside try/catch (the Email tab crash)', async () => {
    const app = releaseApp();
    let caught = false;
    // The shape PR 171 shipped: `try { await import('expo-secure-store') } catch {}`.
    try {
      await app.importSecureStore();
    } catch {
      caught = true;
    }
    expect(app.fatal.map((e) => e.message)).toEqual(["Cannot find native module 'ExpoSecureStore'"]);
    expect(caught).toBe(false);
  });

  it('is never loaded when the build lacks the module, so nothing is fatal', async () => {
    const app = releaseApp();
    const got = await loadOptionalNative(() => false, app.importSecureStore);
    expect(got).toBeNull();
    expect(app.fatal).toEqual([]);
  });

  it('is loaded when the module is in the build', async () => {
    expect(await loadOptionalNative(() => true, async () => 'module')).toBe('module');
  });

  it('treats a presence check that throws as absent, and a failed load as null', async () => {
    const app = releaseApp();
    const check = () => {
      throw new Error('no expo runtime');
    };
    expect(await loadOptionalNative(check, app.importSecureStore)).toBeNull();
    expect(app.fatal).toEqual([]);
    expect(await loadOptionalNative(() => true, () => Promise.reject(new Error('x')))).toBeNull();
  });
});
