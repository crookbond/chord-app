/**
 * Bot persona registry (ADR 0027).
 *
 * Loads + caches the configured bot persona(s). Phase 1 supports a single
 * `'default'` persona, seeded once from env vars at first boot; the DB row
 * is the source of truth thereafter. The cache is process-local and
 * invalidated by `invalidateBotPersonaCache()` (used by tests).
 *
 * Future Phase 2 (M:N): this is the dispatch entry point. Callers ask
 * for a persona by id or by alias match; today the resolver returns the
 * single configured persona for every query.
 */
import type { Kysely } from 'kysely';

import { logger } from '../config/logging';
import { env } from '../config/env';
import type { DB } from '../db/schema';
import { isToolName, type ToolName } from './bot/tools';

export interface BotPersona {
  id: string;
  displayName: string;
  /** Lowercase aliases — drive `@mention`, imperative, confirm, and /pair regexes. */
  mentionAliases: string[];
  /** Subject the system prompt addresses the bot as ("You are <X>, …"). */
  promptName: string;
  /** Per-persona LLM provider override; NULL = use env `LLM_PROVIDER`. */
  llmProvider: string | null;
  /** Per-persona model override; NULL = use env `OPENAI_MODEL` / `GEMINI_MODEL`. */
  model: string | null;
  /** Subset of registered tool names allowed for this persona; NULL = all. */
  enabledTools: ToolName[] | null;
  /** When false, every mutating tool is stripped regardless of `enabledTools`. */
  writeAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

let cached: BotPersona | null = null;

/**
 * Ensure the deployment's `'default'` persona row exists; called from
 * `server.ts` immediately after `applyMigrations`. Idempotent — on subsequent
 * boots the existing row wins and env vars are ignored. Also populates the
 * cache so {@link getDefaultPersona} can return synchronously.
 */
export async function initBotPersonas(db: Kysely<DB>): Promise<void> {
  const existing = await db
    .selectFrom('bot_personas')
    .selectAll()
    .where('id', '=', env.BOT_PERSONA_ID)
    .executeTakeFirst();

  if (existing) {
    cached = rowToPersona(existing);
  } else {
    cached = await seedDefaultFromEnv(db);
    logger.info(`bot persona: seeded "${cached.id}" from env`, {
      displayName: cached.displayName,
      aliases: cached.mentionAliases,
    });
  }
  validate(cached);
}

/**
 * Synchronous accessor for the active default persona.
 *
 * On a real server boot {@link initBotPersonas} runs first and primes the
 * cache from the DB row (the source of truth). When the cache is empty
 * — primarily under Vitest, which exercises services without booting a
 * server — we lazily synthesize the same persona from env vars without
 * touching the DB. Both paths yield identical values for an unmodified
 * deployment.
 */
export function getDefaultPersona(): BotPersona {
  if (cached) return cached;
  cached = buildDefaultPersonaFromEnv();
  validate(cached);
  return cached;
}

/** Test hook — drops the cached row so the next read re-seeds. */
export function invalidateBotPersonaCache(): void {
  cached = null;
}

function buildDefaultPersonaFromEnv(): BotPersona {
  const now = new Date().toISOString();
  const aliases = parseAliases(env.BOT_MENTION_ALIASES);
  if (aliases.length === 0) {
    throw new Error('BOT_MENTION_ALIASES must list at least one alias');
  }
  const enabledTools = env.BOT_ENABLED_TOOLS.length > 0
    ? env.BOT_ENABLED_TOOLS.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : null;
  return {
    id: env.BOT_PERSONA_ID,
    displayName: env.BOT_DISPLAY_NAME,
    mentionAliases: aliases,
    promptName: env.BOT_PROMPT_NAME || env.BOT_DISPLAY_NAME,
    llmProvider: env.BOT_LLM_PROVIDER || null,
    model: env.BOT_MODEL || null,
    enabledTools: enabledTools as ToolName[] | null,
    writeAllowed: env.BOT_WRITE_ALLOWED,
    createdAt: now,
    updatedAt: now,
  };
}

async function seedDefaultFromEnv(db: Kysely<DB>): Promise<BotPersona> {
  const persona = buildDefaultPersonaFromEnv();
  await db
    .insertInto('bot_personas')
    .values({
      id: persona.id,
      display_name: persona.displayName,
      mention_aliases: JSON.stringify(persona.mentionAliases),
      prompt_name: persona.promptName,
      llm_provider: persona.llmProvider,
      model: persona.model,
      enabled_tools: persona.enabledTools ? JSON.stringify(persona.enabledTools) : null,
      write_allowed: persona.writeAllowed ? 1 : 0,
      created_at: persona.createdAt,
      updated_at: persona.updatedAt,
    })
    .execute();
  return persona;
}

function rowToPersona(row: {
  id: string;
  display_name: string;
  mention_aliases: string;
  prompt_name: string;
  llm_provider: string | null;
  model: string | null;
  enabled_tools: string | null;
  write_allowed: number;
  created_at: string;
  updated_at: string;
}): BotPersona {
  return {
    id: row.id,
    displayName: row.display_name,
    mentionAliases: parseAliases(row.mention_aliases),
    promptName: row.prompt_name,
    llmProvider: row.llm_provider,
    model: row.model,
    enabledTools: row.enabled_tools ? (JSON.parse(row.enabled_tools) as ToolName[]) : null,
    writeAllowed: row.write_allowed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Accept both `["a","b"]` JSON and comma-separated `a,b` for resilience. */
function parseAliases(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s).trim().toLowerCase()).filter((s) => s.length > 0);
      }
    } catch {
      // fall through to comma split
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function validate(persona: BotPersona): void {
  if (persona.mentionAliases.length === 0) {
    throw new Error(`bot persona "${persona.id}": mentionAliases is empty`);
  }
  if (persona.enabledTools) {
    const bad = persona.enabledTools.filter((name) => !isToolName(name));
    if (bad.length > 0) {
      throw new Error(
        `bot persona "${persona.id}": unknown tool name(s) in enabled_tools: ${bad.join(', ')}`,
      );
    }
  }
  if (!persona.displayName) {
    throw new Error(`bot persona "${persona.id}": displayName required`);
  }
  if (!persona.promptName) {
    throw new Error(`bot persona "${persona.id}": promptName required`);
  }
}
