/**
 * ADR 0282 - a colour that is not in the theme palette must be chosen per
 * scheme (`byScheme` in mobile/src/theme.ts). A colour stored in a constant at
 * the top of a file is read once and never follows dark mode: the tldr box,
 * the calendar trip bands and travel legs all stayed light in dark mode with
 * light text on them. This fails the build the next time someone does it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../mobile');

/** Where fixed colours are allowed: the palettes themselves. */
const ALLOWED = new Set(['src/theme.ts']);

// `const X = '#abc'` / `= "rgba(...)"` at the start of a line (module level).
const MODULE_COLOUR = /^(export )?const \w+ *= *['"](#[0-9A-Fa-f]{3,8}|rgba?\()/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('mobile colours follow the theme', () => {
  it('no module-level colour constants outside theme.ts', () => {
    const offenders: string[] = [];
    for (const root of ['app', 'src']) {
      for (const file of walk(path.join(MOBILE, root))) {
        const rel = path.relative(MOBILE, file).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        fs.readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (MODULE_COLOUR.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
