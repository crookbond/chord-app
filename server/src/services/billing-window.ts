/**
 * ADR 0231 — the allowance resets monthly even on an annual subscription.
 * A year's invoice covers twelve months but the 5M tokens are a MONTHLY
 * allowance, so "usage since the period started" would hand an annual
 * subscriber a year's worth up front. The window start is the latest
 * whole-month step from the period start that is not in the future; for a
 * monthly subscription (now inside the first month) it is the period start
 * itself, which is what ADR 0196 always used.
 */
function addMonthsUtc(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(d.getUTCDate(), lastDay),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

export function allowanceWindowStart(periodStartIso: string, now: Date = new Date()): string {
  const start = new Date(periodStartIso);
  if (!Number.isFinite(start.getTime())) return periodStartIso;
  let k = 0;
  // An annual period has at most twelve steps; the bound is a backstop.
  while (k < 36 && addMonthsUtc(start, k + 1).getTime() <= now.getTime()) k++;
  return addMonthsUtc(start, k).toISOString();
}

/** When the allowance next refills: one month after the current window began,
 *  but never past the end of the paid period (at that point it's a renewal,
 *  or nothing). */
export function nextAllowanceReset(
  periodStartIso: string,
  periodEndIso: string | null,
  now: Date = new Date(),
): string {
  const windowStart = new Date(allowanceWindowStart(periodStartIso, now));
  const next = addMonthsUtc(windowStart, 1);
  if (periodEndIso && Date.parse(periodEndIso) < next.getTime()) return periodEndIso;
  return next.toISOString();
}
