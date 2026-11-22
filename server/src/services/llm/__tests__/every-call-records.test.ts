/**
 * ADR 0324 — every model call made for a user writes a `token_usage` row.
 *
 * That table is the allowance (ADR 0196): a call that records nothing is free
 * to the user, paid by Chord, and makes the usage and remaining numbers wrong.
 * For months the briefing, nudges, memory extraction, attachment reading, the
 * upload classifiers, form filling, meeting context and WhatsApp import all
 * did exactly that. Most calls now record by construction - `getLlmForUser`
 * needs a source and wraps Chord's key - but a model can also be reached
 * through `resolveTurnLlm` or handed in as a parameter, and nothing in the
 * type system says that path recorded.
 *
 * So every file that calls a model is listed here with how its calls are
 * recorded, and the NUMBER of calls is pinned. A new `.complete(` or
 * `.stream(` - in a new file or an old one - fails this test until someone
 * adds it here and says how it is counted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const VIA_FACTORY = "model from getLlmForUser(db, userId, '<source>') - recorded by withUsageRecording";

/** file -> number of model calls in it, and how each is recorded. */
const LEDGER: Record<string, { calls: number; how: string }> = {
  'services/proactive.service.ts': { calls: 3, how: `${VIA_FACTORY}: nudge, briefing (loop + single shot)` },
  'services/bot/extraction.ts': { calls: 1, how: `${VIA_FACTORY}: memory_extract` },
  'services/attachments.extract.ts': {
    calls: 3,
    how: `text, vision, summary on the llm attachments.service passes in: ${VIA_FACTORY}: attachment_read`,
  },
  'services/bot/content_classifier.ts': { calls: 1, how: `${VIA_FACTORY}: content_classify` },
  'services/bot/trip_classifier.ts': {
    calls: 2,
    how: `llm handed in by classifyAndAutoFileAttachment and email/trip-extraction: ${VIA_FACTORY}: trip_classify`,
  },
  'services/bot/executor.ts': { calls: 1, how: `look_at_attachment: ${VIA_FACTORY}: attachment_read` },
  'services/forms.service.ts': { calls: 1, how: `llm handed in by the executor: ${VIA_FACTORY}: form_fill` },
  'services/events/meeting-context.ts': { calls: 1, how: `${VIA_FACTORY}: meeting_context` },
  'services/ingest/whatsapp/extract.ts': { calls: 1, how: `llm handed in by the pipeline: ${VIA_FACTORY}: whatsapp_import` },
  'services/email/llm-classifier.ts': { calls: 1, how: `${VIA_FACTORY}: email_classify` },
  'services/email/magics.service.ts': { calls: 1, how: `${VIA_FACTORY}: email_magics` },
  'services/email/person-extraction.ts': { calls: 1, how: `${VIA_FACTORY}: email_persons` },
  'services/bot/bot.service.ts': { calls: 2, how: 'chat turn: resolveTurnLlm tier + recordTokenUsage (bot_turn)' },
  'services/email/compose-reply.service.ts': {
    calls: 1,
    how: 'resolveTurnLlm tier + recordTokenUsage (email_reply / email_summary)',
  },
  'services/memory-cleanup.service.ts': { calls: 1, how: 'resolveTurnLlm tier + recordTokenUsage (memory_cleanup)' },
  'services/bot/query-understanding.ts': {
    calls: 2,
    how: 'only the retrieval-eval script calls these, with its own model: no user to charge',
  },
  'services/llm/factory.ts': {
    calls: 3,
    how: 'validating a key the user is saving (their own key, never recorded); the allowance gate passes the call through',
  },
  'services/llm/key-health.ts': { calls: 2, how: 'wrapper: passes the call through' },
  'services/llm/with-date-stamp.ts': { calls: 2, how: 'wrapper: passes the call through' },
  'services/llm/usage-recording.ts': { calls: 2, how: 'the recorder itself' },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // retrieval-eval is the eval harness: it builds its own model, no user.
      if (['__tests__', '__test-helpers__', 'node_modules', 'scripts', 'retrieval-eval'].includes(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const MODEL_CALL = /\.(complete|stream)\s*\(/g;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

function modelCallsByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (COMMENT.test(line)) continue;
      n += line.match(MODEL_CALL)?.length ?? 0;
    }
    if (n > 0) out[rel] = n;
  }
  return out;
}

describe('every model call is recorded', () => {
  it('every file that calls a model is in the ledger, with its exact number of calls', () => {
    const found = modelCallsByFile();
    const expected = Object.fromEntries(Object.entries(LEDGER).map(([f, v]) => [f, v.calls]));
    expect(found).toEqual(expected);
  });

  it('a file that picks its model by tier records the turn itself', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      if (!/\bresolveTurnLlm\s*\(/.test(text) || rel === 'services/llm/factory.ts') continue;
      // billing-status only reads the tier to display it; it calls no model.
      if (rel === 'services/billing-status.service.ts') continue;
      // findings-chat runs its turn through bot.service's runSideChatTurn.
      if (rel === 'services/email/findings-chat.service.ts' && /runSideChatTurn/.test(text)) continue;
      if (!/\brecordTokenUsage\s*\(|\brecordRun\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
