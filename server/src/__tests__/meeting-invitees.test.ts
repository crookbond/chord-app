/**
 * Who an email-suggested meeting invites (ADR 0315 addendum): addresses come
 * from the message headers, never from the model, and never include the
 * user's own mailboxes or a no-reply robot.
 */
import { describe, expect, it } from 'vitest';

import { meetingInvitees } from '@chord/kernel';

import { meetingInviteNoticeText } from '@/services/email/meeting-invite-notice.js';

describe('meetingInviteNoticeText', () => {
  const when = 'Thu, Nov 5, 10:00 AM';
  const asked = ['baker.irene@bcg.com'];

  it('names who the calendar invited', () => {
    expect(meetingInviteNoticeText('Call with Irene', when, asked, { invited: asked })).toBe(
      'Added "Call with Irene" (Thu, Nov 5, 10:00 AM) to your calendar and invited baker.irene@bcg.com. Open it to change the time or who is invited.',
    );
  });

  it('says plainly when nobody was invited, and why', () => {
    const text = meetingInviteNoticeText('Call with Irene', when, asked, { guestChange: 'provider_error' });
    expect(text).toContain('no invitations went out: your calendar refused the invitation');
    expect(text).not.toMatch(/ and invited /);
  });
});

const ME = ['ownertest@gmail.com', 'john@chordapp.ai'];
const reply = {
  from: 'Baker.Irene@bcg.com',
  to: ['ownertest@gmail.com'],
  cc: ['Wells.Meg@bcg.com', 'noreply@bcg.com'],
};

describe('meetingInvitees', () => {
  it('sender: just the person who wrote, lowercased', () => {
    expect(meetingInvitees('sender', reply, ME)).toEqual(['baker.irene@bcg.com']);
  });

  it('all: sender, then To and Cc, minus you and robots', () => {
    expect(meetingInvitees('all', reply, ME)).toEqual(['baker.irene@bcg.com', 'wells.meg@bcg.com']);
  });

  it('your own message: "sender" is the person you wrote to, never you', () => {
    const mine = { from: 'OWNertest@gmail.com', to: ['baker.irene@bcg.com'], cc: [] };
    expect(meetingInvitees('sender', mine, ME)).toEqual(['baker.irene@bcg.com']);
    expect(meetingInvitees('all', mine, ME)).toEqual(['baker.irene@bcg.com']);
  });

  it('drops malformed and repeated addresses', () => {
    const msg = { from: 'a@x.com', to: ['A@x.com', 'not an address', ''], cc: ['b@y.org'] };
    expect(meetingInvitees('all', msg, [])).toEqual(['a@x.com', 'b@y.org']);
  });
});
