/**
 * Dogfood people/family extraction (ADR 0076) against a real mailbox.
 *
 * The F&F plan flags that `EMAIL_PERSONS_ENABLED` (default on) has never been
 * verified against real mail. This runs the REAL `runPersonExtraction` pass
 * over whatever is already in a user's `email_threads` mirror and prints, per
 * thread, what the model returned and what the pass would stage — so you can
 * see before anything is written.
 *
 * Dry run by default: the whole pass runs inside a transaction that is rolled
 * back, so no proposals, people, memories, or `person_processed_at` marks
 * persist. `--commit` keeps them.
 *
 * Usage:
 *   npm run dogfood:persons --workspace=server -- --user you@example.com
 *   npm run dogfood:persons --workspace=server -- --user <userId> --limit 50
 *   npm run dogfood:persons --workspace=server -- --user you@example.com --commit
 *   npm run dogfood:persons --workspace=server -- --user <userId> --json
 *
 * Thread subjects and sender addresses are masked in the output unless
 * `--show-content` is passed. The extracted people/facts are the thing being
 * reviewed, so they always print.
 *
 * Needs a real LLM key (the pass uses the system provider via `getLlm()`).
 * With `LLM_PROVIDER=mock` the wiring runs but the model returns no people.
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.js';
import { env } from '../config/env.js';
import { maskSender, maskSubject } from '../utils/prompt-log.js';
import { deterministicPathFor } from '../services/email/llm-classifier.js';
import { minablePredicate } from '../services/email/bulk-gate.js';
import { provisionalFactsFor } from '../services/people.service.js';
import {
  crossAccountMarkQuery,
  extractionMarkQuery,
} from '../services/email/magics.service.js';
import {
  llmPersonExtractor,
  NOREPLY_RE,
  runPersonExtraction,
  type ExtractedPerson,
  type PersonExtractor,
  type PersonThreadInput,
} from '../services/email/person-extraction.js';

class Rollback extends Error {}

interface Staged {
  personProposals: Array<Record<string, unknown>>;
  dateProposals: Array<Record<string, unknown>>;
  memories: Array<{ key: string; value: string; status: string }>;
  /** Facts attached to a `people` row (subject_type='person') — not visible in `memories`,
   *  which only covers rows on the asker's own persona. */
  personFacts: Array<{ person: string; key: string; value: string; status: string }>;
  /** docs/notes/0191 — unconfirmed people waiting on their add_person card, with the facts riding on them. */
  provisionalPeople: Array<{ name: string; email: string | null; facts: Array<{ key: string; value: string }> }>;
  autoPeople: Array<{ display_name: string; email: string | null }>;
}

interface Args {
  user: string;
  limit: number;
  commit: boolean;
  json: boolean;
  showContent: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { user: '', limit: 30, commit: false, json: false, showContent: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--user') a.user = argv[++i] ?? '';
    else if (v === '--limit') a.limit = Math.max(1, Math.min(200, Number(argv[++i]) || 30));
    else if (v === '--commit') a.commit = true;
    else if (v === '--json') a.json = true;
    else if (v === '--show-content') a.showContent = true;
    else if (v === '--help' || v === '-h') a.user = '';
  }
  return a;
}

async function resolveUser(
  db: Kysely<DB>,
  ref: string,
): Promise<{ id: string; email: string | null; display_name: string | null } | null> {
  const byId = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name'])
    .where('id', '=', ref)
    .executeTakeFirst();
  if (byId) return byId;
  return (
    (await db
      .selectFrom('users')
      .select(['id', 'email', 'display_name'])
      .where('email', 'ilike', ref)
      .executeTakeFirst()) ?? null
  );
}

/** Wraps the production extractor and records every (input → output) pair. */
function recordingExtractor(
  inner: PersonExtractor,
): { extractor: PersonExtractor; calls: Array<{ input: PersonThreadInput; out: ExtractedPerson[] }> } {
  const calls: Array<{ input: PersonThreadInput; out: ExtractedPerson[] }> = [];
  return {
    calls,
    extractor: {
      async extract(input) {
        const out = await inner.extract(input);
        calls.push({ input, out });
        return out;
      },
    },
  };
}

function personLine(p: ExtractedPerson): string {
  const bits = [`${p.name}`];
  if (p.relationship) bits.push(`(${p.relationship})`);
  bits.push(`conf ${p.confidence.toFixed(2)}`);
  if (p.email) bits.push(p.email);
  if (p.dates?.length) bits.push(`dates: ${p.dates.map((d) => `${d.kind} ${d.date}`).join(', ')}`);
  if (p.facts?.length) bits.push(`facts: ${p.facts.map((f) => `${f.key}=${f.value}`).join(', ')}`);
  return bits.join(' · ');
}

