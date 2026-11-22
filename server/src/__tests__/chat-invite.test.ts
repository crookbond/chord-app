import { describe, expect, it } from 'vitest';

import { inviteOutcomeText } from '@chord/kernel';

describe('inviteOutcomeText (ADR 0318)', () => {
  it('never says an email went when it did not', () => {
    const notSent = inviteOutcomeText({ status: 'emailed', groupId: 'g', email: 'no_mailbox', link: 'x' }, 'a@b.com');
    expect(notSent).toContain('no email could be sent');
    expect(inviteOutcomeText({ status: 'emailed', groupId: 'g', email: 'failed', link: 'x' }, 'a@b.com')).toBe(notSent);
    expect(inviteOutcomeText({ status: 'emailed', groupId: 'g', email: 'queued', link: 'x' }, 'a@b.com')).toContain(
      'Invite emailed to a@b.com',
    );
  });

  it('names who is in and who still has to accept', () => {
    expect(inviteOutcomeText({ status: 'added', groupId: 'g', name: 'Priya' }, 'p@x.com')).toBe('Priya is in the chat.');
    expect(inviteOutcomeText({ status: 'asked', groupId: null, name: 'Priya' }, 'p@x.com')).toContain('to accept');
  });
});
