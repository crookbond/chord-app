import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

// Anchor .env loading to the repo root so `npm run dev --workspace=server`
// (CWD = server/) finds the root .env rather than server/.env.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
// Load shared defaults from .env, then per-developer overrides from .env.local.
// dotenv won't overwrite already-set vars by default, so we load .env.local
// first and let it win, then .env fills in anything still missing.
//
// Skip .env.local under NODE_ENV=test (vitest's default) so per-dev
// overrides (e.g. BOT_MENTION_ALIASES tuned to a specific bot handle,
// LLM_PROVIDER=mock, AUTH_MODE=demo) don't leak into the test suite
// and shift the defaults the fixtures were written against. CI never
// has .env.local anyway; this keeps local dev test runs aligned.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
}
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

function str(name: string, def: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : def;
}
function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === '1' || v.toLowerCase() === 'true';
}

const dataDir = path.resolve(REPO_ROOT, str('DATA_DIR', './data'));
const logsDir = path.resolve(REPO_ROOT, str('LOGS_DIR', './logs'));

export type LlmProvider = 'openai' | 'gemini' | 'anthropic' | 'mock';

const openaiApiKey = str('OPENAI_API_KEY', '');
const geminiApiKey = str('GEMINI_API_KEY', '');
const anthropicApiKey = str('ANTHROPIC_API_KEY', '');

// If LLM_PROVIDER is not set, infer from which API key is configured.
// Prefer openai when both are present (matches the historical default).
// Returns '' when nothing is configured so callers can detect and surface a
// clear message instead of silently falling back.
function inferLlmProvider(): LlmProvider | '' {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit && explicit.length > 0) return explicit as LlmProvider;
  if (openaiApiKey.length > 0) return 'openai';
  if (geminiApiKey.length > 0) return 'gemini';
  if (anthropicApiKey.length > 0) return 'anthropic';
  return '';
}

