/**
 * Diagnostic: CHORD_TEST_NOW=<ISO instant> moves the JS clock of every test
 * worker to that instant (it keeps ticking from there). Run the suite at an
 * awkward moment - the night before a clock change, 23:30 in New York on
 * 31 December - and a test that only passes on ordinary days fails today
 * instead of on that day. Postgres now() is not moved, so a failure that
 * compares a database time with a JS time can be the probe, not the test.
 */
const target = process.env.CHORD_TEST_NOW;

if (target) {
  const RealDate = Date;
  const offset = new RealDate(target).getTime() - RealDate.now();
  if (!Number.isFinite(offset)) throw new Error(`CHORD_TEST_NOW is not a date: ${target}`);

  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
