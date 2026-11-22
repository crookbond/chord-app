import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * IMAP is a stateful session protocol, and on Yahoo the LOGIN rate is the
 * throttled metric — so connection count per unit of work is the property
 * worth pinning, not just the returned data (ADR 0080).
 */
const state = vi.hoisted(() => ({
  connects: 0,
  instances: [] as { usable: boolean }[],
}));

vi.mock('imapflow', () => {
  class FakeImapFlow {
    usable = false;
    mailbox: unknown = false;
    constructor() {
      state.instances.push(this);
    }
    on() {
      return this;
    }
    async connect() {
      state.connects += 1;
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
      return [{ path: 'Trash', specialUse: '\\Trash' }];
    }
    async search() {
      return [];
    }
    async *fetch() {
      // no messages — the tests count connections, not payloads
    }
  }
  return { ImapFlow: FakeImapFlow };
});

const { realImapApi, withRealImapSession } = await import('@/services/email-accounts/imap-api.js');

const auth = {
  host: 'imap.mail.yahoo.com',
  port: 993,
  smtpHost: 'smtp.mail.yahoo.com',
  smtpPort: 465,
  username: 'someone@yahoo.com',
  password: 'app-password',
};

/** The four calls a sync tick makes. */
async function oneTick(api: {
  listWindow: (d: number) => Promise<unknown>;
  fetch: (u: number[]) => Promise<unknown>;
  findInTrash: (ids: string[]) => Promise<unknown>;
  fetchFlags: (u: number[]) => Promise<unknown>;
}) {
  await api.listWindow(90);
  await api.fetch([1, 2, 3]);
  await api.findInTrash(['<a@x>', '<b@x>']);
  await api.fetchFlags([1, 2, 3]);
}

describe('imap connection reuse', () => {
  beforeEach(() => {
    state.connects = 0;
    state.instances.length = 0;
  });

  it('spends ONE login on a whole session', async () => {
    await withRealImapSession(auth, oneTick);
    expect(state.connects).toBe(1);
  });

  it('spends one login per call when used one-shot', async () => {
    await oneTick(realImapApi(auth));
    expect(state.connects).toBe(4);
  });

  it('does not re-login per message in a batched trash lookup', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `<m${i}@x>`);
    await withRealImapSession(auth, (api) => api.findInTrash(ids).then(() => undefined));
    expect(state.connects).toBe(1);
  });

  it('re-establishes a session connection dropped mid-tick', async () => {
    await withRealImapSession(auth, async (api) => {
      await api.listWindow(90);
      // Server dropped us — a long tick can outlive an idle timeout.
      state.instances[state.instances.length - 1].usable = false;
      await api.fetchFlags([1]);
    });
    expect(state.connects).toBe(2);
  });

  it('opens nothing when the session does no IMAP work', async () => {
    await withRealImapSession(auth, async () => 'nothing to do');
    expect(state.connects).toBe(0);
  });
});
