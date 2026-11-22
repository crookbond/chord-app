/**
 * ADR 0268 - an AI pass reads only what a person would see.
 *
 * `bodyForModel` / `modelBodyText` are the one rule for which part of a stored
 * message a model gets: the rendered HTML when there is any, never a
 * text/plain part that can say something else. Before this, every pass picked
 * `body_text ?? body_excerpt` on its own, which made the hidden plain part the
 * winner. This fails the build the next time a pass picks for itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Not model input: the search headline highlights what matched, and the seal
 *  helper picks what to index. */
const ALLOWED = new Set(['services/email/email-search.ts', 'services/email/content-seal.ts']);

const SHAPES = [
  /body_?[tT]ext\s*(\?\?|\|\|)\s*\S*body_?[eE]xcerpt/,
  /body_?[tT]ext\s*\?\?\s*htmlToText/,
  /bodyText\?\.trim\(\)\s*\?/,
  /body_text\?\.trim\(\)\s*\|\|/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('one rule picks the body a model reads', () => {
  it('no service chooses between a stored plain part, HTML and excerpt itself', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(SRC, 'services'))) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (SHAPES.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
