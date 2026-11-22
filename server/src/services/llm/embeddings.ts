/**
 * Text -> vectors, for meaning-based search (ADR 0276).
 *
 * Whose key embeds a user's mail follows ADR 0257 (their own when they have
 * one), with one twist: a vector is only comparable with vectors from the SAME
 * model, so each user's rows carry the model id they were made with and a
 * search compares only those. Different users may use different models; one
 * user's mail is always one model.
 *
 *   no own key                       Chord's embedding key
 *   own OpenRouter / OpenAI key      their key, the same model Chord uses
 *   own Gemini key                   their key, Google's embedding model
 *   own Anthropic key                Anthropic has no embeddings API: Chord's
 *                                    key (EMBEDDINGS_BYOK_FALLBACK=chord) or
 *                                    keyword search only ('none')
 *
 * Chord's key is configured apart from its chat model, so moving chat to a
 * provider without embeddings does not switch meaning search off.
 */
import OpenAI from 'openai';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { isOpenAiUrl, isOpenRouterUrl } from '../../utils/model-host.js';
import { modelEndpointFetch } from '../../utils/ssrf.js';
import { hasAiConsent } from '../ai-consent.service.js';
import { getEntitlement } from '../billing.service.js';
import { readUserModelKey } from './factory.js';

export type EmbedPurpose = 'document' | 'query';

export interface Embedder {
  /** Model identity stored on every vector; only equal ids are compared. */
  id: string;
  dims: number;
  /** Whose key pays. */
  paidBy: 'user' | 'chord';
  /**
   * Counts against the user's allowance: Chord's key for a user without their
   * own. Never for a BYOK user - not even when Chord's key embeds for one whose
   * key cannot (that cost is Chord's, ADR 0257).
   */
  metered: boolean;
  /** `costUsd`: dollars billed, when the provider says (OpenRouter, ADR 0332). */
  embed(texts: string[], purpose: EmbedPurpose): Promise<{ vectors: Float32Array[]; tokens: number; costUsd?: number }>;
}

/** Unit length, cut to `dims` first: text-embedding-3 and gemini-embedding are trained to be cut. */
export function fitVector(v: ArrayLike<number>, dims: number): Float32Array {
  const out = new Float32Array(Math.min(dims, v.length));
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = v[i];
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}


/** OpenRouter adds `cost` (dollars) to an embeddings usage block too. */
function costOf(usage: unknown): { costUsd?: number } {
  const cost = (usage as { cost?: unknown } | undefined)?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {};
}

/** The model name without a vendor prefix: the same model on OpenRouter and on OpenAI. */
const bareModel = (m: string) => m.replace(/^openai\//, '');

export class OpenAICompatEmbedder implements Embedder {
  readonly id: string;
  readonly dims: number;
  readonly paidBy: 'user' | 'chord';
  metered = false;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly openRouter: boolean;

  constructor(opts: { apiKey: string; baseURL: string; model: string; dims: number; paidBy: 'user' | 'chord' }) {
    this.dims = opts.dims;
    this.paidBy = opts.paidBy;
    this.openRouter = isOpenRouterUrl(opts.baseURL);
    this.model = this.openRouter ? `openai/${bareModel(opts.model)}` : bareModel(opts.model);
    this.id = `${bareModel(opts.model)}@${opts.dims}`;
    // A user's own key is screened on every request, as the chat client is
    // (ADR 0269); Chord's own configured endpoint is not.
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      fetch: opts.paidBy === 'user' ? modelEndpointFetch() : undefined,
    });
  }

  async embed(texts: string[]): Promise<{ vectors: Float32Array[]; tokens: number; costUsd?: number }> {
    const body = {
      model: this.model,
      input: texts,
      dimensions: this.dims,
      encoding_format: 'float' as const,
      // OpenRouter: only route to hosts that do not keep or train on the text.
      ...(this.openRouter ? { provider: { data_collection: 'deny' } } : {}),
    };
    const res = await this.client.embeddings.create(body as OpenAI.EmbeddingCreateParams);
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    return {
      vectors: ordered.map((d) => fitVector(d.embedding, this.dims)),
      tokens: res.usage?.prompt_tokens ?? 0,
      ...costOf(res.usage),
    };
  }
}

/** Google's REST endpoint directly: the SDK has no output-size field. */
export class GeminiEmbedder implements Embedder {
  readonly id: string;
  readonly paidBy = 'user' as const;
  readonly metered = false;
  private static readonly MODEL = 'gemini-embedding-001';

  constructor(
    private readonly apiKey: string,
    readonly dims = 768,
  ) {
    this.id = `${GeminiEmbedder.MODEL}@${dims}`;
  }

