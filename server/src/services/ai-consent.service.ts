/**
 * ADR 0283 — the user's answer to "may Chord send your data to an AI
 * provider" (Apple 5.1.2(i)). No model or embedding call runs on a user's
 * data until it is `granted`; the model choke points (`getLlmForUser`,
 * `resolveTurnLlm`, `getEmbedderForUser`) and the main AI entry points read
 * `hasAiConsent`.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { AiConsent } from '@chord/kernel';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { defineUserDefault } from './user-defaults.service.js';

export const aiConsentDefault = defineUserDefault(
  'ai_consent',
  z.object({
    decision: z.enum(['granted', 'declined']),
    at: z.string(),
    recipient: z.string().max(500),
    ageConfirmed: z.boolean(),
  }),
);

export class AiConsentRequiredError extends Error {
  constructor() {
    super('AI consent not given (ADR 0283)');
    this.name = 'AiConsentRequiredError';
  }
}

export async function getAiConsent(db: Kysely<DB>, userId: string): Promise<AiConsent | null> {
  return aiConsentDefault.get(db, userId);
}

/** True when AI may run on this user's data. No user (system work) always may. */
export async function hasAiConsent(db: Kysely<DB> | null | undefined, userId: string | null | undefined): Promise<boolean> {
  if (!env.AI_CONSENT_REQUIRED || !db || !userId) return true;
  return (await aiConsentDefault.get(db, userId))?.decision === 'granted';
}

export type SetAiConsentResult =
  | { ok: true; consent: AiConsent }
  | { ok: false; reason: 'age_not_confirmed' };

/**
 * Record a decision. Granting needs the age statement, now or from an
 * earlier answer; declining never does (saying no must always work).
 */
export async function setAiConsent(
  db: Kysely<DB>,
  userId: string,
  input: { decision: 'granted' | 'declined'; ageConfirmed?: boolean; recipient: string },
): Promise<SetAiConsentResult> {
  const prior = await aiConsentDefault.get(db, userId);
  const ageConfirmed = input.ageConfirmed === true || prior?.ageConfirmed === true;
  if (input.decision === 'granted' && !ageConfirmed) return { ok: false, reason: 'age_not_confirmed' };
  const consent: AiConsent = {
    decision: input.decision,
    at: new Date().toISOString(),
    recipient: input.recipient.slice(0, 500),
    ageConfirmed,
  };
  await aiConsentDefault.set(db, userId, consent);
  return { ok: true, consent };
}

/**
 * The two words a chat reply can answer the consent message with, read in
 * code because no model may run before the answer. Anything else is null.
 */
export function parseChatConsentReply(body: string | null | undefined): 'granted' | 'declined' | null {
  const t = (body ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@chord\s+/, '')
    .replace(/[.!\s]+$/, '');
  if (/^(i\s+)?agree$/.test(t)) return 'granted';
  if (/^(no|decline|i\s+decline)$/.test(t)) return 'declined';
  return null;
}

/** The fixed message a bot turn posts instead of running a model. */
export function chatConsentPrompt(recipient: string, consent: AiConsent | null, personal: boolean): string {
  if (!personal) {
    return consent?.decision === 'declined'
      ? 'Chord’s AI is off for you, so I can’t answer here. Turn it on in Settings → AI model, or reply AGREE in your own chat with Chord.'
      : 'Before Chord’s AI can answer you, it needs your OK. Open the Chord app, or reply AGREE in your own chat with Chord.';
  }
  if (consent?.decision === 'declined') {
    return (
      'Chord’s AI is off for your account, so I can’t read or answer messages. ' +
      `To turn it on, reply AGREE — your messages, email, calendar and files are then sent to ${recipient} to be processed. ` +
      'You can also change this in Settings → AI model.'
    );
  }
  return (
    'Before Chord’s AI can help you, it needs your OK. ' +
    `To answer you, sort your email, suggest to-dos and write your morning briefing, Chord sends your messages, email, calendar and files to ${recipient}. ` +
    'It is used only to run Chord for you — never sold or used for advertising. ' +
    'Reply AGREE to allow it (by agreeing you confirm you are 18 or older, or a parent or guardian has agreed to let you use Chord), or NO to keep AI off. ' +
    'Privacy policy: https://chordapp.ai/privacy'
  );
}

export function chatConsentRecorded(decision: 'granted' | 'declined'): string {
  return decision === 'granted'
    ? 'Thanks — Chord’s AI is on. Send your question again and I’ll answer it. You can turn this off any time in Settings → AI model.'
    : 'OK — Chord’s AI stays off. Your mail, calendar and lists still work in the app. Reply AGREE any time to turn it on.';
}
