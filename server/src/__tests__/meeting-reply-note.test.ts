/** ADR 0346 phase 6 - what the reply drafter is told about the thread's meeting. */
import { describe, expect, it } from 'vitest';

import { meetingReplyNote } from '@chord/kernel';

describe('meetingReplyNote', () => {
  it('says who sends the invite', () => {
    expect(meetingReplyNote({ state: 'agreed', inviteBy: 'them', facts: null, agreedText: 'Tue 11:00 AM' })).toMatch(
      /already agreed: Tue 11:00 AM.*THEY will send/,
    );
    expect(meetingReplyNote({ state: 'offered', inviteBy: 'me', facts: null })).toContain('user is the one sending');
    expect(meetingReplyNote({ state: 'offered', inviteBy: 'unknown', facts: null })).toContain('Nobody has said');
  });

  it('a link already there is the call; an assistant gets the invite job', () => {
    const note = meetingReplyNote({
      state: 'offered',
      inviteBy: 'unknown',
      facts: { format: 'video', offered: [], link: { provider: 'zoom', url: 'https://x' }, onBehalfOf: 'Omar' },
    });
    expect(note).toContain('assistant is arranging this for Omar');
    expect(note).toContain('never propose a different call link');
  });

  it('nothing for a cancelled meeting', () => {
    expect(meetingReplyNote({ state: 'cancelled', inviteBy: 'them', facts: null })).toBe('');
  });
});