  async embed(texts: string[], purpose: EmbedPurpose): Promise<{ vectors: Float32Array[]; tokens: number }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GeminiEmbedder.MODEL}:batchEmbedContents`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${GeminiEmbedder.MODEL}`,
          content: { parts: [{ text }] },
          taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          outputDimensionality: this.dims,
        })),
      }),
    });
    if (!res.ok) throw new Error(`gemini embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { embeddings?: Array<{ values: number[] }> };
    const vectors = (json.embeddings ?? []).map((e) => fitVector(e.values, this.dims));
    if (vectors.length !== texts.length) throw new Error('gemini embed: wrong number of vectors');
    // The batch endpoint reports no usage; a rough count keeps the meter honest.
    return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }
}

/**
 * Deterministic stand-in for tests and LLM_PROVIDER=mock demos: hashed words,
 * with a handful of synonyms so "excursion" lands near "trip". It shows the
 * pipeline works; it says nothing about how good a real model is.
 */
const MOCK_SYNONYMS: Record<string, string> = {
  excursion: 'trip', outing: 'trip', paperwork: 'form', slip: 'form', permission: 'form',
  kids: 'child', children: 'child', pipe: 'plumb', leak: 'plumb', plumber: 'plumb', plumbing: 'plumb',
  estimate: 'quote', teeth: 'dental', dentist: 'dental', cleaning: 'dental',
  plane: 'flight', tickets: 'flight', ticket: 'flight', airline: 'flight', airlines: 'flight',
};

const MOCK_STOP = new Set([
  'the', 'and', 'for', 'from', 'with', 'about', 'this', 'that', 'your', 'you', 'mail', 'email', 'emails',
  'message', 'messages', 'subject', 'what', 'did', 'send', 'sent', 'need', 'any', 'read', 'will', 'are', 'has',
]);

export class MockEmbedder implements Embedder {
  readonly id = 'mock@256';
  readonly dims = 256;
  readonly paidBy = 'chord' as const;
  metered = false;

  async embed(texts: string[]): Promise<{ vectors: Float32Array[]; tokens: number }> {
    return { vectors: texts.map((t) => this.one(t)), tokens: 0 };
  }

  private one(text: string): Float32Array {
    const v = new Array<number>(this.dims).fill(0);
    for (const raw of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      if (MOCK_STOP.has(raw)) continue;
      const w = MOCK_SYNONYMS[raw] ?? raw.replace(/(ing|ed|es|s)$/, '');
      let h = 2166136261;
      for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      v[(h >>> 0) % this.dims] += 1;
    }
    return fitVector(v, this.dims);
  }
}

let warnedNoKey = false;

/** Chord's own embedding key, or null when none is configured. */
function chordEmbedder(): Embedder | null {
  if (env.LLM_PROVIDER === 'mock') return new MockEmbedder();
  const apiKey = env.EMBEDDINGS_API_KEY || (env.LLM_PROVIDER === 'openai' ? env.OPENAI_API_KEY : '');
  const baseURL = env.EMBEDDINGS_BASE_URL || (env.LLM_PROVIDER === 'openai' ? env.OPENAI_BASE_URL : 'https://api.openai.com/v1');
  if (!apiKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      logger.warn('meaning search is off for users without their own embedding key: set EMBEDDINGS_API_KEY (ADR 0276)');
    }
    return null;
  }
  return new OpenAICompatEmbedder({ apiKey, baseURL, model: env.EMBEDDINGS_MODEL, dims: env.EMBEDDINGS_DIMS, paidBy: 'chord' });
}

/**
 * THE place that picks whose key embeds a user's text (ADR 0257's rule, for
 * vectors). Null means this user gets keyword search only.
 */
export async function getEmbedderForUser(db: Kysely<DB>, userId: string): Promise<Embedder | null> {
  if (!env.EMBEDDINGS_ENABLED) return null;
  // ADR 0283 — no consent, no vectors: keyword search only.
  if (!(await hasAiConsent(db, userId))) return null;
  if (env.LLM_PROVIDER === 'mock') return new MockEmbedder();
  const own = await readUserModelKey(db, userId);
  if (!own) {
    // ADR 0079/0325 — Chord's key is metered against the allowance; with
    // none left, keyword search only (as with no consent).
    if (env.BILLING_ENABLED && !(await getEntitlement(db, userId)).entitled) return null;
    const e = chordEmbedder();
    if (e instanceof OpenAICompatEmbedder) e.metered = true;
    return e;
  }
  if (own.provider === 'gemini') return new GeminiEmbedder(own.apiKey);
  if (own.provider === 'openai') {
    const baseURL = own.baseURL ?? 'https://api.openai.com/v1';
    // OpenRouter and OpenAI serve the same model, so the user's key makes the
    // same vectors Chord's would. Any other OpenAI-compatible host (Ollama,
    // vLLM) has no known embedding model: treated like a key that cannot embed.
    if (isOpenRouterUrl(baseURL) || isOpenAiUrl(baseURL)) {
      return new OpenAICompatEmbedder({ apiKey: own.apiKey, baseURL, model: env.EMBEDDINGS_MODEL, dims: env.EMBEDDINGS_DIMS, paidBy: 'user' });
    }
  }
  return env.EMBEDDINGS_BYOK_FALLBACK === 'chord' ? chordEmbedder() : null;
}
