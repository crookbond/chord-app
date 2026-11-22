import fs from 'node:fs';
import { env } from '../config/env.js';

export function ensureDataDirs(): void {
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.mkdirSync(env.FILES_DIR, { recursive: true });
  fs.mkdirSync(env.LOGS_DIR, { recursive: true });
}
