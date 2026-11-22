import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import { resolvePromptLogMode } from '../utils/prompt-log.js';
import { env } from './env.js';

fs.mkdirSync(env.LOGS_DIR, { recursive: true });

// Each log keeps LOG_FILES files of at most LOG_FILE_SIZE. Rotation is
// daily, so on an ordinary day the file count is a day count: 30 files is a
// month of history (a normal prod day writes 1.9-2.8 MB to combined-*).
// The size cap is still the hard ceiling: a day that floods a log uses
// several files, pushing out older days, but never more than
// LOG_FILES x LOG_FILE_SIZE per log (one repeated error once wrote 23 GB in
// three hours and filled the disk, ADR 0226).
export const LOG_FILE_SIZE = '25m';
export const LOG_FILES = 30;

/**
 * The rotation library tracks its files in an audit file named after a hash
 * of the options unless one is named, so every options change started a new
 * audit file and stranded the files written before it. A fixed name per log
 * keeps tracking them across changes.
 */
export function rotationOptions(name: 'error' | 'combined' | 'prompts') {
  return {
    dirname: env.LOGS_DIR,
    filename: `${name}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxSize: LOG_FILE_SIZE,
    maxFiles: LOG_FILES,
    auditFile: path.join(env.LOGS_DIR, `.${name}-audit.json`),
  };
}

/**
 * An Error as plain JSON: its message and stack are not enumerable, so
 * `JSON.stringify` writes `{}`. Own enumerable fields (a Postgres error's
 * `code`, `detail`, `routine`, ...) and `cause` are kept.
 */
export function errorToJson(err: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack };
  for (const [k, v] of Object.entries(err)) out[k] = v instanceof Error ? errorToJson(v, depth + 1) : v;
  if (err.cause !== undefined && depth < 3) out.cause = err.cause instanceof Error ? errorToJson(err.cause, depth + 1) : err.cause;
  return out;
}

/**
 * `format.errors` only unwraps a log entry that IS an Error. The common call,
 * `logger.error('...', { err })`, puts it in a field, which the file log then
 * wrote as `"err":{}` - every such error in production lost its message.
 */
export const serializeErrorFields = winston.format((info) => {
  for (const [k, v] of Object.entries(info)) {
    if (v instanceof Error) (info as Record<string, unknown>)[k] = errorToJson(v);
  }
  return info;
});

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const PHONE_RE = /\+\d{4,11}(\d{4})(?!\d)/g;

/** An email address keeps only its domain and a phone number its last four
 *  digits, so a log line still says which provider or line was involved. */
export function redactPersonalText(s: string): string {
  return s.replace(EMAIL_RE, '***@$1').replace(PHONE_RE, '+***$1');
}

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return redactPersonalText(v);
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  // Only plain objects: a Date or Buffer rebuilt field by field would log as {}.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactValue(x, depth + 1);
  return out;
}

/**
 * The last line of defence against personal data in the logs: call sites
 * log user ids, and this masks any email address or phone number that still
 * reaches a log line (a WhatsApp id is a phone number, an error message can
 * quote an address).
 */
export const redactPersonalData = winston.format((info) => {
  const rec = info as Record<string | symbol, unknown>;
  for (const k of Object.keys(rec)) rec[k] = redactValue(rec[k], 0);
  return info;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    // After splat: it merges the original meta back in, Errors included.
    serializeErrorFields(),
    redactPersonalData(),
    winston.format.json(),
  ),
  defaultMeta: { svc: 'chord-server' },
  transports: [
    new DailyRotateFile({ ...rotationOptions('error'), level: 'error' }),
    new DailyRotateFile(rotationOptions('combined')),
  ],
});

export const promptLogMode = resolvePromptLogMode(env.PROMPT_LOG, env.NODE_ENV);

export const promptLogger = winston.createLogger({
  level: 'info',
  silent: promptLogMode === 'off',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new DailyRotateFile(rotationOptions('prompts')),
  ],
});

if (env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, err, ...rest }) => {
          let extra = '';
          const e = err as { stack?: unknown; message?: unknown } | undefined;
          if (err instanceof Error || (e && typeof e === 'object' && typeof e.stack === 'string')) {
            extra = `\n  ${String(e!.stack ?? e!.message)}`;
          } else if (err !== undefined) {
            extra = ` ${JSON.stringify(err)}`;
          } else {
            const keys = Object.keys(rest).filter((k) => k !== 'svc' && k !== 'splat');
            if (keys.length) extra = ` ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, rest[k]])))}`;
          }
          return `${String(timestamp).slice(11, 19)} ${level} ${String(message)}${extra}`;
        }),
      ),
    }),
  );
}
