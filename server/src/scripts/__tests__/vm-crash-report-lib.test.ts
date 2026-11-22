import { describe, expect, it } from 'vitest';

// Plain ESM under scripts/deploy/vm (runs as root on the VM, ADR 0227). Imported here so CI exercises it.
// @ts-expect-error untyped .mjs
import * as lib from '../../../../scripts/deploy/vm/crash-report-lib.mjs';

/** The journal of chord-worker at 2026-10-06 23:41:29 UTC, as `journalctl -o cat` prints it. */
const PROD_JOURNAL = [
  '23:41:12 info mail sweep: 3 mailboxes for someone@example.com',
  '/srv/chord/node_modules/imapflow/lib/imap-flow.js:1441',
  "            throw new AuthenticationFailure('Already logged out');",
  '                  ^',
  '',
  'AuthenticationFailure [Error]: Already logged out',
  '    at ImapFlow.authenticate (/srv/chord/node_modules/imapflow/lib/imap-flow.js:1441:19)',
  '    at ImapFlow.startSession (/srv/chord/node_modules/imapflow/lib/imap-flow.js:1040:20)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  "Emitted 'error' event on ImapFlow instance at:",
  '    at ImapFlow.emitError (/srv/chord/node_modules/imapflow/lib/imap-flow.js:468:14)',
  '    at /srv/chord/node_modules/imapflow/lib/imap-flow.js:1536:39',
  '    at /srv/chord/node_modules/imapflow/lib/imap-flow.js:1524:17',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5) {',
  '  authenticationFailed: true,',
  "  _connId: '1bete2zblcjo33li0e2g'",
  '}',
  '',
  'Node.js v20.20.2',
  '',
];

const crash = (trace: string | null) => ({ unit: 'chord-worker.service', trace, result: 'exit-code', exitCode: 'exited', exitStatus: '1' });

describe('reading a crash out of the journal', () => {
  it('takes the fatal block Node printed and leaves the app log lines behind', () => {
    const trace = lib.extractTrace(PROD_JOURNAL);
    expect(trace.split('\n')[0]).toBe('/srv/chord/node_modules/imapflow/lib/imap-flow.js:1441');
    expect(trace).toContain('AuthenticationFailure [Error]: Already logged out');
    expect(trace.endsWith('Node.js v20.20.2')).toBe(true);
    expect(trace).not.toContain('mail sweep');
  });

  it('finds nothing when the process left no trace (killed, out of memory)', () => {
    expect(lib.extractTrace(['23:41:12 info tick', 'chord-worker.service: A process of this unit has been killed by the OOM killer.'])).toBeNull();
  });

  it('never carries an app log line that landed inside the block', () => {
    const lines = [...PROD_JOURNAL];
    lines.splice(8, 0, '23:41:29 warn account sync failed for someone@example.com');
    expect(lib.extractTrace(lines)).not.toContain('account sync failed');
  });

  it('drops an app log line that starts with a colour code', () => {
    const lines = [...PROD_JOURNAL];
    lines.splice(8, 0, '\u001b[2m23:41:29\u001b[22m \u001b[33mwarn\u001b[39m account sync failed for someone@example.com');
    expect(lib.extractTrace(lines)).not.toContain('account sync failed');
  });

  it('names the issue after the error', () => {
    const trace = lib.extractTrace(PROD_JOURNAL);
    expect(lib.issueTitle(crash(trace))).toBe('Crash in chord-worker: AuthenticationFailure [Error]: Already logged out');
    expect(lib.issueTitle({ ...crash(null), result: 'oom-kill', exitStatus: 'KILL' })).toBe('Crash in chord-worker: stopped (oom-kill, KILL)');
  });
});

