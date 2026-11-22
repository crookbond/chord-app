import { describe, expect, it } from 'vitest';

import { calendarNamesSaidIn } from '../calendar-mention.js';

/**
 * These are candidates only: the caller keeps one when one of the user's own
 * calendars answers to it (ADR 0347), so a word that names no calendar of
 * theirs ("Google" for someone with none called that) does nothing.
 */
describe('calendarNamesSaidIn', () => {
  it.each([
    ['add to Neural Calendar - Call with Gautam @ A91 at 830a. Teams meeting.', ['Neural']],
    ['put it on my work calendar', ['work']],
    ['add lunch to the Family calendar', ['Family']],
    ['call on Thursday to Neural calendar', ['Neural']],
    ['add to Neural Magic calendar', ['Neural Magic', 'Magic']],
    ['add it to my calendar', []],
    ['add dinner to calendar', []],
    ["add haircut to John's calendar", []],
    ['send a calendar invite', []],
    ['what is on my calendar today', []],
    // Prod 2026-11-17: "from" in front, and a name at the very start.
    ['From Rudderstack calendar - send a calendar invite for 2p EST to arthur@optizent.com. add google meet', ['Rudderstack']],
    ['Rudderstack calendar: invite arthur@optizent.com at 2', ['Rudderstack']],
    ['On Rudderstack Calendar- add to calendar invite for 2p EST add google meet', ['Rudderstack']],
  ])('%s', (text, want) => {
    expect(calendarNamesSaidIn(text)).toEqual(want);
  });
});
