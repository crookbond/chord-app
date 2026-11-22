/**
 * Thin wrapper around the Twilio Messages REST API + the inbound
 * webhook signature check (ADR 0053). Only what the connector needs:
 * validate `X-Twilio-Signature` on inbound, and `POST .../Messages.json`
 * on outbound. Native `fetch`, no SDK — matches the Slack/Telegram
 * wrappers.
 */
import crypto from 'node:crypto';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

/**
 * Validate a Twilio request signature. Twilio signs `url + sorted POST
 * params` with HMAC-SHA1 keyed by the account auth token, base64-encoded,
 * and sends it in `X-Twilio-Signature`. `url` must be the exact public
 * URL Twilio called (scheme + host + path), and `params` the parsed form
 * fields. See twilio.com/docs/usage/security#validating-requests.
 */
export function validateTwilioSignature(input: {
  authToken: string;
  signature: string;
  url: string;
  params: Record<string, string>;
}): boolean {
  const { authToken, signature, url, params } = input;
  // Concatenate the URL, then each key+value sorted alphabetically by key.
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf8'))
    .digest('base64');

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface SendMessageInput {
  /** `whatsapp:+1555…` recipient. */
  to: string;
  /** `whatsapp:+1555…` Chord sender. */
  from: string;
  body: string;
}

export interface SendMessageResult {
  /** Twilio message SID (`SM…` / `MM…`). */
  sid: string;
  status: string;
}

interface TwilioMessageResponse {
  sid?: string;
  status?: string;
  message?: string;
  code?: number;
}

export async function sendMessage(
  creds: { accountSid: string; authToken: string },
  input: SendMessageInput,
): Promise<SendMessageResult> {
  return postMessage(creds, { To: input.to, From: input.from, Body: input.body });
}

export interface SendContentInput {
  to: string;
  from: string;
  /** Pre-created Content template SID (`HX…`), e.g. a `twilio/quick-reply`. */
  contentSid: string;
  /** Variable index → value, e.g. `{ "1": body, "2": "p+:id", "3": "Yes" }`. */
  contentVariables: Record<string, string>;
}

/**
 * Send a Content API template (ADR 0053 §7). Interactive content — quick-reply
 * buttons whose `id`/`title` are template variables — can't be expressed in a
 * plain `Body`, so it's referenced by `ContentSid` + filled with
 * `ContentVariables`. In-session quick-reply needs no template approval.
 */
export async function sendContent(
  creds: { accountSid: string; authToken: string },
  input: SendContentInput,
): Promise<SendMessageResult> {
  return postMessage(creds, {
    To: input.to,
    From: input.from,
    ContentSid: input.contentSid,
    ContentVariables: JSON.stringify(input.contentVariables),
  });
}

async function postMessage(
  creds: { accountSid: string; authToken: string },
  params: Record<string, string>,
): Promise<SendMessageResult> {
  const form = new URLSearchParams(params);
  const auth = Buffer.from(
    `${creds.accountSid}:${creds.authToken}`,
    'utf8',
  ).toString('base64');

  const res = await fetch(
    `${TWILIO_API}/Accounts/${creds.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );

  const json = (await res.json().catch(() => ({}))) as TwilioMessageResponse;
  if (!res.ok || !json.sid) {
    const detail = json.message ?? `HTTP ${res.status}`;
    throw new Error(`twilio send failed: ${detail}${json.code ? ` (code ${json.code})` : ''}`);
  }
  return { sid: json.sid, status: json.status ?? 'queued' };
}
