// Points git at the repo's .githooks folder. Run by `npm install` (prepare).
// Does nothing outside a git checkout (the deploy's npm ci) or in CI, and
// never fails the install.
import { execFileSync } from 'node:child_process';

if (process.env.CI) process.exit(0);

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // Not a git checkout, or git is missing: nothing to install.
}
