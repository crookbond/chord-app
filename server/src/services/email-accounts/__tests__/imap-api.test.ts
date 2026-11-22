import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two IMAP writes against a faked imapflow: the ADR 0303 draft copy on a
 * server without UIDPLUS, and the ADR 0309 filing folder lookup.
 */
const state = vi.hoisted(() => ({
  capabilities: new Map<string, boolean>(),
  appends: [] as string[],
  boxes: [] as { path: string; name: string; delimiter: string; specialUse?: string }[],
  created: [] as string[],
  moves: [] as { range: string; path: string }[],
  namespace: { prefix: '', delimiter: '/' },
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    usable = false;
    mailbox: unknown = false;
    get capabilities() {
      return state.capabilities;
    }
    get namespace() {
      return state.namespace;
    }
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
      this.mailbox = { uidValidity: '7' };
      return { release() {} };
    }
    async list() {
      return state.boxes;
    }
    async append(path: string) {
      state.appends.push(path);
      // No UIDPLUS: the server files the copy and says nothing about where.
      return state.capabilities.has('UIDPLUS') ? { uid: state.appends.length, uidValidity: 7n } : {};
    }
    async mailboxCreate(path: string) {
      const full = state.namespace.prefix + path;
      state.created.push(full);
      state.boxes.push({ path: full, name: path, delimiter: state.namespace.delimiter });
      return { path: full };
    }
    async messageMove(range: string, path: string) {
      state.moves.push({ range, path });
      return true;
    }
    async messageDelete() {
      return true;
    }
    async search() {
      return [];
    }
  }
  return { ImapFlow: FakeImapFlow };
});

const { realImapApi } = await import('@/services/email-accounts/imap-api.js');

const auth = {
  host: 'imap.example.net',
  port: 993,
  smtpHost: 'smtp.example.net',
  smtpPort: 465,
  username: 'someone@example.net',
  password: 'app-password',
};

beforeEach(() => {
  state.capabilities = new Map();
  state.appends.length = 0;
  state.created.length = 0;
  state.moves.length = 0;
  state.namespace = { prefix: '', delimiter: '/' };
  state.boxes = [{ path: 'Drafts', name: 'Drafts', delimiter: '/', specialUse: '\\Drafts' }];
});

describe('saveDraft without UIDPLUS', () => {
  it('appends nothing, however often the pass retries', async () => {
    const api = realImapApi(auth);
    for (let i = 0; i < 3; i++) {
      await api.saveDraft!('Subject: x\r\n\r\nbody', null).catch(() => null);
    }
    expect(state.appends).toEqual([]);
  });

  it('reports the mailbox as unable to hold a copy instead of failing', async () => {
    expect(await realImapApi(auth).saveDraft!('Subject: x\r\n\r\nbody', null)).toBeNull();
  });

  it('still files one copy on a server that has it', async () => {
    state.capabilities.set('UIDPLUS', true);
    const ref = await realImapApi(auth).saveDraft!('Subject: x\r\n\r\nbody', null);
    expect(state.appends).toEqual(['Drafts']);
    expect(JSON.parse(ref as string)).toMatchObject({ path: 'Drafts', uid: 1, uidValidity: '7' });
  });
});

describe('moveToFolder', () => {
  it('does not file into a nested folder that shares the leaf name', async () => {
    state.boxes.push({ path: 'Work/Receipts', name: 'Receipts', delimiter: '/' });
    await realImapApi(auth).moveToFolder([5], 'Receipts');
    expect(state.created).toEqual(['Receipts']);
    expect(state.moves).toEqual([{ range: '5', path: 'Receipts' }]);
  });

  it('uses an existing top-level folder in any case', async () => {
    state.boxes.push({ path: 'receipts', name: 'receipts', delimiter: '/' });
    await realImapApi(auth).moveToFolder([5], 'Receipts');
    expect(state.created).toEqual([]);
    expect(state.moves[0]!.path).toBe('receipts');
  });

  it('finds the top-level folder under a personal namespace prefix', async () => {
    state.namespace = { prefix: 'INBOX.', delimiter: '.' };
    state.boxes.push(
      { path: 'INBOX.Work.Receipts', name: 'Receipts', delimiter: '.' },
      { path: 'INBOX.Receipts', name: 'Receipts', delimiter: '.' },
    );
    await realImapApi(auth).moveToFolder([5], 'Receipts');
    expect(state.created).toEqual([]);
    expect(state.moves[0]!.path).toBe('INBOX.Receipts');
  });
});
