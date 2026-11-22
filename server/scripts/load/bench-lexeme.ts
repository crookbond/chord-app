/**
 * Micro-benchmark for the blind-index lexeme: what one lexeme costs three ways.
 *   tsx scripts/load/bench-lexeme.ts
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { buildWordsVector } from '../../src/utils/blind-index.js';

const key = randomBytes(32);

const plain = (kind: string, value: string) =>
  `x${createHmac('sha256', key).update(kind).update(':').update(value).digest().subarray(0, 4).toString('hex')}`;

// HMAC from prepared inner/outer states: no per-call key schedule.
const ipad = Buffer.alloc(64, 0x36);
const opad = Buffer.alloc(64, 0x5c);
for (let i = 0; i < key.length; i++) {
  ipad[i]! ^= key[i]!;
  opad[i]! ^= key[i]!;
}
const inner0 = createHash('sha256').update(ipad);
const outer0 = createHash('sha256').update(opad);
const prepared = (kind: string, value: string) => {
  const ih = inner0.copy().update(kind).update(':').update(value).digest();
  return `x${outer0.copy().update(ih).digest().subarray(0, 4).toString('hex')}`;
};

const memo = new Map<string, string>();
const memoised = (kind: string, value: string) => {
  const k = kind + value;
  let v = memo.get(k);
  if (v === undefined) memo.set(k, (v = plain(kind, value)));
  return v;
};

// A vocabulary shaped like mail: a few thousand distinct words, heavy repetition.
const vocab = Array.from({ length: 4000 }, () => randomBytes(5).toString('hex').slice(0, 3 + Math.floor(Math.random() * 9)));
const input: string[] = [];
for (let i = 0; i < 300_000; i++) input.push(vocab[Math.floor(Math.pow(Math.random(), 2.2) * vocab.length)]!);

for (const [name, fn] of [
  ['createHmac per lexeme', plain],
  ['prepared inner/outer', prepared],
  ['memo over createHmac', memoised],
] as const) {
  const t0 = performance.now();
  let acc = 0;
  for (const v of input) acc += fn('w', v).length;
  console.log(`${name.padEnd(24)} ${(performance.now() - t0).toFixed(0)} ms for ${input.length} lexemes (${acc})`);
}

// Same bytes?
let same = true;
for (let i = 0; i < 20_000; i++) {
  const v = randomBytes(1 + (i % 12)).toString('hex');
  if (plain('w', v) !== prepared('w', v) || plain('g', v) !== prepared('g', v)) same = false;
}
console.log('prepared == createHmac on 20k random inputs:', same);

// And what a whole message body costs to index today.
const body = Array.from({ length: 350 }, () => vocab[Math.floor(Math.random() * vocab.length)]).join(' ');
const t1 = performance.now();
for (let i = 0; i < 200; i++) buildWordsVector(key, body);
console.log(`buildWordsVector on a ~350-word body: ${((performance.now() - t1) / 200).toFixed(2)} ms each`);
