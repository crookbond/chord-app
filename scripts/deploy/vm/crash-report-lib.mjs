// Shared by crash-report.mjs (ADR 0227). Plain ESM, no dependencies: like secrets-lib.mjs it runs as
// ROOT on the VM from /usr/local/lib/chord, never from the app's own directory.

import { createHash } from 'node:crypto';

const MAX_TRACE_CHARS = 6000;
const MAX_LOOKBACK = 150;
/** A repeat of a crash that already has an open issue adds a comment at most this often. */
export const REPEAT_COMMENT_MS = 6 * 3600 * 1000;
/** New issues per hour, across all crashes. A restart loop must not open an issue every 3 seconds. */
export const MAX_NEW_ISSUES_PER_HOUR = 5;

// What Node prints first when it dies on an uncaught error: the source location, alone on a line.
const LOCATION_RE = /^(?:file:\/\/|node:|\/|[A-Za-z]:\\)\S*:\d+$/;
const NODE_VERSION_RE = /^Node\.js v\d/;
// The app's own console lines ("21:11:10 warn ..."). They can carry user content, so they are never
// part of a report. The level is coloured, so colour codes are removed before matching.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const APP_LOG_RE = /^\d{2}:\d{2}:\d{2}\s/;
const isAppLog = (line) => APP_LOG_RE.test(line.replace(ANSI_RE, ''));

/**
 * The fatal block Node wrote before exiting, from the unit's journal lines (oldest first), or null
 * when the process ended without one (killed, out of memory, a failed ExecStartPre).
 */
export function extractTrace(lines) {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (NODE_VERSION_RE.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let start = -1;
  for (let i = end - 1; i >= Math.max(0, end - MAX_LOOKBACK); i--) {
    if (LOCATION_RE.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  const from = start >= 0 ? start : Math.max(0, end - 40);
  const block = lines.slice(from, end + 1).filter((l) => !isAppLog(l));
  return block.join('\n').trim() || null;
}

/** Remove what a stack trace has no business carrying off the VM. */
export function redact(text) {
  return text
    .replace(/\/\/[^\s/:@]+:[^\s/@]+@/g, '//<credentials>@')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '<redacted>');
}

/** `AuthenticationFailure [Error]: Already logged out` -> that line; null when there is none. */
export function errorLine(trace) {
  for (const raw of trace.split('\n')) {
    const line = raw.trim();
    if (/^(?:Uncaught\s+)?[A-Za-z_$][\w$.]*(?:\s\[[^\]]+\])?: \S/.test(line) && !line.startsWith('at ')) return line;
  }
  return null;
}

function frameKey(line) {
  // "    at ImapFlow.authenticate (/srv/chord/node_modules/imapflow/lib/imap-flow.js:1441:19)"
  const m = /^\s*at\s+(.*?)\s*\(?((?:file:\/\/)?[^()\s]+?):(\d+)(?::\d+)?\)?$/.exec(line);
  if (!m) return line.trim();
  const file = m[2].replace(/^file:\/\//, '').replace(/^.*?(node_modules\/|\/server\/src\/|\/kernel\/src\/)/, '$1');
  return `${m[1]} ${file}:${m[3]}`;
}

/**
 * The same crash must get the same signature on every occurrence, so ids, counts and connection
 * tokens in the message are flattened and only the first frames (function + file + line) count.
 */
export function signatureOf({ unit, trace, result, exitStatus }) {
  let basis;
  if (trace) {
    const message = (errorLine(trace) ?? '').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '#');
    const frames = trace
      .split('\n')
      .filter((l) => /^\s+at\s/.test(l))
      .slice(0, 5)
      .map(frameKey);
    basis = [message, ...frames].join('\n');
  } else {
    basis = `no-trace ${unit} ${result} ${exitStatus}`;
  }
  return createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

function unitLabel(unit) {
  return unit.replace(/\.service$/, '');
}

export function issueTitle({ unit, trace, result, exitStatus }) {
  const what = trace ? (errorLine(trace) ?? 'uncaught error') : `stopped (${result}, ${exitStatus})`;
  const title = `Crash in ${unitLabel(unit)}: ${redact(what)}`;
  return title.length > 180 ? `${title.slice(0, 177)}...` : title;
}

function traceBlock(trace) {
  if (!trace) {
    return '_The process left no Node stack trace (killed, out of memory, or it failed before starting). Read the journal: `scripts/deploy/logs.sh journal`._';
  }
  let safe = redact(trace);
  if (safe.length > MAX_TRACE_CHARS) safe = `${safe.slice(0, MAX_TRACE_CHARS)}\n... (truncated)`;
  return `\`\`\`\n${safe.replace(/```/g, "'''")}\n\`\`\``;
}

/** The body of a new crash issue. `previous` is a closed issue number for the same signature. */
export function issueBody({ unit, trace, result, exitCode, exitStatus, when, commit, signature, previous }) {
  const rows = [
    `<!-- crash-signature: ${signature} -->`,
    `| | |`,
    `|---|---|`,
    `| Service | \`${unit}\` |`,
    `| When (UTC) | ${when} |`,
    `| systemd result | \`${result}\` (${exitCode} ${exitStatus}) |`,
    `| Deployed commit | ${commit ? `\`${commit}\`` : 'unknown'} |`,
    `| Signature | \`${signature}\` |`,
  ];
  if (previous) rows.push(`| Seen before | #${previous} (closed) |`);
  return [
    ...rows,
    '',
    'systemd restarted the service. Whatever it was doing at that moment was interrupted.',
    '',
    '### Stack trace',
    '',
    traceBlock(trace),
    '',
    'Filed by `scripts/deploy/vm/crash-report.mjs` (ADR 0227). Emails and long tokens are removed before filing.',
  ].join('\n');
}

export function repeatComment({ when, count, commit }) {
  return `Crashed again at ${when} UTC (${count} time${count === 1 ? '' : 's'} since the last note here). Deployed commit: ${commit ? `\`${commit}\`` : 'unknown'}.`;
}

/**
 * What to do with this occurrence, given what was filed before.
 *   { action: 'create', previous? } | { action: 'comment', issue, count } | { action: 'skip', reason }
 * `issueOpen` is asked only when a filed issue exists for the signature.
 */
export async function decide({ state, signature, now, issueOpen }) {
  const entry = state.signatures?.[signature];
  if (entry?.issue) {
    const open = await issueOpen(entry.issue);
    if (open) {
      const pending = (entry.pending ?? 0) + 1;
      if (now - (entry.lastNoted ?? 0) < REPEAT_COMMENT_MS) return { action: 'skip', reason: 'noted recently', pending };
      return { action: 'comment', issue: entry.issue, count: pending };
    }
  }
  const recent = (state.created ?? []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= MAX_NEW_ISSUES_PER_HOUR) return { action: 'skip', reason: 'hourly issue limit reached' };
  return { action: 'create', previous: entry?.issue };
}

/** The state after acting on `decision`. Pure, so the bookkeeping can be tested without a disk. */
export function nextState({ state, signature, now, decision, issue }) {
  const signatures = { ...(state.signatures ?? {}) };
  const created = (state.created ?? []).filter((t) => now - t < 3600 * 1000);
  const entry = { ...(signatures[signature] ?? {}) };
  if (decision.action === 'create') {
    entry.issue = issue;
    entry.lastNoted = now;
    entry.pending = 0;
    created.push(now);
  } else if (decision.action === 'comment') {
    entry.lastNoted = now;
    entry.pending = 0;
  } else if (decision.pending !== undefined) {
    entry.pending = decision.pending;
  }
  signatures[signature] = entry;
  return { signatures, created };
}
