import { describe, expect, it } from 'vitest';

import { describeNewMail } from '../new-mail-notify.js';

// The push body crosses Expo and APNs/FCM, so a subject or sender in it is
// mail content handed to third parties.
const one = [
  {
    id: 'emt_1',
    subject: 'Cancellation: your trip to Vail',
    from_name: 'American Express Travel',
    from_email: 'travel@amex.example',
    last_message_at: '2026-09-23T10:00:00.000Z',
  },
];
const three = [one[0]!, { ...one[0]!, id: 'emt_2' }, { ...one[0]!, id: 'emt_3' }];

describe('describeNewMail', () => {
  it('carries no sender or subject by default', () => {
    for (const threads of [one, three]) {
      const out = JSON.stringify(describeNewMail(threads, false));
      expect(out).not.toContain('Vail');
      expect(out).not.toContain('American Express');
      expect(out).not.toContain('amex');
    }
  });

  it('still says how many arrived', () => {
    expect(describeNewMail(three, false).title).toBe('3 new emails');
    expect(describeNewMail(one, false).title).toBe('New mail');
  });

  it('names the sender and subject only when the deployment opts in', () => {
    expect(describeNewMail(one, true)).toEqual({
      title: 'American Express Travel',
      body: 'Cancellation: your trip to Vail',
    });
    expect(describeNewMail(three, true).title).toBe('3 new emails');
  });
});
