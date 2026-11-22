/**
 * Who is using the machine during a load level. The rig runs the app server,
 * the driver and Postgres on one box, so "the database is slow" and "the box is
 * out of cores" look the same from the app: this separates them.
 *
 * Whole-machine busy time comes from os.cpus(); the CPU of all node processes
 * (server + driver + tooling) from PowerShell on Windows. What is left is
 * mostly Postgres. (Summing Postgres backends directly does not work: they
 * come and go, and a departed process takes its CPU seconds with it.)
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

export interface CpuSnapshot {
  at: number; // ms
  machineBusySeconds: number;
  allNodeSeconds: number | null;
}

function machineBusySeconds(): number {
  let busy = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += (t.user + t.nice + t.sys + t.irq) / 1000;
  }
  return busy;
}

function allNodeSeconds(): number | null {
  if (process.platform !== 'win32') return null;
  const script =
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { ($_.KernelModeTime+$_.UserModeTime)/1e7 } | Measure-Object -Sum).Sum";
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function snapshotCpu(_port?: number): CpuSnapshot {
  return { at: Date.now(), machineBusySeconds: machineBusySeconds(), allNodeSeconds: allNodeSeconds() };
}

/** Average cores busy between two snapshots. */
export function cpuBetween(a: CpuSnapshot | null, b: CpuSnapshot | null) {
  if (!a || !b) return null;
  const secs = (b.at - a.at) / 1000;
  if (secs <= 0) return null;
  const r = (n: number) => Math.round(n * 100) / 100;
  const machine = (b.machineBusySeconds - a.machineBusySeconds) / secs;
  const node =
    a.allNodeSeconds !== null && b.allNodeSeconds !== null ? (b.allNodeSeconds - a.allNodeSeconds) / secs : null;
  return {
    machineCoresBusy: r(machine),
    nodeCores: node === null ? null : r(node),
    // Postgres backends, the OS and anything else on the box.
    postgresAndOtherCores: node === null ? null : r(machine - node),
  };
}
