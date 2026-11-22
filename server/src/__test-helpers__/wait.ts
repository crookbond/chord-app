/**
 * Wait for something to become true, instead of sleeping a fixed number of
 * milliseconds and hoping it already has. The deadline only decides how long a
 * FAILING test takes to say so; a passing one returns as soon as the condition
 * holds, however slow the machine. Returns whether it became true, so the
 * caller's own expect() reports what actually went wrong.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  deadlineMs = 10_000,
): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > stop) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
