/**
 * Seal what already exists (ADR 0201). Run after deploying the code that can
 * read sealed values and after turning CONTENT_ENCRYPTION on, so nothing new is
 * written in plaintext while this catches up.
 *
 * Usage:
 *   npm run encrypt:backfill --workspace=server -- --step attachments
 *   npm run encrypt:backfill --workspace=server -- --step attachments --dry-run
 *
 * Every step is idempotent and resumable: run it again and it skips what is
 * already sealed. Take a database backup and a copy of DATA_DIR/files first;
 * this rewrites files in place.
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import { countPlaintextMail, sealExistingMail } from '../services/encryption/backfill-email.js';
import { countPlaintextDerived, sealExistingDerived } from '../services/encryption/backfill-derived.js';
import { sealExistingAttachments } from '../services/encryption/backfill-files.js';
import { finalizeDerivedEncryption } from '../services/encryption/finalize-derived.js';
import { FinalizeRefused, finalizeEmailEncryption } from '../services/encryption/finalize-email.js';

interface Args {
  step: string;
  dryRun: boolean;
  batch: number;
  vacuum: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { step: '', dryRun: false, batch: 200, vacuum: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--step') a.step = argv[++i] ?? '';
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--batch') a.batch = Math.max(1, Number(argv[++i]) || 200);
    else if (v === '--vacuum') a.vacuum = true;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.step) {
    console.error('usage: npm run encrypt:backfill --workspace=server -- --step <attachments|email|verify|finalize-email|derived|verify-derived|finalize-derived> [--dry-run] [--batch N] [--vacuum]');
    process.exit(2);
  }
  ensureDataDirs();
  const db = openDb();
  try {
    if (args.step === 'attachments') {
      const r = await sealExistingAttachments(db, {
        dryRun: args.dryRun,
        batch: args.batch,
        onProgress: (p) => console.log(`  scanned ${p.scanned}  sealed ${p.sealed}  already ${p.alreadySealed}  missing ${p.missing}  failed ${p.failed}`),
      });
      console.log(`${args.dryRun ? 'Dry run: would seal' : 'Sealed'} ${r.sealed} file(s), ${(r.bytes / 1_048_576).toFixed(1)} MB.`);
      console.log(`Already sealed ${r.alreadySealed}, missing on disk ${r.missing}, failed ${r.failed}.`);
      if (r.failed > 0) process.exitCode = 1;
      return;
    }
    if (args.step === 'email') {
      const r = await sealExistingMail(db, {
        dryRun: args.dryRun,
        batch: Math.min(args.batch, 200),
        onProgress: (p) => console.log(`  messages ${p.messagesSealed}/${p.messagesScanned}  threads ${p.threadsSealed}/${p.threadsScanned}  skipped ${p.skipped}  failed ${p.failed}`),
      });
      console.log(`${args.dryRun ? 'Dry run: would seal' : 'Sealed'} ${r.messagesSealed} message(s) and ${r.threadsSealed} thread(s); skipped ${r.skipped}, failed ${r.failed}.`);
      if (r.failed > 0) process.exitCode = 1;
      return;
    }
    if (args.step === 'verify') {
      const c = await countPlaintextMail(db);
      console.log(c.total === 0 ? 'No readable mail content remains.' : `Readable values remain: ${JSON.stringify(c)}`);
      if (c.total > 0) process.exitCode = 1;
      return;
    }
    if (args.step === 'derived') {
      const r = await sealExistingDerived(db, {
        dryRun: args.dryRun,
        batch: Math.min(args.batch, 200),
        onProgress: (p) => console.log(`  attachments ${p.attachments}  chunks ${p.chunks}  suggestions ${p.proposals}  drafts ${p.drafts}  meetings ${p.meetings}  skipped ${p.skipped}  failed ${p.failed}`),
      });
      console.log(`${args.dryRun ? 'Dry run: would seal' : 'Sealed'} ${r.attachments} attachment(s), ${r.chunks} chunk(s), ${r.proposals} suggestion(s), ${r.drafts} draft(s), ${r.meetings} meeting summary(ies); skipped ${r.skipped}, failed ${r.failed}.`);
      if (r.failed > 0) process.exitCode = 1;
      return;
    }
    if (args.step === 'verify-derived') {
      const c = await countPlaintextDerived(db);
      console.log(c.total === 0 ? 'No readable derived content remains.' : `Readable or unindexed values remain: ${JSON.stringify(c.counts)}`);
      if (c.total > 0) process.exitCode = 1;
      return;
    }
    if (args.step === 'finalize-derived') {
      try {
        const r = await finalizeDerivedEncryption(db, { vacuum: args.vacuum });
        console.log(`Dropped ${r.dropped.join(', ')}${r.vacuumed ? '; tables rewritten' : ''}.`);
      } catch (err) {
        if (err instanceof FinalizeRefused) {
          console.error(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      return;
    }
    if (args.step === 'finalize-email') {
      try {
        const r = await finalizeEmailEncryption(db, { vacuum: args.vacuum });
        console.log(`Dropped ${r.dropped.join(', ')}${r.vacuumed ? '; tables rewritten' : ''}.`);
      } catch (err) {
        if (err instanceof FinalizeRefused) {
          console.error(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      return;
    }
    console.error(`unknown step "${args.step}"`);
    process.exit(2);
  } finally {
    await db.destroy();
  }
}

void main();
