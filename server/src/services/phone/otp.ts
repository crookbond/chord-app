/**
 * SMS-OTP verification (ADR 0064). Twilio Verify only, by design.
 *
 * There was a `mock` provider here that "sent" a fixed code from
 * `PHONE_VERIFY_MOCK_CODE` (`000000`). It was removed rather than merely
 * discouraged: a fixed code makes "verified" meaningless, and a verified
 * number is a real identity claim — it drives contact discovery (ADR 0065),
 * claims the matching WhatsApp identity, and can take a number off another
 * account. Under the mock, any signed-in user could have typed a stranger's
 * number and taken all three. It shipped to production once, which is the
 * argument against keeping a "dev only" fixed-code path at all.
 *
 * So there is no fallback. If Twilio Verify is not configured the feature is
 * OFF and the routes say so — verification never silently degrades to
 * something that proves nothing. Tests inject their own provider through the
 * `provider` parameter on the service functions.
 *
 * The provider is stateful *per number*: `start` opens/refreshes a
 * verification, `check` validates a submitted code. The service layer
 * (`phone.service.ts`) does normalization, uniqueness, and the users-row
 * write; a provider only proves the user controls the number.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';

export type OtpStartResult = { ok: true } | { ok: false; reason: 'too_many_attempts' };

export type OtpCheckResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_code' | 'expired' | 'too_many_attempts' | 'not_found' };

export interface OtpProvider {
  readonly name: 'twilio';
  /** Open (or refresh) a verification for this E.164 number. */
  start(db: Kysely<DB>, phone: string): Promise<OtpStartResult>;
  /** Validate a submitted code against the open verification. */
  check(db: Kysely<DB>, phone: string, code: string): Promise<OtpCheckResult>;
}

const TWILIO_VERIFY_BASE = 'https://verify.twilio.com/v2';

function twilioAuthHeader(): string {
  const basic = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  return `Basic ${basic}`;
}

/**
 * Twilio Verify. `start` triggers an SMS; `check` validates the user's code.
 * Twilio holds the code + attempt state, so the DB handle is unused here.
 */
export const twilioOtpProvider: OtpProvider = {
  name: 'twilio',
  async start(_db, phone) {
    const url = `${TWILIO_VERIFY_BASE}/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Channel: 'sms' }).toString(),
    });
    // Twilio 429s when the number hit its max-send limit — a user-fixable
    // wait-and-retry state, not a server fault.
    if (res.status === 429) return { ok: false, reason: 'too_many_attempts' };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`twilio verify start failed (${res.status}): ${text}`);
    }
    return { ok: true };
  },
  async check(_db, phone, code) {
    const url = `${TWILIO_VERIFY_BASE}/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Code: code.trim() }).toString(),
    });
    // Twilio 404s when there's no pending verification (expired / never started);
    // 429 when the number exhausted its check attempts.
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 429) return { ok: false, reason: 'too_many_attempts' };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`twilio verify check failed (${res.status}): ${text}`);
    }
    const body = (await res.json()) as { status?: string };
    return body.status === 'approved' ? { ok: true } : { ok: false, reason: 'invalid_code' };
  },
};

/**
 * The configured provider, or null when Twilio Verify is not set up.
 *
 * Null means the feature is unavailable, never "use something weaker" — the
 * old code fell back to the fixed-code mock here, so a half-configured deploy
 * looked like it was verifying numbers while proving nothing.
 */
export function getOtpProvider(): OtpProvider | null {
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID) {
    return twilioOtpProvider;
  }
  logger.warn('phone: Twilio Verify is not configured — phone verification is disabled');
  return null;
}
