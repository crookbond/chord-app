/**
 * ADR 0283 / 0079 / 0325 — the two reasons a model call is refused before
 * anything is sent: the user has not agreed to AI, or their allowance is
 * spent. A pass that catches one of these did NOT read anything, so it must
 * not record the item as handled (no extraction mark, no "done" stamp): it
 * waits and is read once the user agrees or has tokens again.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { AiConsentRequiredError, hasAiConsent } from '../ai-consent.service.js';
import { getEntitlement } from '../billing.service.js';

export class AllowanceExhaustedError extends Error {
  constructor(readonly reason: string) {
    super(`AI allowance unavailable (${reason})`);
    this.name = 'AllowanceExhaustedError';
  }
}

export function isAiRefusal(err: unknown): err is AiConsentRequiredError | AllowanceExhaustedError {
  return err instanceof AiConsentRequiredError || err instanceof AllowanceExhaustedError;
}

/**
 * The check a door runs before starting model work for a user: agreed to AI,
 * and (with billing on) an allowance or own key that covers it. The wrapper
 * refuses the same calls; asking first lets a door skip quietly.
 */
export async function canUseAi(db: Kysely<DB>, userId: string): Promise<boolean> {
  if (!(await hasAiConsent(db, userId))) return false;
  if (!env.BILLING_ENABLED) return true;
  return (await getEntitlement(db, userId)).entitled;
}