export const env = {
  NODE_ENV: str('NODE_ENV', 'development'),
  SERVER_HOST: str('SERVER_HOST', '127.0.0.1'),
  SERVER_PORT: int('SERVER_PORT', 4000),
  /** ADR 0115 — how long a sent message is held before it goes. 0 sends
   *  immediately and turns the outbox scheduler off entirely. */
  EMAIL_UNDO_SECONDS: int('EMAIL_UNDO_SECONDS', 8),
  /** ADR 0214 — the hold for mail the bot sends on a confirmed card. Longer
   *  than the composer's: "unsend that" has to be typed, not tapped. 0 sends
   *  on confirm. */
  EMAIL_CHAT_UNDO_SECONDS: int('EMAIL_CHAT_UNDO_SECONDS', 60),
  EMAIL_OUTBOX_TICK_MS: int('EMAIL_OUTBOX_TICK_MS', 2000),
  /** ADR 0303 — how often an edited draft is copied to the mailbox's own
   *  Drafts folder (Gmail / Outlook / IMAP). 0 = Chord keeps drafts only. */
  EMAIL_PROVIDER_DRAFT_SECONDS: int('EMAIL_PROVIDER_DRAFT_SECONDS', 30),
  /** ADR 0118 — real push (Gmail watch / Graph subscriptions / IMAP IDLE).
   *  Off by default: it needs a publicly reachable HTTPS URL plus provider
   *  setup, and polling carries every mailbox without it. */
  MAIL_PUSH_ENABLED: bool('MAIL_PUSH_ENABLED', false),
  /** Public base URL providers call back on, e.g. https://api.chordapp.ai. */
  MAIL_PUSH_PUBLIC_URL: str('MAIL_PUSH_PUBLIC_URL', ''),
  /** Shared secret on the Gmail callback URL. Its Pub/Sub payload carries no
   *  secret of its own, and the notification has no content — so this stops
   *  the endpoint being a free way to make us sync, nothing more. */
  MAIL_PUSH_GMAIL_TOKEN: str('MAIL_PUSH_GMAIL_TOKEN', ''),
  /** Pub/Sub topic `users.watch` publishes to, e.g.
   *  projects/<project>/topics/<topic>. */
  MAIL_PUSH_GMAIL_TOPIC: str('MAIL_PUSH_GMAIL_TOPIC', ''),
  MAIL_PUSH_RENEW_TICK_MS: int('MAIL_PUSH_RENEW_TICK_MS', 15 * 60 * 1000),
  /** IMAP IDLE holds one login open per account, which is FEWER logins than
   *  polling — but it is a long-lived resource, so it is capped and separately
   *  switchable from the webhook half. */
  IMAP_IDLE_ENABLED: bool('IMAP_IDLE_ENABLED', true),
  IMAP_IDLE_MAX_ACCOUNTS: int('IMAP_IDLE_MAX_ACCOUNTS', 50),
  IMAP_IDLE_REFRESH_MS: int('IMAP_IDLE_REFRESH_MS', 10 * 60 * 1000),
  LOG_LEVEL: str('LOG_LEVEL', 'debug'),
  /** 'meta' (default) logs roles + sizes only; 'full' logs whole prompts and
   *  is downgraded to 'meta' in production; 'off' disables prompts.log. */
  PROMPT_LOG: str('PROMPT_LOG', 'meta'),
  /** New-mail pushes carry sender + subject only when true (they cross Expo
   *  and APNs/FCM); default is generic text. */
  PUSH_EMAIL_PREVIEW: bool('PUSH_EMAIL_PREVIEW', false),

  // Per-IP request throttling (express-rate-limit). On by default in prod;
  // tests disable it so route specs can hammer endpoints freely.
  RATE_LIMIT_ENABLED: bool('RATE_LIMIT_ENABLED', process.env.NODE_ENV !== 'test'),
  RATE_LIMIT_WINDOW_MS: int('RATE_LIMIT_WINDOW_MS', 60_000),
  RATE_LIMIT_MAX: int('RATE_LIMIT_MAX', 300),
  RATE_LIMIT_AUTH_MAX: int('RATE_LIMIT_AUTH_MAX', 20),

  DATA_DIR: dataDir,
  LOGS_DIR: logsDir,
  FILES_DIR: path.join(dataDir, 'files'),
  // libpq connection string. Default targets a same-VM Postgres with
  // peer/trust auth on 127.0.0.1; production sets this in .env.local.
  DATABASE_URL: str(
    'DATABASE_URL',
    'postgresql://chord@127.0.0.1:5432/chord',
  ),
  // Per-process Postgres pool size (ADR 0172). Since the web and worker
  // roles now run as separate processes, total connections against
  // Postgres = number of running processes x this value — check the VM's
  // configured max_connections before raising it.
  DB_POOL_MAX: int('DB_POOL_MAX', 10),
  // Empty = disabled: the SSE hub stays in-process-only (ADR 0002) and the
  // BullMQ-backed queues fall back to running inline, exactly as before this
  // was introduced. Dev/CI/the mock-LLM sim need no Redis at all. Set once
  // Redis is provisioned to enable cross-process SSE fanout + job queues.
  REDIS_URL: str('REDIS_URL', ''),

  LLM_PROVIDER: inferLlmProvider(),

  OPENAI_API_KEY: openaiApiKey,
  OPENAI_BASE_URL: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  OPENAI_MODEL: str('OPENAI_MODEL', 'gpt-5.4-mini'),
  // ADR 0235 - the OpenRouter model a connection starts on when the app's own
  // model has no OpenRouter spelling (system default is a mock, or sits on some
  // other compatible endpoint).
  OPENROUTER_DEFAULT_MODEL: str('OPENROUTER_DEFAULT_MODEL', 'anthropic/claude-sonnet-4.6'),

  GEMINI_API_KEY: geminiApiKey,
  GEMINI_MODEL: str('GEMINI_MODEL', 'gemini-2.5-flash'),

  ANTHROPIC_API_KEY: anthropicApiKey,
  ANTHROPIC_MODEL: str('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
  // Optional override for Anthropic-compatible gateways; '' = SDK default.
  ANTHROPIC_BASE_URL: str('ANTHROPIC_BASE_URL', ''),

  // ADR 0063 — tier-based model routing + prepaid tokens. When billing is
  // OFF (default, team MVP) the turn path is unchanged: BYOK key if present,
  // else the premium system model, never debited. When ON, a non-BYOK user
  // with a token balance gets the premium model, debited by the turn's
  // actual token cost (ADR 0194 — not a flat per-turn rate); at zero they
  // fall back — free — to the cheap OSS model below (never hard-blocked).
  BILLING_ENABLED: bool('BILLING_ENABLED', false),
  // ADR 0283 — no model or embedding call on a user's data until that user
  // agreed (Apple 5.1.2(i)). false switches the whole gate off.
  AI_CONSENT_REQUIRED: bool('AI_CONSENT_REQUIRED', true),
  // ADR 0195 — tokens granted (reset to, not added to) each billing period
  // by the system-key subscription. A placeholder pending a real pricing
  // decision — there was no usage data to size it against until ADR 0193
  // shipped.
  MONTHLY_TOKEN_ALLOWANCE: int('MONTHLY_TOKEN_ALLOWANCE', 20_000_000),
  // OSS free-tier provider (OpenAI-compatible: Groq / DeepInfra / OpenRouter /
  // Ollama / vLLM). Empty OSS_API_KEY → fall back to the premium system model
  // so a mis-config never strands a free user.
  OSS_BASE_URL: str('OSS_BASE_URL', ''),
  OSS_MODEL: str('OSS_MODEL', ''),
  OSS_API_KEY: str('OSS_API_KEY', ''),
  // ADR 0325 — one-time free tokens per account, counted from sign-up with no
  // time limit (replaced ADR 0079's TRIAL_DAYS). 0 = no free allowance.
  FREE_TOKEN_ALLOWANCE: int('FREE_TOKEN_ALLOWANCE', 12_500_000),
  // ADR 0332 — every token allowance above is a DOLLAR budget: its tokens x
  // this, per million (default = fresh input on gpt-4.1-mini, so 12.5M = $5).
  // Spending is measured in the dollars OpenRouter reports; a call with no
  // reported cost is priced at this rate.
  ALLOWANCE_USD_PER_MILLION_TOKENS: num('ALLOWANCE_USD_PER_MILLION_TOKENS', 0.4),
  // ADR 0193 — display-only denominator for the Settings token counter
  // ("142K / 2M tokens this month"). Not a plan, not enforced — nothing
  // reads this to gate access; only the token balance (above) does that.
  // A placeholder until real plan tiers exist.
  TOKEN_QUOTA_PER_MONTH: int('TOKEN_QUOTA_PER_MONTH', 2_000_000),

  // ADR 0076 — learn people/family facts from the Gmail mirror. Default OFF
  // (one LLM call per non-bulk thread); flip on for dogfood accounts first.
  EMAIL_PERSONS_ENABLED: bool('EMAIL_PERSONS_ENABLED', true),

  // Stripe subscription checkout (ADR 0075/0195) — all three of SECRET_KEY/
  // WEBHOOK_SECRET/PRICE_ID empty = checkout hidden/503, webhook 404;
  // BILLING_ENABLED alone never exposes a purchase path. STRIPE_PRICE_ID is
  // the system-key plan (base cost + token allowance, one price). PRICE_ID_BYOK
  // is a second, separate product — the BYOK base-only plan — and stays
  // unset (BYOK free, today's behavior) until it's actually configured.
  STRIPE_SECRET_KEY: str('STRIPE_SECRET_KEY', ''),
  STRIPE_WEBHOOK_SECRET: str('STRIPE_WEBHOOK_SECRET', ''),
  STRIPE_PRICE_ID: str('STRIPE_PRICE_ID', ''),
  STRIPE_PRICE_ID_BYOK: str('STRIPE_PRICE_ID_BYOK', ''),
  // ADR 0231 — the other three prices the picker can sell. STRIPE_PRICE_ID is
  // Individual monthly; each of these is an independent Stripe price, and an
  // empty one simply isn't offered.
  STRIPE_PRICE_ID_YEARLY: str('STRIPE_PRICE_ID_YEARLY', ''),
  STRIPE_PRICE_ID_FAMILY: str('STRIPE_PRICE_ID_FAMILY', ''),
  STRIPE_PRICE_ID_FAMILY_YEARLY: str('STRIPE_PRICE_ID_FAMILY_YEARLY', ''),
  // ADR 0231 — the prices the app SHOWS (the charge itself is the Stripe
  // price / App Store product, set in those dashboards — keep them in step).
  // Annual = monthly x (12 - ANNUAL_FREE_MONTHS) unless an explicit annual
  // figure is given (0 = derive).
  PRICE_INDIVIDUAL_USD: num('PRICE_INDIVIDUAL_USD', 7.99),
  PRICE_FAMILY_USD: num('PRICE_FAMILY_USD', 24.99),
  PRICE_INDIVIDUAL_YEARLY_USD: num('PRICE_INDIVIDUAL_YEARLY_USD', 0),
  PRICE_FAMILY_YEARLY_USD: num('PRICE_FAMILY_YEARLY_USD', 0),
  ANNUAL_FREE_MONTHS: int('ANNUAL_FREE_MONTHS', 1),
  // ADR 0238 - what the bring-your-own-key base plan is shown as costing per
  // month (the charge is the STRIPE_PRICE_ID_BYOK price / the App Store product).
  PRICE_BYOK_USD: num('PRICE_BYOK_USD', 2.99),
  // ADR 0231 — monthly allowance for grandfathered users (here before billing
  // went live): free, permanent, capped like anyone else's so a free account
  // can't spend without limit.
  GRANDFATHER_TOKEN_ALLOWANCE: int('GRANDFATHER_TOKEN_ALLOWANCE', 20_000_000),
  // ADR 0231 — the family plan's pooled monthly allowance, spent by anyone on
  // the plan until the whole family is done, not per person. 0 = work it out:
  // FAMILY_SEATS x MONTHLY_TOKEN_ALLOWANCE, so raising the individual allowance
  // raises the family's with it. Read it through familyTokenAllowance().
  FAMILY_TOKEN_ALLOWANCE: int('FAMILY_TOKEN_ALLOWANCE', 0),
  // ADR 0231 — App Store subscriptions arrive through RevenueCat. The webhook
  // is shared-secret authenticated; the product ids are what we name them in
  // App Store Connect. Empty secret = the webhook 404s and the app doesn't
  // offer Apple purchase.
  REVENUECAT_WEBHOOK_SECRET: str('REVENUECAT_WEBHOOK_SECRET', ''),
  APPLE_PRODUCT_INDIVIDUAL_MONTHLY: str('APPLE_PRODUCT_INDIVIDUAL_MONTHLY', 'chord.individual.monthly'),
  APPLE_PRODUCT_INDIVIDUAL_YEARLY: str('APPLE_PRODUCT_INDIVIDUAL_YEARLY', 'chord.individual.yearly'),
  APPLE_PRODUCT_FAMILY_MONTHLY: str('APPLE_PRODUCT_FAMILY_MONTHLY', 'chord.family.monthly'),
  APPLE_PRODUCT_FAMILY_YEARLY: str('APPLE_PRODUCT_FAMILY_YEARLY', 'chord.family.yearly'),
  APPLE_PRODUCT_BYOK_MONTHLY: str('APPLE_PRODUCT_BYOK_MONTHLY', 'chord.byok.monthly'),
  // Web origin for checkout success/cancel redirects (and future absolute
  // URLs). Empty → derived from SIGNUP_URL's origin at use time.
  WEB_ORIGIN: str('WEB_ORIGIN', ''),
  // CASA 6.3.1 — extra browser origins allowed cross-origin, comma-separated
  // (chordapp.ai, www.chordapp.ai, WEB_ORIGIN and SIGNUP_URL are built in).
  CORS_ALLOWED_ORIGINS: str('CORS_ALLOWED_ORIGINS', ''),

  // ADR 0027 — bot persona seed. The bot-personas service reads these
  // *once* at first boot to seed the 'default' row in bot_personas; the
  // DB row is the source of truth thereafter. Empty values mean "use
  // the documented default" (Chord / chord / etc.); BOT_LLM_PROVIDER
  // and BOT_MODEL empty means "fall back to LLM_PROVIDER / *_MODEL".
  BOT_PERSONA_ID: str('BOT_PERSONA_ID', 'default'),
  BOT_DISPLAY_NAME: str('BOT_DISPLAY_NAME', 'Chord'),
  BOT_MENTION_ALIASES: str('BOT_MENTION_ALIASES', 'chord'),
  BOT_PROMPT_NAME: str('BOT_PROMPT_NAME', ''),
  BOT_LLM_PROVIDER: str('BOT_LLM_PROVIDER', ''),
  BOT_MODEL: str('BOT_MODEL', ''),
  BOT_ENABLED_TOOLS: str('BOT_ENABLED_TOOLS', ''),
  BOT_WRITE_ALLOWED: bool('BOT_WRITE_ALLOWED', true),

  // ADR 0051 — post-invocation follow-up window. After the bot is @-mentioned
  // in a group, it keeps replying to the invoking user's next N messages in
  // that group WITHOUT a re-mention (natural back-and-forth). BOT_FOLLOWUP_TURNS
  // is that N; 0 disables the feature (invocation-only). BOT_FOLLOWUP_TTL_MINUTES
  // expires a stale window so a quiet user's much-later unrelated message
  // doesn't get answered out of the blue.
  BOT_FOLLOWUP_TURNS: int('BOT_FOLLOWUP_TURNS', 3),
  // ADR 0322 — send a chat turn the core tools plus the topic groups the
  // conversation points at (and `more_tools` for the rest), instead of all
  // ~120 every round trip. false = the full catalogue, as before.
  BOT_TOOL_SUBSET: bool('BOT_TOOL_SUBSET', true),
  BOT_FOLLOWUP_TTL_MINUTES: int('BOT_FOLLOWUP_TTL_MINUTES', 10),

  // ADR 0212 — how long a `get_contact_info` turn waits for the asker's phone
  // to answer a Contacts lookup before saying it could not reach it.
  CONTACT_LOOKUP_TIMEOUT_MS: int('CONTACT_LOOKUP_TIMEOUT_MS', 8000),

  // IM connectors (ADR 0010). Telegram is the only deploy-wide connector;
  // it's enabled when TELEGRAM_BOT_TOKEN is set, disabled with a one-line
  // log otherwise. Slack/Discord deploy-wide wiring was removed (ADR 0154);
  // the connector code stays for BYO tokens (ADR 0025).
  TELEGRAM_BOT_TOKEN: str('TELEGRAM_BOT_TOKEN', ''),

  // WhatsApp via Twilio (ADR 0053). Enabled when SID + token + sender are
  // all set. TWILIO_PUBLIC_URL is the public base (e.g. an ngrok URL) that
  // Twilio posts to — the inbound signature is computed over the exact
  // URL, so it must match Twilio's webhook config (no trailing slash).
  // TWILIO_VALIDATE_SIGNATURE=0 disables the check for tunnel dev only;
  // never disable in production.
  TWILIO_ACCOUNT_SID: str('TWILIO_ACCOUNT_SID', ''),
  TWILIO_AUTH_TOKEN: str('TWILIO_AUTH_TOKEN', ''),
  TWILIO_WHATSAPP_FROM: str('TWILIO_WHATSAPP_FROM', ''),
  TWILIO_PUBLIC_URL: str('TWILIO_PUBLIC_URL', ''),
  TWILIO_VALIDATE_SIGNATURE: bool('TWILIO_VALIDATE_SIGNATURE', true),

  // Content API quick-reply template SIDs (ADR 0053 §7), one per button
  // count. Create a `twilio/quick-reply` template in the Twilio Content
  // Template Builder with body `{{1}}` and N buttons whose id/title are
  // variables ({{2}}/{{3}}, {{4}}/{{5}}, …), then paste its HX… SID here.
  // In-session quick-reply needs NO Meta approval. Unset → action buttons
  // gracefully degrade to plain text (the current behavior).
  TWILIO_QUICK_REPLY_SID_2: str('TWILIO_QUICK_REPLY_SID_2', ''),
  TWILIO_QUICK_REPLY_SID_3: str('TWILIO_QUICK_REPLY_SID_3', ''),
  // ADR 0089 — the Meta-APPROVED template used to ask, from outside the 24h
  // session window, whether the user still wants their briefing. Distinct from
  // the quick-reply SIDs above: those are in-session and need no approval,
  // this one is business-initiated and does. Unset → proactive WhatsApp sends
  // outside the window are skipped with a log line rather than failing.
  TWILIO_NUDGE_TEMPLATE_SID: str('TWILIO_NUDGE_TEMPLATE_SID', ''),

  // ── WhatsApp provider (ADR 0090) ──────────────────────────────────────
  // 'twilio' (default) keeps the ADR 0053 BSP path and its sandbox, which
  // needs no Meta approval and is the local-dev story. 'cloud' talks to
  // Meta's Cloud API directly — no BSP, no per-message margin, and it uses
  // a number that is ALREADY on your WABA rather than migrating it.
  WHATSAPP_PROVIDER: str('WHATSAPP_PROVIDER', 'twilio') as 'twilio' | 'cloud',
  // ADR 0253 - the number people message to reach Chord on WhatsApp, E.164. It is
  // shown in the app (and linked as wa.me) straight from here, so changing the
  // business number is a config change, not an app release. Empty = the app
  // offers no WhatsApp entry rather than a dead one.
  WHATSAPP_PUBLIC_NUMBER: str('WHATSAPP_PUBLIC_NUMBER', ''),
  // ADR 0301 — where a reported chat message is emailed. Empty SMTP URL =
  // reports are saved and logged, not emailed. The URL holds a password, so
  // in production it lives in Secret Manager (ADR 0211).
  REPORTS_EMAIL_TO: str('REPORTS_EMAIL_TO', 'hello@chordapp.ai'),
  REPORTS_SMTP_URL: str('REPORTS_SMTP_URL', ''),
  REPORTS_EMAIL_FROM: str('REPORTS_EMAIL_FROM', ''),
  // System User access token (whatsapp_business_messaging). Long-lived —
  // treat as a production secret; never logged.
  META_WHATSAPP_TOKEN: str('META_WHATSAPP_TOKEN', ''),
  // The SENDING number's Phone Number ID from WhatsApp Manager. This is an
  // opaque numeric id, NOT the phone number itself.
  META_WHATSAPP_PHONE_NUMBER_ID: str('META_WHATSAPP_PHONE_NUMBER_ID', ''),
  // App Secret — used to verify `X-Hub-Signature-256` on every webhook.
  META_APP_SECRET: str('META_APP_SECRET', ''),
  // Shared secret you invent, echoed during Meta's GET subscription check.
  META_WEBHOOK_VERIFY_TOKEN: str('META_WEBHOOK_VERIFY_TOKEN', ''),
  META_GRAPH_VERSION: str('META_GRAPH_VERSION', 'v21.0'),
  // ADR 0089's out-of-window nudge. On Meta a template is addressed by NAME
  // + language, not by a Twilio Content SID.
  META_NUDGE_TEMPLATE_NAME: str('META_NUDGE_TEMPLATE_NAME', ''),
  META_NUDGE_TEMPLATE_LANG: str('META_NUDGE_TEMPLATE_LANG', 'en_US'),
  // How long an unanswered out-of-window ask silences the channel (ADR 0089
  // §6 addendum). The ask is billed per conversation, so it must not repeat
  // daily; making it permanent instead left users who never tap and never
  // write with no briefing at all. Weekly is the compromise. 0 (or less)
  // restores ask-once-forever.
  WHATSAPP_NUDGE_REASK_DAYS: int('WHATSAPP_NUDGE_REASK_DAYS', 7),

  // ── Phone identity + contact discovery (ADR 0064 / 0065) ──────────────
  // Twilio Verify service SID (VA…). Phone verification (ADR 0064) is ON iff
  // this is set alongside TWILIO_ACCOUNT_SID/AUTH_TOKEN, and OFF otherwise —
  // there is deliberately no fixed-code fallback to degrade to. Twilio owns
  // code lifetime and attempt limits, so there is nothing else to configure.
  TWILIO_VERIFY_SERVICE_SID: str('TWILIO_VERIFY_SERVICE_SID', ''),
  // Pepper folded into the phone HMAC (ADR 0065). The SAME value must be built
  // into the mobile client so client- and server-side hashes match. This is a
  // shared build-time constant, NOT an enclave secret — hashed discovery here
  // is deliberately not cryptographically private (documented in ADR 0065); it
  // only stops a raw DB dump from being rainbow-attacked without the pepper.
  // A stable default keeps dev/test deterministic; production overrides it.
  CONTACT_HASH_PEPPER: str('CONTACT_HASH_PEPPER', 'chord-dev-contact-pepper'),

  // ── Weather + location (ADR 0091) ─────────────────────────────────────
  // Weather source for the briefing's first line. '' disables the section
  // entirely; 'mock' returns a fixture so tests and mock-LLM demos never
  // reach the network. 'open-meteo' needs no API key.
  WEATHER_PROVIDER: str('WEATHER_PROVIDER', '') as '' | 'open-meteo' | 'mock',
  // Path to a MaxMind GeoLite2-City .mmdb. Absent or unreadable → the IP
  // tier is skipped silently and location falls back to the timezone, so
  // local dev and tests need nothing here.
  GEOIP_DB_PATH: str('GEOIP_DB_PATH', ''),
  // ADR 0148 — proactive "you seem to have moved" chat prompt. How far a
  // fresh IP/timezone fix must sit from the stored weather location before
  // the briefing asks whether to switch it; and how long to wait before
  // asking again about the same place (an unanswered or declined prompt).
  WEATHER_DRIFT_KM: int('WEATHER_DRIFT_KM', 100),
  WEATHER_DRIFT_REASK_DAYS: int('WEATHER_DRIFT_REASK_DAYS', 7),

  // WhatsApp "taster" (ADR 0053): how many bot turns an unsigned WhatsApp
  // stranger may use under a shadow account before the app-first signup
  // gate kicks in. Each turn is a billed LLM call (and possibly a paid
  // WhatsApp conversation), so this bounds cost/abuse while still letting
  // people try the bot before committing to an account. On Google sign-in
  // the shadow's data merges into the real account. 0 = disabled (hard
  // gate from the first message, the original behavior).
  WHATSAPP_TASTER_TURNS: int('WHATSAPP_TASTER_TURNS', 10),

  // Proactive scheduler tick cadence (ms).
  PROACTIVE_TICK_MS: int('PROACTIVE_TICK_MS', 15_000),
  // Auto-archive threshold for *done* tasks (minutes). Prod = 7d; demo envs
  // can shorten.
  ARCHIVE_DONE_MINUTES: int('ARCHIVE_DONE_MINUTES', 7 * 24 * 60),
  // Auto-archive threshold for open/active tasks past their due date (days).
  // Only tasks that CARRY a due date are eligible — an undated task is never
  // auto-archived, however old (ADR 0092, spec v4 §6.2).
  TASK_OVERDUE_ARCHIVE_DAYS: int('TASK_OVERDUE_ARCHIVE_DAYS', 7),
  // How long an INCIDENTAL attachment (auto-imported from email, ADR 0071 —
  // origin_email_thread_id set) survives before the sweep deletes it, unless
  // pinned. A direct upload (chat/WhatsApp/mobile picker) has no
  // origin_email_thread_id and is never touched by this — only mail's
  // auto-import pipeline produces incidental clutter (a marketing logo, a
  // coupon banner) nobody chose to keep.
  ATTACHMENT_RETENTION_DAYS: int('ATTACHMENT_RETENTION_DAYS', 45),
  // A boarding pass / hotel confirmation attachment (travel_legs.source_doc_id
  // or accommodations.source_doc_id) has a natural shelf life the itinerary
  // itself states — this is the buffer AFTER a leg lands / a stay checks out
  // before the sweep deletes it, regardless of upload origin or age (unlike
  // ATTACHMENT_RETENTION_DAYS, which only ever looks at email-auto-imports).
  // Pinning still exempts it, same as every other attachment sweep.
  ATTACHMENT_ITINERARY_GRACE_DAYS: int('ATTACHMENT_ITINERARY_GRACE_DAYS', 7),
  // Zone used to time a briefing for a user whose `last_tz` we've never seen.
  // Deriving it from the server's clock put a 07:00 briefing at 07:00Z —
  // midnight Pacific on a UTC VM (ADR 0098).
  BRIEFING_DEFAULT_TZ: str('BRIEFING_DEFAULT_TZ', 'America/New_York'),

  // Expo push notifications. PUSH_ENABLED gates the whole feature; off by
  // default so tests/CI/local dev never reach the Expo push service.
  // EXPO_ACCESS_TOKEN is optional — only needed if the Expo project enforces
  // enhanced push security.
  PUSH_ENABLED: bool('PUSH_ENABLED', false),
  EXPO_ACCESS_TOKEN: str('EXPO_ACCESS_TOKEN', ''),

  // Gates the POST /api/v1/demo/reset route + the "Reset demo" button in
  // the mobile UI. Off by default; enable with DEMO_MODE=1 for live demos.
  DEMO_MODE: bool('DEMO_MODE', false),

  // ADR 0014. 'google' = real users via Google OAuth. 'demo' = legacy
  // username-only POST /api/v1/session is allowed (tests / CI / mock dev).
  // The session route returns 403 outside 'demo'.
  AUTH_MODE: str('AUTH_MODE', 'demo') as 'google' | 'demo',
  // A session unused for this many days, or older than SESSION_MAX_DAYS
  // however busy, is refused and deleted. 0 turns that limit off.
  SESSION_IDLE_DAYS: int('SESSION_IDLE_DAYS', 30),
  SESSION_MAX_DAYS: int('SESSION_MAX_DAYS', 90),

  // 32-byte key (base64) used to encrypt Google refresh tokens at rest.
  // Required when AUTH_MODE === 'google'; the crypto util throws on use
  // when missing/invalid.
  MASTER_KEY: str('MASTER_KEY', ''),
  /** The same key, wrapped by Cloud KMS (ADR 0210); wins over MASTER_KEY when set. Read from
   *  process.env at use (like MASTER_KEY) so tests can swap it. */
  MASTER_KEY_WRAPPED: str('MASTER_KEY_WRAPPED', ''),
  /** projects/…/cryptoKeys/… that wraps it; defaults to GCP_KMS_KEY_NAME (the content key). */
  MASTER_KEY_KMS_KEY: str('MASTER_KEY_KMS_KEY', ''),

  // Email/attachment content encryption at rest (ADR 0201). Reads always
  // decrypt anything sealed and pass plaintext through, so this only controls
  // whether NEW writes are sealed; turn it on after the code is deployed and
  // run the backfill for what already exists.
  CONTENT_ENCRYPTION: bool('CONTENT_ENCRYPTION', false),
  /** 'local' wraps per-owner data keys under CONTENT_KEK (dev, tests, or a
   *  stopgap); 'gcp-kms' wraps them under a Cloud KMS key. */
  CONTENT_KEY_PROVIDER: str('CONTENT_KEY_PROVIDER', 'local'),
  /** 32-byte key (base64) for the local provider. Kept out of MASTER_KEY so
   *  token sealing and content sealing rotate independently. */
  CONTENT_KEK: str('CONTENT_KEK', ''),
  /** projects/…/locations/…/keyRings/…/cryptoKeys/… for the gcp-kms provider. */
  GCP_KMS_KEY_NAME: str('GCP_KMS_KEY_NAME', ''),
  /** How long an unwrapped data key stays in process memory. */
  CONTENT_DEK_TTL_MS: int('CONTENT_DEK_TTL_MS', 10 * 60 * 1000),
  CONTENT_DEK_CACHE_MAX: int('CONTENT_DEK_CACHE_MAX', 5000),
  /** Connections reserved for key lookups, on top of DB_POOL_MAX. Kysely runs the
   *  read plugin while it still holds the query's connection, so a key load
   *  through the app pool would need a second one and can exhaust it. */
  CONTENT_KEY_POOL_MAX: int('CONTENT_KEY_POOL_MAX', 2),
  /** While rows that predate the blind index exist, search also reads the old
   *  plaintext tsvector columns. Turn off (on every instance) once the backfill
   *  has run, then `encrypt:finalize` drops the columns. */
  CONTENT_LEGACY_TSV: bool('CONTENT_LEGACY_TSV', true),

  // Google OAuth clients (ADR 0014 + 0015). The web client (id + secret) is a
  // confidential client used for the web flow and its server-side code
  // exchange. Native iOS uses a separate *public* client (no secret) because
  // Google forbids custom-scheme redirects on web clients — the native app
  // redirects to the reversed-client-id scheme. Refresh tokens are bound to
  // the issuing client, so the exchange + refresh must use the matching one;
  // GOOGLE_CLIENT_ID_IOS lets the server refresh native-issued tokens.
  GOOGLE_CLIENT_ID: str('GOOGLE_CLIENT_ID', ''),
  GOOGLE_CLIENT_SECRET: str('GOOGLE_CLIENT_SECRET', ''),
  GOOGLE_CLIENT_ID_IOS: str('GOOGLE_CLIENT_ID_IOS', ''),

  // Sign in with Apple (ADR 0156), native iOS. The server exchanges the app's
  // authorization code with a client secret it signs from the team's .p8 key,
  // and needs the same key to revoke on account deletion (an Apple rule), so
  // the feature is ON only when all three secrets are set. APPLE_PRIVATE_KEY is
  // the base64 body between the .p8's BEGIN/END lines, on one line (full PEM,
  // or PEM with literal "\n", is also accepted).
  APPLE_TEAM_ID: str('APPLE_TEAM_ID', ''),
  APPLE_KEY_ID: str('APPLE_KEY_ID', ''),
  APPLE_PRIVATE_KEY: str('APPLE_PRIVATE_KEY', ''),
  APPLE_BUNDLE_ID: str('APPLE_BUNDLE_ID', 'app.chord.demo'),
  // Sign in with Apple on the WEB (ADR 0156 addendum). The Services ID created
  // in the Apple Developer portal for the website; '' = the web login offers
  // Google only. Uses the same team, key id and .p8 as the iOS flow.
  APPLE_SERVICES_ID: str('APPLE_SERVICES_ID', ''),

  // Name of the dedicated Google Calendar that Chord pushes events to.
  // Resolution order at first push: cached google_calendar_id, then
  // existing calendar with this summary (case-insensitive, owner/writer
  // only), else a new one is created. Set this to whatever the user
  // already maintains in Google so events land in their existing
  // calendar with its color/sharing intact.
  GCAL_TARGET_CALENDAR_NAME: str('GCAL_TARGET_CALENDAR_NAME', 'Family'),

  // How many dirty events `pushDirtyEvents` sends to the Calendar API in
  // PARALLEL. Each row is an independent write (no ordering requirement
  // between them), so this is wall-clock only — a fanned-out group event or
  // a bulk edit no longer pays one HTTP round trip at a time. Kept modest
  // (writes, unlike reads, are worth being conservative about against a
  // single user's Calendar API quota).
  GOOGLE_CALENDAR_PUSH_CONCURRENCY: int('GOOGLE_CALENDAR_PUSH_CONCURRENCY', 5),

  // ADR 0181 — background calendar sweep, mirroring ADR 0144's mail sweep.
  // Two-way calendar sync (ADR 0040) only ever ran opportunistically — a bot
  // tool call, a foreground refresh, the manual sync route — so an edit made
  // directly in Google Calendar (e.g. moving an event to a different
  // calendar) sat unreconciled until the user happened to trigger one of
  // those, which could leave a stray duplicate visible for a long time.
  CALENDAR_SWEEP_ENABLED: bool('CALENDAR_SWEEP_ENABLED', true),
  // How stale a user's calendar mirror may get before the sweep picks them up.
  // Matches MAIL_SWEEP_MINUTES — calendar sync makes no LLM calls, so there is
  // no spend-multiplication reason to lag mail's cadence, only Google Calendar
  // API quota (ample headroom) and a per-sweep DB round trip.
  CALENDAR_SWEEP_MINUTES: int('CALENDAR_SWEEP_MINUTES', 5),
  // Users per tick. Ordered stalest-first (mirrors MAIL_SWEEP_BATCH), so this
  // bounds the burst without starving anyone.
  CALENDAR_SWEEP_BATCH: int('CALENDAR_SWEEP_BATCH', 20),

  // ── In-app Gmail reader (ADR 0060/0061/0062) ──────────────────────────
  // Master gate. gmail.modify is a RESTRICTED Google scope requiring OAuth
  // app verification; keep the whole feature off until verified. Off = the
  // Connect Gmail UI is hidden and every /me/email/* route 404s.
  GMAIL_ENABLED: bool('GMAIL_ENABLED', true),
  // 'real' hits the Gmail REST API; 'mock' serves deterministic fixtures so
  // the reader + sync + reply flow can run end-to-end with no Google account
  // (tests, mock-LLM demos). Mirrors LLM_PROVIDER=mock.
  GMAIL_PROVIDER: str('GMAIL_PROVIDER', 'real') as 'real' | 'mock',
  // Bounded initial-import window (days back from now). Keeps backfill cheap.
  GMAIL_BACKFILL_DAYS: int('GMAIL_BACKFILL_DAYS', 90),
  // Throttle for the opportunistic foreground/tick sync (minutes).
  GMAIL_SYNC_THROTTLE_MINUTES: int('GMAIL_SYNC_THROTTLE_MINUTES', 5),
  // How many per-message `getMessage` calls (backfill, incremental sync,
  // junk peek) run in PARALLEL against the Gmail API. Wall-clock only —
  // Gmail's quota is charged per call either way, so this doesn't change
  // spend, only how long a mailbox with thousands of messages takes to
  // catch up. Keep well under Gmail's per-user rate limit.
  GMAIL_FETCH_CONCURRENCY: int('GMAIL_FETCH_CONCURRENCY', 12),
  // ADR 0144 — background mirror sweep. Mail used to sync only when the Email
  // tab was open (plus once a day in the briefing), so every other surface
  // showed whatever was true when that screen was last opened. `mirror` depth:
  // never runs the AI passes, so this cannot multiply LLM spend.
  MAIL_SWEEP_ENABLED: bool('MAIL_SWEEP_ENABLED', true),
  // How stale a user's mirror may get before the sweep picks them up.
  MAIL_SWEEP_MINUTES: int('MAIL_SWEEP_MINUTES', 5),
  // Users per tick. Ordered stalest-first, so this bounds the burst without
  // starving anyone — it only changes how often each user comes up.
  MAIL_SWEEP_BATCH: int('MAIL_SWEEP_BATCH', 20),
  // Longest a failing mailbox is left alone by the background paths. The wait
  // starts at MAIL_SWEEP_MINUTES (10 for a quota 403) and doubles per failure
  // up to this; a sync the person asks for is never held back. <= 0 turns the
  // backoff off (retry on every tick, as before).
  MAIL_SYNC_BACKOFF_MAX_MINUTES: int('MAIL_SYNC_BACKOFF_MAX_MINUTES', 60),
  // How many users' mailbox syncs run in PARALLEL when the sweep is queued
  // on BullMQ (REDIS_URL set — see mail-sync.queue.ts). Decoupled from
  // MAIL_SWEEP_BATCH, which only bounds candidates considered per tick.
  // Ignored when REDIS_URL is unset (sequential fallback, unchanged).
  MAIL_SYNC_QUEUE_CONCURRENCY: int('MAIL_SYNC_QUEUE_CONCURRENCY', 3),
  // How many bot turns (LLM streams) run in PARALLEL process-wide when
  // turns are queued on BullMQ (REDIS_URL set — see bot-turn.queue.ts).
  // Today's fallback (REDIS_URL unset) has no such cap: a burst across N
  // groups launches N concurrent LLM streams. Watch provider rate-limit
  // headroom before raising this further.
  BOT_TURN_QUEUE_CONCURRENCY: int('BOT_TURN_QUEUE_CONCURRENCY', 8),
  // BullMQ marks a job "stalled" (and would normally redeliver it to
  // another worker) if its lock isn't renewed within this window. A turn
  // can run up to MAX_ITERATIONS (20) LLM round-trips, so this must stay
  // comfortably longer than the slowest realistic turn or a legitimately
  // still-running turn gets falsely killed mid-stream.
  BOT_TURN_QUEUE_LOCK_MS: int('BOT_TURN_QUEUE_LOCK_MS', 300_000),
  // ADR 0143 — how old a READ thread may be and still be mined for to-dos.
  // Unread mail is exempt at any age. Much shorter than the backfill window
  // on purpose: that window is for search history, not for fresh obligations.
  EMAIL_MINE_READ_MAX_AGE_DAYS: int('EMAIL_MINE_READ_MAX_AGE_DAYS', 7),
  // ── Additional mailboxes (ADR 0080) ───────────────────────────────────
  // Microsoft OAuth app for Outlook.com + Microsoft 365 (one multi-tenant
  // Graph app, /common endpoint). Empty = the Outlook connect option is
  // hidden (outlookClientId null on /me/email/status).
  MS_CLIENT_ID: str('MS_CLIENT_ID', ''),
  MS_CLIENT_SECRET: str('MS_CLIENT_SECRET', ''),
  // ADR 0293 — offer "Sign in with Microsoft" (needs the MS keys above and the
  // xms_edov optional claim on the app registration first).
  MICROSOFT_SIGN_IN_ENABLED: bool('MICROSOFT_SIGN_IN_ENABLED', false),
  // ADR 0345 - one email + password that opens the app-review account, for
  // store reviewers whose devices Google/Microsoft will not trust. Off unless
  // both are set (and the password is at least 20 characters).
  REVIEW_SIGN_IN_EMAIL: str('REVIEW_SIGN_IN_EMAIL', ''),
  REVIEW_SIGN_IN_PASSWORD: str('REVIEW_SIGN_IN_PASSWORD', ''),
  // Mock seams mirroring GMAIL_PROVIDER: 'mock' serves deterministic fixture
  // mailboxes so connect → sync → reply run keyless in tests/demos.
  OUTLOOK_PROVIDER: str('OUTLOOK_PROVIDER', 'real') as 'real' | 'mock',
  // ADR 0228 — two-way Outlook calendar sync. Off until the Microsoft app
  // registration carries Calendars.ReadWrite: on, the Outlook connect asks
  // for that permission too.
  OUTLOOK_CALENDAR_ENABLED: bool('OUTLOOK_CALENDAR_ENABLED', false),
  // ADR 0328 — a shared-group event invites the members from the organizer's
  // event instead of writing a copy onto each member's calendar.
  FAMILY_EVENT_INVITES: bool('FAMILY_EVENT_INVITES', false),
  // ADR 0335 — the MCP connector for Claude / ChatGPT and the OAuth endpoints
  // it signs in through. Off = every connector route answers 404.
  MCP_CONNECTOR_ENABLED: bool('MCP_CONNECTOR_ENABLED', false),
  IMAP_PROVIDER: str('IMAP_PROVIDER', 'real') as 'real' | 'mock',
  // Email classifier gate (ADR 0061 mock; ADR 0066 in-repo LLM).
  // '' = disabled; 'mock' = deterministic fixture; 'llm' = Chord-owned LLM
  // classifier. Both write via the same ingestClassification snapshot path.
  EMAIL_CLASSIFIER: str('EMAIL_CLASSIFIER', 'llm') as '' | 'mock' | 'llm',
  // Shared secret for Mode-B external ingest (header x-chord-classifier-token).
  // Empty = token auth disabled (session-only on POST /me/email/classification).
  EMAIL_CLASSIFIER_SERVICE_TOKEN: str('EMAIL_CLASSIFIER_SERVICE_TOKEN', ''),
  // Max threads sent to the LLM per classify pass (cost control).
  EMAIL_CLASSIFIER_BATCH_SIZE: int('EMAIL_CLASSIFIER_BATCH_SIZE', 40),
  // Cap on category path depth (root = 1).
  EMAIL_CLASSIFIER_MAX_DEPTH: int('EMAIL_CLASSIFIER_MAX_DEPTH', 3),
  // ADR 0063 — email magics: after classify, run an LLM extractor over new
  // classified threads and stage calendar-event / list-item proposals. Off by
  // default (each thread is one LLM call); dedup'd per thread so it only ever
  // processes new mail.
  EMAIL_MAGICS_ENABLED: bool('EMAIL_MAGICS_ENABLED', true),
  // ADR 0158 — route the body of a `travel/*` email through the existing trip
  // classifier and stage a create_trip + legs/accommodation proposal bundle.
  // On by default; one extra classifier LLM call per travel-category thread,
  // once, until marked. Runs inside the magics pass.
  EMAIL_TRIPS_ENABLED: bool('EMAIL_TRIPS_ENABLED', true),
  // ADR 0162 — auto-compose an event's `description` (a source email's
  // subject+snippet+link, or the triggering chat message) when the caller
  // didn't supply one. Deterministic, no LLM call. On by default; a
  // kill-switch since it changes the Google-pushed description of every
  // future Chord-created event.
  EVENT_CONTEXT_EXCERPT_ENABLED: bool('EVENT_CONTEXT_EXCERPT_ENABLED', true),
  // ADR 0163 — mine a short "what this meeting is about" from prior
  // correspondence with an invited attendee, once, at invite time. Costs one
  // small LLM call ONLY when matching correspondence is found (most events
  // have no attendees and cost nothing). On by default; its own flag since
  // it's a real LLM-cost surface, separate from EVENT_CONTEXT_EXCERPT_ENABLED.
  MEETING_CONTEXT_ENABLED: bool('MEETING_CONTEXT_ENABLED', true),
  // ADR 0180 — opening a thread runs its own extraction pass, bypassing every
  // background gate (bulk/discretionary/stale-read/once-ever `magic` mark),
  // once per thread (its own `read` mark). Unlike the other flags above, this
  // one is NOT "usually free": every not-yet-opened thread costs one LLM call
  // the first time it's read. On by default; a kill-switch for the per-open
  // cost, not a correctness concern.
  EMAIL_READ_TIME_MAGICS_ENABLED: bool('EMAIL_READ_TIME_MAGICS_ENABLED', true),
  // How long opening a thread waits for that pass before showing the email and
  // letting it finish behind it (the screen reloads when it does).
  EMAIL_READ_TIME_WAIT_MS: int('EMAIL_READ_TIME_WAIT_MS', 1500),
  // Preprocess the read-time pass ahead of the open, so the common case (mail
  // near the top of the inbox) pays the LLM call before the tap instead of
  // during it. Bounded to the newest N unmarked threads at a time, not every
  // synced thread - a 14-day backfill must not become N real LLM calls per
  // thread whether or not anyone ever opens it. The window self-advances:
  // once the newest N are marked, the same query naturally surfaces the next
  // N, so there's no separate cursor to track.
  EMAIL_PREPROCESS_READTIME_ENABLED: bool('EMAIL_PREPROCESS_READTIME_ENABLED', true),
  EMAIL_PREPROCESS_READTIME_BATCH: int('EMAIL_PREPROCESS_READTIME_BATCH', 10),
  // ADR 0205 addendum — when the reader pre-loads the next email, start its
  // one-time check too, so opening it does not wait. Same mail rule as the
  // warm-up above; costs a model call for a neighbour that is never opened.
  EMAIL_PREFETCH_READTIME_ENABLED: bool('EMAIL_PREFETCH_READTIME_ENABLED', true),
  // ADR 0071 — import Gmail attachments into the user's personal-group
  // knowledge base (extraction + FTS + bot search) after each sync. On by
  // default: only messages that actually carry attachments cost anything.
  EMAIL_ATTACHMENTS_ENABLED: bool('EMAIL_ATTACHMENTS_ENABLED', true),
  /**
   * ADR 0127 - the bulk-mail deny-list. On by default; a flag rather than a
   * constant so it can be turned off in prod without a deploy, which is the
   * only way to tell whether a missing suggestion was the gate or the model.
   */
  EMAIL_BULK_GATE: bool('EMAIL_BULK_GATE', true),
  /**
   * ADR 0136 - serve remote email images through our own fetcher. On by
   * default. Off falls the reader back to ADR 0120's block-and-offer, which is
   * the wanted behaviour if the bandwidth this costs ever turns out to bite.
   */
  /**
   * ADR 0226 - how long rows that nothing reads are kept, in days, before the
   * daily prune removes them. 0 keeps that kind forever.
   */
  RETENTION_ENABLED: bool('RETENTION_ENABLED', true),
  RETENTION_PROACTIVE_DAYS: int('RETENTION_PROACTIVE_DAYS', 30),
  RETENTION_REJECTED_PROPOSAL_DAYS: int('RETENTION_REJECTED_PROPOSAL_DAYS', 15),
  RETENTION_EXPIRED_PROPOSAL_DAYS: int('RETENTION_EXPIRED_PROPOSAL_DAYS', 30),
  RETENTION_TOKEN_USAGE_DAYS: int('RETENTION_TOKEN_USAGE_DAYS', 365),
  // ADR 0249 — a receipt kept after its email was deleted, by the email's date.
  RETENTION_RECEIPT_DAYS: int('RETENTION_RECEIPT_DAYS', 1095),
  RETENTION_DELETED_DEVICE_EVENT_DAYS: int('RETENTION_DELETED_DEVICE_EVENT_DAYS', 30),
  // ADR 0057 addendum — a phone calendar not sent for this long is forgotten.
  RETENTION_DEVICE_CALENDAR_DAYS: int('RETENTION_DEVICE_CALENDAR_DAYS', 30),
  /**
   * ADR 0281 — the memory clean-up pass: how often it runs, how long an
   * unanswered proposed fact is kept, and how many chats' confirmed facts the
   * model reviews for duplicates per run.
   */
  MEMORY_CLEANUP_ENABLED: bool('MEMORY_CLEANUP_ENABLED', true),
  MEMORY_CLEANUP_HOURS: int('MEMORY_CLEANUP_HOURS', 24),
  MEMORY_PROPOSED_TTL_DAYS: int('MEMORY_PROPOSED_TTL_DAYS', 30),
  MEMORY_CLEANUP_GROUPS_PER_RUN: int('MEMORY_CLEANUP_GROUPS_PER_RUN', 10),
  EMAIL_IMAGE_PROXY: bool('EMAIL_IMAGE_PROXY', true),
  /**
   * ADR 0225 - fetch a message's remote images when it arrives and serve the
   * stored copies, so opening the mail tells the sender nothing. Needs
   * EMAIL_IMAGE_PROXY. Off = images are fetched when the mail is opened.
   */
  EMAIL_IMAGE_PRELOAD: bool('EMAIL_IMAGE_PRELOAD', true),
  /** Messages preloaded per user per sync pass. */
  EMAIL_IMAGE_PRELOAD_BATCH: int('EMAIL_IMAGE_PRELOAD_BATCH', 20),
  /** Stored image bytes allowed per message; the rest load when opened. */
  EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES: int('EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES', 5 * 1024 * 1024),
  /** How long a stored image is kept, and how far back mail is preloaded. */
  EMAIL_IMAGE_PRELOAD_DAYS: int('EMAIL_IMAGE_PRELOAD_DAYS', 30),
  // Max messages scanned for attachments per sync tick (backfill drains gradually).
  EMAIL_ATTACHMENTS_BATCH_SIZE: int('EMAIL_ATTACHMENTS_BATCH_SIZE', 10),
  /**
   * ADR 0110 — threads per magics tick allowed a second read of the whole
   * message. A RUNAWAY BACKSTOP, not a rationing device: the model only asks
   * when the detail it needed was cut off, and refusing a genuine ask is how a
   * BitGo invoice went unread with the amount one word past the excerpt.
   *
   * Defaults to the magics per-tick thread cap, so it never denies a request
   * the pass could legitimately make. The real bound is structural — a thread
   * is mined once ever, so at most one extra call per thread per tick.
   */
  EMAIL_DEEP_READ_PER_TICK: int('EMAIL_DEEP_READ_PER_TICK', 25),
  /** ADR 0243 — suggestion cards one email may produce (each event, each
   *  to-do, each list). 1 restores one-per-email. */
  EMAIL_MAGICS_MAX_ITEMS: int('EMAIL_MAGICS_MAX_ITEMS', 4),
  /** How much of the message a deep read shows. Twelve times the excerpt: past
   *  the median prod body (9.2k chars) and past the mean (18.1k), short of the
   *  p90 (47k), which is marketing footer rather than anything to extract. */
  EMAIL_DEEP_READ_CHARS: int('EMAIL_DEEP_READ_CHARS', 24000),

  /** ADR 0110 — messages per sync whose body is fetched to fill a missing
   *  excerpt. Existing mail predates the capture, and reclassifying it on the
   *  snippet alone re-runs the pass on the text that produced the wrong answer
   *  the first time. 0 disables the backfill without disabling capture. */
  EMAIL_BODY_BACKFILL_PER_TICK: int('EMAIL_BODY_BACKFILL_PER_TICK', 25),

  // ADR 0019 — minimum number of `other`-bucketed entities sharing a
  // pending_folder_name before the classifier promotes them into a new
  // derived folder. Lower for demo, raise for production.
  CATCHUP_PROMOTION_THRESHOLD: int('CATCHUP_PROMOTION_THRESHOLD', 4),

  // Welcome-DM: the URL the bot points strangers at when they DM
  // before pairing. App-first model — they sign up here, then paste a
  // pair code back into the bot DM.
  //
  // Defaults: if SIGNUP_URL is empty, fall back to the Expo dev URL
  // derived from EXPO_PUBLIC_API_BASE — same host, port 8081. That
  // makes the LAN-IP case Just Work for local dev. Set SIGNUP_URL
  // explicitly when deploying behind a real domain.
  SIGNUP_URL: deriveSignupUrl(),
  WELCOME_DM_ENABLED: bool('WELCOME_DM_ENABLED', true),
  WELCOME_DM_REGREET_DAYS: int('WELCOME_DM_REGREET_DAYS', 7),

  // Testing helper: pre-seed (telegram_id, email) pairs so a developer's
  // Telegram user is linked to a known email before they ever sign in.
  // On first Google login with the matching email, the existing user
  // record (and its external_identities row) is claimed in place — no
  // pair-code dance needed. JSON array, each entry:
  //   { "tg_id": "12345", "email": "foo@example.com",
  //     "display_name"?: "Foo", "tg_display"?: "Foo on TG" }
  // Empty / invalid JSON disables the seed silently.
  SEED_TG_EMAIL_PAIRS: str('SEED_TG_EMAIL_PAIRS', ''),

  // ── Web search (`search_web` bot tool) ────────────────────────────────
  // '' disables the tool entirely (getSearchProvider() returns null — the
  // executor tells the model live search is unavailable rather than letting
  // it fabricate results). 'mock' returns fixture results for tests and
  // LLM_PROVIDER=mock demos, no key needed. 'google' calls the real Google
  // Custom Search JSON API and needs GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX.
  SEARCH_PROVIDER: str('SEARCH_PROVIDER', '') as '' | 'google' | 'mock',
  GOOGLE_SEARCH_API_KEY: str('GOOGLE_SEARCH_API_KEY', ''),
  GOOGLE_SEARCH_CX: str('GOOGLE_SEARCH_CX', ''),

  // ── Meaning-based search (ADR 0276) ───────────────────────────────────
  // Off by default. On: each user's mail is embedded in the background and a
  // search blends meaning matches with keyword matches. Chord's own embedding
  // key is separate from its chat model: EMBEDDINGS_BASE_URL/API_KEY default to
  // OPENAI_* when LLM_PROVIDER=openai (prod: OpenRouter). With no key and a
  // user whose own key cannot embed (Anthropic), search stays keyword-only.
  EMBEDDINGS_ENABLED: bool('EMBEDDINGS_ENABLED', false),
  EMBEDDINGS_BASE_URL: str('EMBEDDINGS_BASE_URL', ''),
  EMBEDDINGS_API_KEY: str('EMBEDDINGS_API_KEY', ''),
  // The OpenAI-compatible model id as Chord's key names it. On OpenRouter it
  // carries the vendor prefix; a direct OpenAI key drops it.
  EMBEDDINGS_MODEL: str('EMBEDDINGS_MODEL', 'openai/text-embedding-3-small'),
  EMBEDDINGS_DIMS: int('EMBEDDINGS_DIMS', 512),
  // 'chord': a BYOK user whose key cannot embed (Anthropic) is embedded on
  // Chord's key. 'none': they get keyword search only.
  EMBEDDINGS_BYOK_FALLBACK: str('EMBEDDINGS_BYOK_FALLBACK', 'chord') as 'chord' | 'none',
  EMBED_PASS_MAX_PER_TICK: int('EMBED_PASS_MAX_PER_TICK', 200),
  EMBED_SWEEP_BATCH: int('EMBED_SWEEP_BATCH', 10),
  EMBED_CACHE_USERS: int('EMBED_CACHE_USERS', 50),
  SEARCH_SEMANTIC_MIN_SIM: num('SEARCH_SEMANTIC_MIN_SIM', 0.3),
  // ADR 0288 — how close in meaning a file must be to the conversation before a
  // bot turn puts it in the prompt. Stricter than search: nobody asked for it.
  RETRIEVAL_SEMANTIC_MIN_SIM: num('RETRIEVAL_SEMANTIC_MIN_SIM', 0.35),
  // ADR 0351 — a push naming one feature the user has not tried, sent once
  // per absence to someone who has not opened the app for REENGAGE_IDLE_DAYS.
  // On by default: anyone with notifications off gets nothing anyway.
  REENGAGE_ENABLED: bool('REENGAGE_ENABLED', true),
  REENGAGE_IDLE_DAYS: num('REENGAGE_IDLE_DAYS', 2),
  // Gone longer than this and we stop trying (their session may have expired).
  REENGAGE_MAX_IDLE_DAYS: num('REENGAGE_MAX_IDLE_DAYS', 21),
  // Never two nudges closer than this, however often they come and go.
  REENGAGE_MIN_GAP_DAYS: num('REENGAGE_MIN_GAP_DAYS', 7),
  REENGAGE_SWEEP_MINUTES: int('REENGAGE_SWEEP_MINUTES', 30),
  REENGAGE_BATCH: int('REENGAGE_BATCH', 50),
  // Local hours (in the user's zone) a nudge may go out: [start, end).
  REENGAGE_START_HOUR: int('REENGAGE_START_HOUR', 10),
  REENGAGE_END_HOUR: int('REENGAGE_END_HOUR', 19),
} as const;

function deriveSignupUrl(): string {
  const explicit = str('SIGNUP_URL', '').trim();
  if (explicit) return explicit;
  const apiBase = str('EXPO_PUBLIC_API_BASE', '').trim();
  if (!apiBase) return '';
  // Swap the API port (usually 4000) for Expo's web/dev port (8081)
  // and keep the host. Falls through unchanged if the URL doesn't
  // parse — better empty than malformed.
  try {
    const u = new URL(apiBase);
    u.port = '8081';
    u.pathname = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
