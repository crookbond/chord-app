/**
 * Loading a package whose native half a build may lack (an OTA reaching an
 * app built before the package was added).
 *
 * A try/catch around `await import(pkg)` does NOT protect the app: the
 * package's own module throws while loading ("Cannot find native module"),
 * and Metro's loader reports a throw from a module that is loaded outside
 * another module's load as FATAL (`ErrorUtils.reportFatalError`) before the
 * caller's catch is reached. A release build closes. So the native module's
 * presence is asked first, through a call that cannot throw, and the package
 * is only loaded when it is there.
 */
export async function loadOptionalNative<T>(inBuild: () => boolean, load: () => Promise<T>): Promise<T | null> {
  let present = false;
  try {
    present = inBuild();
  } catch {
    present = false;
  }
  if (!present) return null;
  try {
    return await load();
  } catch {
    return null;
  }
}
