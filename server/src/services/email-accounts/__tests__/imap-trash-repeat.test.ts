import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Prod, 2026-10-27 12:53 UTC: the same IMAP email was trashed several times
 * a second apart; every repeat came back "imap trash move failed: Command
 * failed", shown as "could not move this message to Trash (the mailbox may
 * have no Trash folder)". The first move had already taken the message out
 * of the inbox, and moving a UID that is no longer there fails.
 */
const state = vi.hoisted(() => ({ inInbox: [] as number[], moves: 0, refuse: false }));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    usable = false;
    mailbox: unknown = false;
    on() {
      return this;
    }
    async connect() {
      this.usable = true;
    }
    async logout() {
      this.usable = false;
    }
    async getMailboxLock() {
      this.mailbox = { uidValidity: '1' };
      return { release() {} };
    }
    async list() {
      return [
        { path: 'Trash', specialUse: '\\Trash' },
        { path: 'Archive', specialUse: '\\Archive' },
      ];
    }
    async messageMove(range: string) {
      state.moves += 1;
      if (state.refuse) throw new Error('Command failed');
      const want = range.split(',').map(Number);
      if (!want.some((u) => state.inInbox.includes(u))) throw new Error('Command failed');
      state.inInbox = state.inInbox.filter((u) => !want.includes(u));
    }
    async search(query: { uid?: string }) {
      const want = (query.uid ?? '').split(',').map(Number);
      return state.inInbox.filter((u) => want.includes(u));
    }
  }
  return { ImapFlow: FakeImapFlow };
});

const { realImapApi } = await import('@/services/email-accounts/imap-api.js');

const auth = {
  host: 'imap.mail.yahoo.com',
  port: 993,
  smtpHost: 'smtp.mail.yahoo.com',
  smtpPort: 465,
  username: 'someone@yahoo.com',
  password: 'app-password',
};

describe('moving an IMAP message to Trash twice', () => {
  beforeEach(() => {
    state.inInbox = [101];
    state.moves = 0;
    state.refuse = false;
  });

  it('the repeat succeeds: the message has already left the inbox', async () => {
    expect(await realImapApi(auth).moveToTrash([101])).toBe(true);
    expect(await realImapApi(auth).moveToTrash([101])).toBe(true);
    expect(state.moves).toBe(2);
  });

  it('still fails when the message is still in the inbox', async () => {
    state.refuse = true;
    await expect(realImapApi(auth).moveToTrash([101])).rejects.toThrow('Command failed');
  });

  it('archiving a second time succeeds too', async () => {
    expect(await realImapApi(auth).setArchived([101], true)).toBe(true);
    expect(await realImapApi(auth).setArchived([101], true)).toBe(true);
  });
});
