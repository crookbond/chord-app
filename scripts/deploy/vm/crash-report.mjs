// Files a GitHub issue when chord.service or chord-worker.service stops abnormally (ADR 0227).
// Started by the unit's ExecStopPost through systemd-run, as root, in its own transient unit so the
// service's restart never waits on it:
//   node /usr/local/lib/chord/crash-report.mjs <unit> <SERVICE_RESULT> <EXIT_CODE> <EXIT_STATUS> <INVOCATION_ID>
// It always exits 0. A report that cannot be filed is logged to the journal and dropped.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { decide, extractTrace, issueBody, issueTitle, nextState, repeatComment, signatureOf } from './crash-report-lib.mjs';
import { accessSecret, metadataToken, projectId } from './secrets-lib.mjs';

const CONFIG_FILE = process.env.CHORD_CRASH_CONFIG ?? '/usr/local/lib/chord/crash-report.json';
const STATE_DIR = process.env.CHORD_CRASH_STATE_DIR ?? '/var/lib/chord-crash';
const STATE_FILE = `${STATE_DIR}/state.json`;
const API = 'https://api.github.com';

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function journalLines(unit, invocation) {
  const match = invocation ? [`_SYSTEMD_INVOCATION_ID=${invocation}`] : ['-u', unit];
  const out = execFileSync('journalctl', [...match, '-o', 'cat', '-n', '400', '--no-pager'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out.split('\n');
}

async function github(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'chord-crash-report',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} answered ${res.status}`);
  return res.json();
}

async function main() {
  const [unit, result = 'unknown', exitCode = '', exitStatus = '', invocation = ''] = process.argv.slice(2);
  if (!unit || result === 'success') return;

  const config = readJson(CONFIG_FILE, null);
  if (!config?.repo) {
    console.log('crash-report: no repo configured, nothing filed');
    return;
  }

  // The last lines the dying process wrote may still be on their way into the journal.
  await new Promise((r) => setTimeout(r, 1500));
  const trace = extractTrace(journalLines(unit, invocation));
  const signature = signatureOf({ unit, trace, result, exitStatus });
  const now = Date.now();
  const when = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');

  const token = (
    await accessSecret({ project: await projectId(), name: config.tokenSecret, token: await metadataToken() })
  ).trim();

  const state = readJson(STATE_FILE, {});
  const decision = await decide({
    state,
    signature,
    now,
    issueOpen: async (n) => (await github(token, 'GET', `/repos/${config.repo}/issues/${n}`)).state === 'open',
  });

  let issue;
  if (decision.action === 'create') {
    const fields = { unit, trace, result, exitCode, exitStatus, when, commit: config.commit, signature, previous: decision.previous };
    const created = await github(token, 'POST', `/repos/${config.repo}/issues`, {
      title: issueTitle(fields),
      body: issueBody(fields),
      labels: ['crash'],
    });
    issue = created.number;
    console.log(`crash-report: filed #${issue} for ${unit} (${signature})`);
  } else if (decision.action === 'comment') {
    await github(token, 'POST', `/repos/${config.repo}/issues/${decision.issue}/comments`, {
      body: repeatComment({ when, count: decision.count, commit: config.commit }),
    });
    console.log(`crash-report: noted a repeat on #${decision.issue} (${signature})`);
  } else {
    console.log(`crash-report: ${unit} (${signature}) not filed: ${decision.reason}`);
  }

  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(nextState({ state, signature, now, decision, issue })), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

main().catch((err) => {
  console.error(`crash-report: ${err?.message ?? err}`);
});
