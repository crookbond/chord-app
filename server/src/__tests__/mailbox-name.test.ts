import { describe, expect, it } from 'vitest';

import { hasAnyMailbox, mailboxFilterIds } from '@chord/kernel';

describe('mailboxFilterIds', () => {
  // An Outlook-only account (Sign in with Microsoft) was shown a Gmail chip
  // beside its Outlook one, and the Gmail chip filtered to nothing.
  it('leaves out the Gmail entry when no Gmail is connected', () => {
    expect(mailboxFilterIds({ connected: false, accounts: [{ id: 'ema_crookbond' }] })).toEqual([
      'ema_crookbond',
    ]);
  });

  it('lists the Gmail first, then each attached mailbox', () => {
    expect(mailboxFilterIds({ connected: true, accounts: [{ id: 'ema_1' }, { id: 'ema_2' }] })).toEqual([
      'primary',
      'ema_1',
      'ema_2',
    ]);
    expect(mailboxFilterIds({ connected: true })).toEqual(['primary']);
  });

  it('is empty with no status yet', () => {
    expect(mailboxFilterIds(null)).toEqual([]);
  });
});

describe('hasAnyMailbox', () => {
  // The status a Sign-in-with-Microsoft account gets (ADR 0293): no Google
  // grant, one Outlook mailbox. The Email tab showed "Connect Gmail" over it.
  it('counts an Outlook mailbox with no primary Gmail', () => {
    expect(
      hasAnyMailbox({
        connected: false,
        accounts: [{ id: 'ema_1', provider: 'outlook', emailAddress: 'ownertest@hotmail.com' }],
      }),
    ).toBe(true);
  });

  it('counts the primary Gmail alone', () => {
    expect(hasAnyMailbox({ connected: true, accounts: [] })).toBe(true);
    expect(hasAnyMailbox({ connected: true })).toBe(true);
  });

  it('is false with no mailbox at all, or no status yet', () => {
    expect(hasAnyMailbox({ connected: false, accounts: [] })).toBe(false);
    expect(hasAnyMailbox({ connected: false })).toBe(false);
    expect(hasAnyMailbox(null)).toBe(false);
  });
});
