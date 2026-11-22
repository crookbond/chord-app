/**
 * Every BullMQ object that can emit `error` has a listener. An EventEmitter
 * with none throws the error and kills the process (ADR 0227's imapflow crash
 * was this shape); the Queue and QueueEvents objects had none, only the
 * Workers did.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { logQueueErrors } from '../redis.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

describe('logQueueErrors', () => {
  it('keeps an emitted error from throwing, and logs it', () => {
    const queue = new EventEmitter();
    const log = vi.fn();
    expect(() => queue.emit('error', new Error('boom'))).toThrow('boom');
    logQueueErrors('test queue', { queue }, log);
    expect(() => queue.emit('error', new Error('connection reset'))).not.toThrow();
    expect(log).toHaveBeenCalledWith('test queue queue error', { err: 'connection reset' });
  });

  it('every Queue, QueueEvents and Worker the server makes is given one', () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const made = [...text.matchAll(/const (\w+) = new (?:Queue|QueueEvents|Worker)(?:<[^>]*>)?\(/g)].map((m) => m[1]!);
      if (made.length === 0) continue;
      const calls = [...text.matchAll(/logQueueErrors\([^)]*?\{([^}]*)\}/g)].map((m) => m[1]!).join(',');
      for (const name of made) {
        if (!new RegExp(`(^|[\\s,:])${name}([\\s,]|$)`).test(calls)) {
          missing.push(`${path.relative(SRC, file)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
