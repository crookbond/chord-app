/**
 * Search vectors on disk (ADR 0276): int8 with one float scale, about a
 * quarter of float32, so a mailbox of 20k vectors is ~10 MB to load and scan.
 * The error this adds is far below the gap between a match and a non-match.
 */
import { createHash } from 'node:crypto';

export function packVector(v: Float32Array): Buffer {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const scale = max || 1;
  const buf = Buffer.alloc(4 + v.length);
  buf.writeFloatLE(scale, 0);
  for (let i = 0; i < v.length; i++) buf.writeInt8(Math.round((v[i] / scale) * 127), 4 + i);
  return buf;
}

export function unpackVector(buf: Buffer): Float32Array {
  const scale = buf.readFloatLE(0) / 127;
  const out = new Float32Array(buf.length - 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt8(4 + i) * scale;
  return out;
}

/** Cosine; both sides are (near) unit length, so the dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function contentHash(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('base64url').slice(0, 32);
}
