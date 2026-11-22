/**
 * ADR 0346 phase 7 - several people, several times: the times that suit
 * everyone who has answered, in code.
 */
import { describe, expect, it } from 'vitest';

import { commonTimes, type PersonOffer, type SlotFact } from '@chord/kernel';

const ET = 'America/New_York';
const DAY = '2026-12-01'; // a Tuesday
const NOW = Date.parse('2026-11-25T12:00:00Z');
const slot = (minutes: number | undefined, endMinutes?: number, timeZone?: string, day = DAY): SlotFact => ({
  text: 'x',
  day,
  ...(minutes !== undefined ? { minutes } : {}),
  ...(endMinutes !== undefined ? { endMinutes } : {}),
  ...(timeZone ? { timeZone } : {}),
});
const offer = (person: string, offered: SlotFact[], unavailable: SlotFact[] = []): PersonOffer => ({ person, offered, unavailable });
const etHour = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });

describe('commonTimes', () => {
  it('Rob 10-1 and Sam 11-3 meet at 11-1', () => {
    const ct = commonTimes([offer('rob@a', [slot(600, 780)]), offer('sam@b', [slot(660, 900)])], { userZone: ET, nowMs: NOW });
    expect(ct.windows.map((w) => [etHour(w.startMs), etHour(w.endMs)])).toEqual([['11:00 AM', '1:00 PM']]);
    expect(ct.best).toBeUndefined();
  });

  it('each window is read on its own clock', () => {
    // 10-1 PT is 1-4 ET; with 2-4 ET that is 2-4 ET.
    const ct = commonTimes([offer('rob@a', [slot(600, 780, 'America/Los_Angeles')]), offer('kim@c', [slot(840, 960)])], {
      userZone: ET,
      nowMs: NOW,
    });
    expect(ct.windows.map((w) => [etHour(w.startMs), etHour(w.endMs)])).toEqual([['2:00 PM', '4:00 PM']]);
  });

  it('names who has not answered', () => {
    const ct = commonTimes([offer('rob@a', [slot(600, 780)]), offer('sam@b', [slot(660, 900)])], {
      userZone: ET,
      nowMs: NOW,
      corePeople: ['rob@a', 'sam@b', 'Kim@c'],
    });
    expect(ct.waiting).toEqual(['kim@c']);
  });

  it('"not Tuesday" from someone who offered nothing else still rules Tuesday out', () => {
    const ct = commonTimes([offer('rob@a', [slot(600, 780)]), offer('sam@b', [slot(660, 900)]), offer('kim@c', [], [slot(undefined)])], {
      userZone: ET,
      nowMs: NOW,
    });
    expect(ct.windows).toEqual([]);
  });

  it('"any time Wednesday" is their working day', () => {
    const wed = '2026-12-02';
    const ct = commonTimes([offer('rob@a', [slot(900, 960, undefined, wed)]), offer('sam@b', [slot(undefined, undefined, undefined, wed)])], {
      userZone: ET,
      nowMs: NOW,
    });
    expect(ct.windows.map((w) => etHour(w.startMs))).toEqual(['3:00 PM']);
  });

  it('with no time for everyone, the one most can make, naming who it does not suit', () => {
    const ct = commonTimes(
      [offer('rob@a', [slot(600, 660)]), offer('sam@b', [slot(840, 900)]), offer('kim@c', [slot(600, 660)])],
      { userZone: ET, nowMs: NOW },
    );
    expect(ct.windows).toEqual([]);
    expect(ct.best).toMatchObject({ who: ['rob@a', 'kim@c'], missing: ['sam@b'] });
    expect(etHour(ct.best!.startMs)).toBe('10:00 AM');
  });

  it('a window shorter than the meeting does not count, and the past is gone', () => {
    const short = commonTimes([offer('rob@a', [slot(600, 630)]), offer('sam@b', [slot(600, 660)])], { userZone: ET, nowMs: NOW });
    expect(short.windows).toEqual([]);
    const past = commonTimes([offer('rob@a', [slot(600, 780)]), offer('sam@b', [slot(600, 780)])], {
      userZone: ET,
      nowMs: Date.parse('2026-12-02T00:00:00Z'),
    });
    expect(past.windows).toEqual([]);
  });
});
