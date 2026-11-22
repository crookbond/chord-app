import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const fixture = path.join(here, 'fixtures', 'busy-until-stopped.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

function execStart(unit: string): string {
  const text = readFileSync(path.join(repoRoot, 'scripts/deploy/templates', unit), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('ExecStart='));
  if (!line) throw new Error(`no ExecStart in ${unit}`);
  return line;
}

describe('the services start Node itself, not the tsx command', () => {
  // The tsx command runs our code in a child process; on a stop it waits ~60 ms
  // for a busy child, SIGKILLs it and exits 143, which systemd reports as a
  // failure and the crash reporter files as a crash (ADR 0227 addendum).
  for (const unit of ['chord.service', 'chord-worker.service']) {
    it(`${unit} runs node with tsx as a loader`, () => {
      const line = execStart(unit);
      expect(line).toMatch(/\bnode\b.*--import tsx\b/);
      expect(line).not.toMatch(/\.bin\/tsx\b/);
    });
  }
});

// Signals and process groups are POSIX; the VM and CI are Linux.
describe.skipIf(process.platform === 'win32')('stopping a busy process the way systemd does', () => {
  // systemd's default KillMode=control-group sends SIGTERM to every process
  // in the service, so the whole process group is signalled here.
  async function exitCodeAfterGroupStop(command: string, args: string[]): Promise<number | null> {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve();
      });
      child.once('exit', () => reject(new Error('exited before it was ready')));
    });
    await new Promise((r) => setTimeout(r, 300));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    process.kill(-child.pid!, 'SIGTERM');
    return exited;
  }

  it('the tsx command exits 143 instead of letting the role stop', async () => {
    expect(await exitCodeAfterGroupStop(process.execPath, [tsxCli, fixture])).toBe(143);
  }, 20_000);

  it('node --import tsx lets the role stop and exit 0', async () => {
    expect(await exitCodeAfterGroupStop(process.execPath, ['--import', 'tsx', fixture])).toBe(0);
  }, 20_000);
});
