/**
 * Load a package only when its native module is in this build (see
 * `loadOptionalNative` in kernel for why a try/catch is not enough).
 * `requireOptionalNativeModule` returns null for a missing module instead of
 * throwing, so asking costs nothing and cannot crash.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { loadOptionalNative } from '@chord/kernel';

export function nativeModuleInBuild(nativeName: string): boolean {
  return Platform.OS !== 'web' && requireOptionalNativeModule(nativeName) != null;
}

export function importIfNative<T>(nativeName: string, load: () => Promise<T>): Promise<T | null> {
  return loadOptionalNative(() => nativeModuleInBuild(nativeName), load);
}