describe('crash signature', () => {
  const trace = lib.extractTrace(PROD_JOURNAL);

  it('is the same for the same crash on another connection and another column', () => {
    const again = trace.replace('1bete2zblcjo33li0e2g', '798nt1ezxlmitifr6mjr').replace('1441:19', '1441:23');
    expect(lib.signatureOf(crash(again))).toBe(lib.signatureOf(crash(trace)));
  });

  it('differs when the error is thrown from somewhere else', () => {
    const elsewhere = trace.replace('imap-flow.js:1441:19', 'imap-flow.js:1502:11');
    expect(lib.signatureOf(crash(elsewhere))).not.toBe(lib.signatureOf(crash(trace)));
  });

  it('separates trace-less stops by result', () => {
    const oom = lib.signatureOf({ ...crash(null), result: 'oom-kill', exitStatus: 'KILL' });
    expect(oom).not.toBe(lib.signatureOf(crash(null)));
    expect(oom).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('what leaves the VM', () => {
  it('removes emails, credentials in URLs and long tokens', () => {
    const out = lib.redact(
      'Error: imap login failed for someone@yahoo.com at postgresql://chord:hunter2@10.59.0.3/chord key sk-ant-REDACTED',
    );
    expect(out).not.toContain('someone@yahoo.com');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    expect(out).toContain('<email>');
  });

  it('writes a body that carries the signature, the commit and the redacted trace', () => {
    const trace = `${lib.extractTrace(PROD_JOURNAL)}\nError: for someone@yahoo.com`;
    const body = lib.issueBody({ ...crash(trace), when: '2026-10-06T23:41:29Z', commit: 'd9e5d0a', signature: 'abc123abc123', previous: 41 });
    expect(body).toContain('<!-- crash-signature: abc123abc123 -->');
    expect(body).toContain('`d9e5d0a`');
    expect(body).toContain('#41 (closed)');
    expect(body).toContain('Already logged out');
    expect(body).not.toContain('someone@yahoo.com');
  });
});

describe('a restart loop does not flood the repository', () => {
  const HOUR = 3600 * 1000;
  const open = async () => true;
  const closed = async () => false;
  const never = async () => {
    throw new Error('should not be asked');
  };

  it('files a new crash once, then stays quiet until six hours have passed', async () => {
    let state = {};
    const first = await lib.decide({ state, signature: 's1', now: 0, issueOpen: never });
    expect(first).toEqual({ action: 'create', previous: undefined });
    state = lib.nextState({ state, signature: 's1', now: 0, decision: first, issue: 7 });

    // RestartSec=3: the same crash again, a hundred times.
    for (let i = 1; i <= 100; i++) {
      const d = await lib.decide({ state, signature: 's1', now: i * 3000, issueOpen: open });
      expect(d.action).toBe('skip');
      state = lib.nextState({ state, signature: 's1', now: i * 3000, decision: d });
    }

    const later = await lib.decide({ state, signature: 's1', now: 6 * HOUR + 1, issueOpen: open });
    expect(later).toEqual({ action: 'comment', issue: 7, count: 101 });
    state = lib.nextState({ state, signature: 's1', now: 6 * HOUR + 1, decision: later });
    expect((await lib.decide({ state, signature: 's1', now: 6 * HOUR + 5000, issueOpen: open })).action).toBe('skip');
  });

  it('files again, pointing at the old issue, when the crash returns after its issue was closed', async () => {
    const state = lib.nextState({ state: {}, signature: 's1', now: 0, decision: { action: 'create' }, issue: 7 });
    expect(await lib.decide({ state, signature: 's1', now: 48 * HOUR, issueOpen: closed })).toEqual({ action: 'create', previous: 7 });
  });

  it('stops opening issues after five different crashes in an hour', async () => {
    let state = {};
    for (let i = 0; i < 5; i++) {
      const d = await lib.decide({ state, signature: `s${i}`, now: i * 1000, issueOpen: never });
      expect(d.action).toBe('create');
      state = lib.nextState({ state, signature: `s${i}`, now: i * 1000, decision: d, issue: 10 + i });
    }
    expect(await lib.decide({ state, signature: 's9', now: 6000, issueOpen: never })).toEqual({ action: 'skip', reason: 'hourly issue limit reached' });
    expect((await lib.decide({ state, signature: 's9', now: HOUR + 6000, issueOpen: never })).action).toBe('create');
  });
});
