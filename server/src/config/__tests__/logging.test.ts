/**
 * Production's log files wrote `logger.error('tool search failed', { err })`
 * as `"err":{}` (2026-10-20): a chat search failed twice and the log kept no
 * message, no stack and no SQL code. An Error's fields are not enumerable, so
 * JSON drops them unless the format turns them into plain values first.
 */
import { PassThrough } from 'node:stream';
import winston from 'winston';
import { afterEach, describe, expect, it } from 'vitest';

import DailyRotateFile from 'winston-daily-rotate-file';
import { LOG_FILE_SIZE, LOG_FILES, logger, promptLogger } from '@/config/logging.js';

let transport: winston.transport | null = null;

afterEach(() => {
  if (transport) logger.remove(transport);
  transport = null;
});

function capture(): string[] {
  const lines: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => lines.push(chunk.toString().trim()));
  transport = new winston.transports.Stream({ stream });
  logger.add(transport);
  return lines;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('an error inside a log field', () => {
  it('keeps its message and stack in the written line', async () => {
    const lines = capture();
    logger.error('tool search failed', { err: new Error('Connection terminated unexpectedly') });
    await flush();
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.err.message).toBe('Connection terminated unexpectedly');
    expect(entry.err.stack).toMatch(/Connection terminated unexpectedly\n\s+at /);
  });

  it("keeps a database error's own fields and its cause", async () => {
    const lines = capture();
    const pg = Object.assign(new Error('syntax error at or near "="'), { code: '42601', position: '118' });
    logger.error('tool search failed', { err: new Error('search failed', { cause: pg }) });
    await flush();
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.err.cause).toMatchObject({ message: 'syntax error at or near "="', code: '42601', position: '118' });
  });

  it('leaves a plain value alone', async () => {
    const lines = capture();
    logger.warn('apply category label failed', { err: 'gmail POST /labels 409', threadId: 't1' });
    await flush();
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ err: 'gmail POST /labels 409', threadId: 't1' });
  });
});

describe('personal data in a log line', () => {
  it('masks email addresses and phone numbers, in the message and in fields', async () => {
    const lines = capture();
    logger.warn('phone: number transferred to ownertest@gmail.com', {
      phone: '+15551234567',
      externalId: 'whatsapp:+15551234567',
      nested: { to: ['a.person@example.co.uk'] },
      when: new Date('2026-10-26T00:00:00Z'),
    });
    await flush();
    const line = lines.at(-1)!;
    expect(line).not.toMatch(/ownertest|a\.person|5551234567/);
    const entry = JSON.parse(line);
    expect(entry.message).toBe('phone: number transferred to ***@gmail.com');
    expect(entry).toMatchObject({
      phone: '+***4567',
      externalId: 'whatsapp:+***4567',
      nested: { to: ['***@example.co.uk'] },
      when: '2026-10-26T00:00:00.000Z',
    });
  });

  it('leaves times, offsets and ids alone', async () => {
    const lines = capture();
    logger.warn('synced', { at: '2026-10-26T09:00:00+05:30', id: 'u_8f3k2', n: 1234567 });
    await flush();
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ at: '2026-10-26T09:00:00+05:30', id: 'u_8f3k2', n: 1234567 });
  });
});

/**
 * 2026-11-16: tracing a Nov 8 email found only combined-2026-11-15.log and
 * combined-2026-11-16.log in prod. `maxFiles: 2` is a file COUNT and a new
 * file starts every day, so the 50 MB "weeks of history" ADR 0226 meant was
 * two days.
 */
describe('log rotation', () => {
  const rotating = [...logger.transports, ...promptLogger.transports].filter(
    (t): t is DailyRotateFile => t instanceof DailyRotateFile,
  );
  const opts = (t: DailyRotateFile) =>
    (t as unknown as { options: { filename: string; datePattern: string; maxFiles: number; maxSize: string; auditFile?: string } }).options;

  it('keeps a month of daily files in every log, each still capped by size', () => {
    expect(rotating.map((t) => opts(t).filename).sort()).toEqual(['combined-%DATE%.log', 'error-%DATE%.log', 'prompts-%DATE%.log']);
    for (const t of rotating) {
      expect(opts(t).datePattern).toBe('YYYY-MM-DD');
      expect(opts(t).maxFiles).toBe(30);
      expect(opts(t).maxSize).toBe('25m');
    }
  });

  it('bounds the worst case at 750 MB a log', () => {
    expect(LOG_FILES * Number.parseInt(LOG_FILE_SIZE, 10)).toBe(750);
  });

  it('names each audit file, so an options change does not strand the old files', () => {
    const audits = rotating.map((t) => opts(t).auditFile);
    expect(audits.every((a) => typeof a === 'string' && /\.(combined|error|prompts)-audit\.json$/.test(a))).toBe(true);
    expect(new Set(audits).size).toBe(3);
  });
});
