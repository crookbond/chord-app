/**
 * Snapshot of the deploy-wide LLM config for the mobile UI's "system
 * configured" hint. We don't return the API key — only enough to
 * answer "is system available, and which provider/model is it."
 *
 * Lives here rather than in the settings route because the OpenRouter connect
 * flow (ADR 0235) also needs to know which model the app uses today.
 */
import type { MeSettings } from '@chord/kernel';

import { env } from '../../config/env.js';

export function describeSystemLlm(): MeSettings['systemLlm'] {
  if (env.LLM_PROVIDER === '') return null;
  if (env.LLM_PROVIDER === 'openai') {
    const isDefault = env.OPENAI_BASE_URL === 'https://api.openai.com/v1';
    return {
      provider: 'openai',
      model: env.OPENAI_MODEL,
      baseUrl: isDefault ? null : env.OPENAI_BASE_URL,
    };
  }
  if (env.LLM_PROVIDER === 'gemini') {
    return { provider: 'gemini', model: env.GEMINI_MODEL, baseUrl: null };
  }
  if (env.LLM_PROVIDER === 'anthropic') {
    return {
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL,
      baseUrl: env.ANTHROPIC_BASE_URL || null,
    };
  }
  if (env.LLM_PROVIDER === 'mock') {
    return { provider: 'mock', model: 'mock', baseUrl: null };
  }
  return null;
}