function fromLineFor(show: boolean) {
  return (name: string | null | undefined, email: string | null | undefined): string =>
    show ? `${name ?? ''} <${email ?? ''}>`.trim() : maskSender(email, false);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fromLine = fromLineFor(args.showContent);
  if (!args.user) {
    console.error(
      'usage: npm run dogfood:persons --workspace=server -- --user <email|userId> [--limit N] [--commit] [--json] [--show-content]',
    );
    process.exit(2);
  }

  ensureDataDirs();
  const db = openDb();
  try {
    const user = await resolveUser(db, args.user);
    if (!user) {
      console.error(`no user matches "${args.user}"`);
      process.exit(1);
    }

    // Same selection `runPersonExtraction` uses — shown so the report can say
    // how many candidates existed vs. how many reached the model.
    const candidates = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id as gid', 'subject', 'from_name', 'from_email', 'last_message_at'])
      .where('user_id', '=', user.id)
      .where((eb) => eb.not(eb.exists(extractionMarkQuery(eb, user.id, 'person'))))
      .where((eb) => eb.not(eb.exists(crossAccountMarkQuery(eb, user.id, 'person'))))
      .where('is_archived', '=', 0)
      .where(minablePredicate(user.id))
      .orderBy('last_message_at', 'desc')
      .limit(args.limit)
      .execute();

    const skipped = candidates
      .map((t) => {
        if (deterministicPathFor(t.from_email) !== null) return { t, why: 'bulk sender (deterministic path)' };
        if (NOREPLY_RE.test(t.from_email ?? '')) return { t, why: 'no-reply / automation' };
        return null;
      })
      .filter((x): x is { t: (typeof candidates)[number]; why: string } => x !== null);
    const reachModel = candidates.length - skipped.length;

    const provider = env.LLM_PROVIDER;
    const rec = recordingExtractor(llmPersonExtractor());

    // Mutated inside the transaction closure; a const object's properties are
    // observed across the closure boundary where a reassigned `let` is not.
    const out: {
      staged?: Staged;
      result?: Awaited<ReturnType<typeof runPersonExtraction>>;
    } = {};

    const before = {
      proposalIds: new Set(
        (
          await db
            .selectFrom('proposals')
            .select('id')
            .where('proposed_by_user_id', '=', user.id)
            .where('tool_name', 'in', ['add_person', 'add_important_date'])
            .execute()
        ).map((r) => r.id),
      ),
      peopleIds: new Set(
        (await db.selectFrom('people').select('id').where('owner_user_id', '=', user.id).execute()).map(
          (r) => r.id,
        ),
      ),
      memoryIds: new Set(
        (
          await db
            .selectFrom('memories')
            .select('id')
            .where('persona_id', '=', user.id)
            .where('source', '=', 'extracted')
            .execute()
        ).map((r) => r.id),
      ),
      personMemoryIds: new Set(
        (
          await db
            .selectFrom('memories')
            .select('id')
            .where('subject_type', '=', 'person')
            .where('subject_id', 'in', db.selectFrom('people').select('id').where('owner_user_id', '=', user.id))
            .execute()
        ).map((r) => r.id),
      ),
    };

    try {
      await db.transaction().execute(async (trx) => {
        out.result = await runPersonExtraction(trx, user.id, {
          extractor: rec.extractor,
          limit: args.limit,
        });

        const newProposals = await trx
          .selectFrom('proposals')
          .select(['id', 'tool_name', 'args_json'])
          .where('proposed_by_user_id', '=', user.id)
          .where('tool_name', 'in', ['add_person', 'add_important_date'])
          .execute();
        const newPeople = await trx
          .selectFrom('people')
          .select(['id', 'display_name', 'email'])
          .where('owner_user_id', '=', user.id)
          .execute();
        const newMemories = await trx
          .selectFrom('memories')
          .select(['id', 'key', 'value', 'status'])
          .where('persona_id', '=', user.id)
          .where('source', '=', 'extracted')
          .execute();
        const newPersonMemories = await trx
          .selectFrom('memories')
          .innerJoin('people', 'people.id', 'memories.subject_id')
          .select(['memories.id as id', 'people.display_name as person', 'memories.key as key', 'memories.value as value', 'memories.status as status'])
          .where('memories.subject_type', '=', 'person')
          .where('people.owner_user_id', '=', user.id)
          .execute();
        const provisionalRows = await trx
          .selectFrom('provisional_people')
          .select(['id', 'display_name', 'email'])
          .where('owner_user_id', '=', user.id)
          .execute();
        const provisionalFacts = await provisionalFactsFor(
          trx,
          provisionalRows.map((r) => r.id),
        );

        out.staged = {
          provisionalPeople: provisionalRows.map((r) => ({
            name: r.display_name,
            email: r.email,
            facts: provisionalFacts.get(r.id) ?? [],
          })),
          personProposals: newProposals
            .filter((r) => !before.proposalIds.has(r.id) && r.tool_name === 'add_person')
            .map((r) => JSON.parse(r.args_json) as Record<string, unknown>),
          dateProposals: newProposals
            .filter((r) => !before.proposalIds.has(r.id) && r.tool_name === 'add_important_date')
            .map((r) => JSON.parse(r.args_json) as Record<string, unknown>),
          memories: newMemories
            .filter((r) => !before.memoryIds.has(r.id))
            .map((r) => ({ key: r.key, value: r.value, status: r.status })),
          personFacts: newPersonMemories
            .filter((r) => !before.personMemoryIds.has(r.id))
            .map((r) => ({ person: r.person, key: r.key, value: r.value, status: r.status })),
          autoPeople: newPeople
            .filter((r) => !before.peopleIds.has(r.id))
            .map((r) => ({ display_name: r.display_name, email: r.email ?? null })),
        };

        if (!args.commit) throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    const report = {
      user: { id: user.id, email: user.email, name: user.display_name },
      mode: args.commit ? 'COMMIT (writes persisted)' : 'dry run (rolled back)',
      llmProvider: provider,
      candidates: candidates.length,
      reachedModel: reachModel,
      skipped: skipped.map((s) => ({
        from: maskSender(s.t.from_email, args.showContent),
        subject: maskSubject(s.t.subject, args.showContent),
        why: s.why,
      })),
      perThread: rec.calls.map((c) => ({
        from: fromLine(c.input.fromName, c.input.fromEmail),
        subject: maskSubject(c.input.subject, args.showContent),
        persons: c.out.map(personLine),
      })),
      staged: out.staged ?? null,
      totals: out.result ?? null,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const L = console.log;
    L('');
    L(`Dogfood — people/family extraction`);
    L(`  user:      ${user.display_name ?? '(no name)'} <${user.email ?? '?'}>  [${user.id}]`);
    L(`  mode:      ${report.mode}`);
    L(`  LLM:       ${provider}${provider === 'mock' ? '  (mock returns no people — wiring only)' : ''}`);
    L('');
    L(`Candidates in scope (limit ${args.limit}): ${candidates.length}`);
    L(`  reached the model: ${reachModel}`);
    L(`  skipped pre-model: ${skipped.length}`);
    for (const s of skipped.slice(0, 12)) {
      L(`    - [${s.why}] ${maskSender(s.t.from_email, args.showContent)}  "${maskSubject(s.t.subject, args.showContent)}"`);
    }
    if (skipped.length > 12) L(`    … and ${skipped.length - 12} more`);
    L('');
    L(`Per thread (${rec.calls.length} model calls):`);
    for (const c of rec.calls) {
      L(`  ${maskSubject(c.input.subject, args.showContent)}`);
      L(`    from: ${fromLine(c.input.fromName, c.input.fromEmail)}`);
      if (c.out.length === 0) L(`    → (no people)`);
      for (const p of c.out) L(`    → ${personLine(p)}`);
    }
    L('');
    L(`Would stage${args.commit ? ' (PERSISTED)' : ''}:`);
    L(`  bootstrap auto-writes (people): ${out.staged?.autoPeople.length ?? 0}`);
    for (const p of out.staged?.autoPeople ?? [])
      L(`    + ${p.display_name}${p.email ? ` <${p.email}>` : ''}`);
    L(`  add_person proposals: ${out.staged?.personProposals.length ?? 0}`);
    for (const p of out.staged?.personProposals ?? [])
      L(`    ? ${p.displayName as string}${p.notes ? `  — ${p.notes as string}` : ''}`);
    L(`  add_important_date proposals: ${out.staged?.dateProposals.length ?? 0}`);
    for (const d of out.staged?.dateProposals ?? [])
      L(`    ? ${d.personName as string}: ${d.kind as string} ${d.date as string}`);
    L(`  memory proposals/writes: ${out.staged?.memories.length ?? 0}`);
    for (const m of out.staged?.memories ?? [])
      L(`    ${m.status === 'confirmed' ? '+' : '?'} ${m.key} = ${m.value}`);
    L(`  provisional people (awaiting their card): ${out.staged?.provisionalPeople.length ?? 0}`);
    for (const pp of out.staged?.provisionalPeople ?? []) {
      L(`    ? ${pp.name}${pp.email ? ` <${pp.email}>` : ''}`);
      for (const f of pp.facts) L(`        · ${f.key} = ${f.value}`);
    }
    L(`  facts attached to a person: ${out.staged?.personFacts.length ?? 0}`);
    for (const f of out.staged?.personFacts ?? [])
      L(`    ${f.status === 'confirmed' ? '+' : '?'} ${f.person}: ${f.key} = ${f.value}`);
    L('');
    L(`Totals: ${JSON.stringify(out.result ?? null)}`);
    L('');
    L(
      args.commit
        ? `Committed. Re-run without --commit to preview future syncs.`
        : `Dry run — nothing written. Re-run with --commit to keep it.`,
    );
    L(`Findings + runbook: docs/tasks/persons-dogfood.md`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
