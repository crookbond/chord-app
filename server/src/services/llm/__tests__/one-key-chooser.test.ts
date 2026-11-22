/**
 * ADR 0257 - a BYOK user's AI work runs on THEIR key, everywhere.
 *
 * `getLlmForUser` is the one function that picks whose key a call uses. For a
 * long time eleven call sites reached for `getLlm()` (Chord's own model)
 * instead, so a user with their own key still had their email suggestions,
 * people extraction, morning briefing, attachment indexing and memory
 * extraction run on - and paid for by - Chord, and a dead key never showed on
 * any of them. This fails the build the next time someone does it again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Where Chord's own model may be reached for directly. */
const ALLOWED = new Set([
  'services/llm/factory.ts', // defines it, and getLlmForUser falls back to it
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'scripts') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('one place picks the key', () => {
  it('no service calls getLlm() directly - they go through getLlmForUser', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/\bgetLlm\s*\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  // ADR 0276 - the same rule for vectors: only getEmbedderForUser builds an
  // embedder, so a user's mail is never embedded on a key nobody chose.
  it('no service builds an embedder directly - they go through getEmbedderForUser', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === 'services/llm/embeddings.ts') continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/\bnew\s+(OpenAICompatEmbedder|GeminiEmbedder)\s*\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
