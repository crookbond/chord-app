/**
 * Kysely database schema. Kept narrow for Phase 0 — only users, sessions, groups,
 * group_members are created. Other tables are added in the Phase 1+ migrations.
 */
import type { ColumnType, Generated } from 'kysely';

import type { EmailAction, MeetingFacts, SchedulingFacts, SenderAuth, TaskArchivedReason } from '@chord/kernel';

/**
 * Helper for nullable columns that are optional on insert/update — e.g.
 * additive identity fields (ADR 0014). Reads as `T | null`, writes accept
 * `T | null | undefined`.
 */
type NullableOptional<T> = ColumnType<T | null, T | null | undefined, T | null | undefined>;

export interface UsersTable {
  id: string;
  username: string;
  display_name: string | null;
  /** Given name (Google `given_name`); also backfilled from display_name. */
  first_name: NullableOptional<string>;
  /** Family name (Google `family_name`). */
  last_name: NullableOptional<string>;
  /** What the user wants to be called. Greeting uses this, else first_name. */
  preferred_name: NullableOptional<string>;
  created_at: string;
  /** 1 when auto-created by import; has no login credentials. */
  shadow: number;
  // ADR 0014 — Google identity. NULL on demo/shadow users. All optional on
  // insert so existing user-creation paths (session, WhatsApp shadow,
  // connector identity-resolver, fixtures) don't have to enumerate them.
  google_sub: NullableOptional<string>;
  /** ADR 0156 — Sign in with Apple identity. */
  apple_sub: NullableOptional<string>;
  /** Sealed Apple refresh token, kept only so account deletion can revoke it. */
  apple_refresh_token_ciphertext: NullableOptional<Buffer>;
  apple_refresh_token_iv: NullableOptional<Buffer>;
  apple_refresh_token_tag: NullableOptional<Buffer>;
  /** ADR 0293 — Sign in with Microsoft identity, `<tid>:<oid>`. */
  microsoft_sub: NullableOptional<string>;
  email: NullableOptional<string>;
  email_verified: ColumnType<number, number | undefined, number | undefined>;
  refresh_token_ciphertext: NullableOptional<Buffer>;
  refresh_token_iv: NullableOptional<Buffer>;
  refresh_token_tag: NullableOptional<Buffer>;
  /** Comma-separated scope list granted on the most recent token. */
  refresh_token_scopes: NullableOptional<string>;
  /** OAuth client id the refresh token was issued to (web vs native iOS).
   *  Google binds tokens to their client; null = legacy/web. */
  refresh_token_client_id: NullableOptional<string>;
  google_connected_at: NullableOptional<string>;
  /** When we last warned the user (in their personal group) that their Google
   *  Calendar connection died and needs reconnecting. Set once per disconnect;
   *  cleared on reconnect so the next death warns again. Null = not warned. */
  calendar_reconnect_nudged_at: NullableOptional<string>;
  /** ADR 0015 — id of the user's "Chord" Google Calendar once provisioned. */
  google_calendar_id: NullableOptional<string>;
  /** Last time we successfully synced events from the user's primary Google calendar. */
  google_calendar_synced_at: NullableOptional<string>;
  // PR-D — per-user settings.
  listening_mode: ColumnType<
    'invocation' | 'passive' | 'active',
    'invocation' | 'passive' | 'active' | undefined,
    'invocation' | 'passive' | 'active'
  >;
  about_me: NullableOptional<string>;
  model_provider: NullableOptional<'openai' | 'gemini' | 'anthropic'>;
  model_name: NullableOptional<string>;
  model_key_ciphertext: NullableOptional<Buffer>;
  model_key_iv: NullableOptional<Buffer>;
  model_key_tag: NullableOptional<Buffer>;
  /** Optional OpenAI-compatible base URL override (Ollama / vLLM / etc.). */
  model_base_url: NullableOptional<string>;
  /** ADR 0063/0194/0195 — VESTIGIAL as of ADR 0196: nothing writes to this
   *  column any more. "Remaining balance" is now computed from `token_usage`
   *  (see `getEntitlement`), never stored/debited. Left in place rather than
   *  dropped — no need forces that decision yet. */
  credit_balance: ColumnType<number, number | undefined, number>;
  /** ADR 0195/0196 — Stripe subscriptions (system-key plan or BYOK base
   *  plan). `stripe_customer_id` is how `invoice.paid` (keyed by Stripe
   *  customer, not our user id) finds the right user.
   *  `subscription_current_period_end` is what `getEntitlement` checks for
   *  BYOK — access lasts until it passes. `subscription_period_started_at` is what the system-key
   *  path sums `token_usage` from — the period boundary IS the reset. */
  stripe_customer_id: NullableOptional<string>;
  stripe_subscription_id: NullableOptional<string>;
  subscription_plan: NullableOptional<'system' | 'family' | 'byok_base'>;
  /** ADR 0231 — monthly or annual, and who sold it (decides where "manage" goes). */
  subscription_interval: NullableOptional<'month' | 'year'>;
  subscription_source: NullableOptional<'stripe' | 'apple'>;
  /** ADR 0231 — set once for people who were here before billing went live;
   *  never cleared. They keep the individual allowance free, permanently. */
  grandfathered_at: NullableOptional<string>;
  subscription_current_period_end: NullableOptional<string>;
  subscription_period_started_at: NullableOptional<string>;
  // ADR 0020 — cross-group personal context opt-in. 1 = bot may use the
  // triggering user's own personal data (tasks/lists/events/important days)
  // when answering in any group. 0 = strict ADR 0004 group-scoped behavior.
  cross_group_personal_context: ColumnType<number, number | undefined, number>;
  /** IANA timezone of the user's last-seen client (e.g. "America/Los_Angeles").
   *  Used by the proactive daily morning scan to fire at the nudge time local. */
  last_tz: NullableOptional<string>;
  /** Daily morning-briefing schedule (local wall clock). The proactive scan
   *  fires at nudge_hour:nudge_minute in `last_tz`. Defaults 07:00. */
  nudge_hour: ColumnType<number, number | undefined, number>;
  nudge_minute: ColumnType<number, number | undefined, number>;
  /** 1 = daily briefing on (default), 0 = no scan seeded/rescheduled. */
  nudge_enabled: ColumnType<number, number | undefined, number>;
  // ADR 0054 — per-category push toggles (1 = on). Quiet-hours window suppresses
  // notify_messages + notify_bot only (the briefing has its own nudge schedule).
  notify_messages: ColumnType<number, number | undefined, number>;
  /** ADR 0117 — new-mail pushes, separate from chat's toggle. */
  notify_email: ColumnType<number, number | undefined, number>;
  /** ADR 0117 — newest mail already pushed about; NULL = never pushed. */
  email_notified_at: NullableOptional<string>;
  /** ADR 0124 - the vacation responder is ours, not the provider settings. */
  vacation_enabled: Generated<number>;
  vacation_subject: NullableOptional<string>;
  vacation_body: NullableOptional<string>;
  vacation_starts_at: NullableOptional<string>;
  vacation_ends_at: NullableOptional<string>;
  vacation_since: NullableOptional<string>;
  notify_bot: ColumnType<number, number | undefined, number>;
  notify_briefing: ColumnType<number, number | undefined, number>;
  quiet_enabled: ColumnType<number, number | undefined, number>;
  quiet_start_hour: ColumnType<number, number | undefined, number>;
  quiet_start_minute: ColumnType<number, number | undefined, number>;
  quiet_end_hour: ColumnType<number, number | undefined, number>;
  quiet_end_minute: ColumnType<number, number | undefined, number>;
  /** ADR 0040 — default calendar this user creates events on, and the calendar
   *  incoming invitations land on. NULL = fall back to primary. */
  default_calendar_id: NullableOptional<string>;
  default_invite_calendar_id: NullableOptional<string>;
  /** ADR 0255 — the mailbox new mail goes out from: 'primary' (the sign-in
   *  Gmail) or an `email_accounts.id`. NULL = the built-in rule. */
  default_send_mailbox: NullableOptional<string>;
  /** ADR 0255 addendum — every LATER per-user default, as key → value, so a
   *  new default is one `defineUserDefault` line, not a migration. jsonb:
   *  parsed on read; write only through services/user-defaults.service.ts. */
  defaults: ColumnType<Record<string, unknown>, string | undefined, string>;
  // ADR 0060 — in-app Gmail reader sync state (mirrors google_calendar_*).
  /** Last Gmail History API cursor for incremental sync. */
  gmail_history_id: NullableOptional<string>;
  /** Last successful Gmail sync (throttle gate). */
  gmail_synced_at: NullableOptional<string>;
  /** When the background mail sweep last took this user, success or not. */
  mail_swept_at: NullableOptional<string>;
  /** When the background calendar sweep last took this user, success or not. */
  calendar_swept_at: NullableOptional<string>;
  /** 0 until the initial paged backfill completes (may span ticks). */
  gmail_backfill_done: ColumnType<number, number | undefined, number>;
  /** Which GMAIL_PROVIDER produced the local mirror. A mismatch with the
   *  current env wipes the mirror before syncing, so mock fixture threads
   *  can never surface in a real account (and vice versa). */
  gmail_mirror_provider: NullableOptional<'mock' | 'real'>;
  /** ADR 0062 — set when we warned the user their Gmail token died; cleared on
   *  reconnect (one warning per disconnect). Null = not warned. */
  gmail_reconnect_nudged_at: NullableOptional<string>;
  /** ADR 0252 — why the user's own model key last failed, when it is theirs to
   *  fix: out of credit, or rejected. Null = healthy (or no key). Cleared by a
   *  call that works and by saving/removing the key. */
  byok_key_issue: NullableOptional<'credit' | 'auth'>;
  byok_key_issue_at: NullableOptional<string>;
  /** Set when the one chat nudge for this outage went out; null = not told. */
  byok_key_nudged_at: NullableOptional<string>;
  /** ADR 0063 — email insights digest after morning briefing. Default on. */
  email_digest_enabled: ColumnType<number, number | undefined, number>;
  /** ADR 0063 — auto-apply Chord/<category> Gmail labels after classify. Default off. */
  gmail_sync_labels_enabled: ColumnType<number, number | undefined, number>;
  /** ADR 0142 — push user-chosen Chord labels to primary Gmail. Default off. */
  chord_label_push_enabled: ColumnType<number, number | undefined, number>;
  /** ADR 0145 — user-chosen name for the PRIMARY Gmail mailbox. */
  gmail_nickname?: string | null;
  /** Plain-text signature appended to outbound email replies. Null = none. */
  email_signature: NullableOptional<string>;
  /** ADR 0260 - the signature as cleaned HTML; null = a plain-text signature (or none). */
  email_signature_html: NullableOptional<string>;
  /** ADR 0136 — load remote images (always proxied) without asking. Default on;
   *  off restores ADR 0120's block-and-offer behaviour. */
  email_images_auto: ColumnType<number, number | undefined, number>;
  /** ADR 0215 — 'archive' | 'trash': what swiping an email row does. */
  email_swipe_action: ColumnType<string, string | undefined, string>;
  email_after_remove: ColumnType<string, string | undefined, string>;
  // ADR 0091 — resolved weather location for the briefing's first line. We
  // store the DERIVED place, never the IP address it came from.
  weather_lat: NullableOptional<number>;
  weather_lon: NullableOptional<number>;
  /** Human-readable place ("Brooklyn"), shown in Settings so a wrong guess is
   *  visible and correctable. */
  weather_place: NullableOptional<string>;
  /** 'ip' | 'tz' | 'user'. A 'user' value is authoritative and is never
   *  overwritten by the automatic tiers. */
  weather_place_source: NullableOptional<string>;
  // ADR 0148 — proactive "you seem to have moved" prompt. The daily scan has
  // no request IP, so /me/timezone stashes the last IP-derived fix here.
  weather_ip_place: NullableOptional<string>;
  weather_ip_lat: NullableOptional<number>;
  weather_ip_lon: NullableOptional<number>;
  weather_ip_at: NullableOptional<string>;
  /** ADR 0258 - the latest fix from the phone (or browser), when location is allowed.
   *  Rounded to ~1 km. Kept even when an explicit choice outranks it. */
  weather_device_place: NullableOptional<string>;
  weather_device_lat: NullableOptional<number>;
  weather_device_lon: NullableOptional<number>;
  weather_device_at: NullableOptional<string>;
  /** Coordinates the last drift question was about, when it was asked, and
   *  whether the user answered "keep it" (suppresses re-asking until a fresh
   *  fix is a real distance from this point). */
  weather_prompt_lat: NullableOptional<number>;
  weather_prompt_lon: NullableOptional<number>;
  weather_prompt_at: NullableOptional<string>;
  weather_prompt_declined: ColumnType<number, number | undefined, number>;
  // ADR 0064 — verified phone number as an identity attribute. Google stays
  // the login/calendar anchor; the phone is the deterministic key that maps a
  // device contact to a Chord user (ADR 0065). NULL until verified.
  /** E.164 (`+15551234567`). Unique across users when set. */
  phone_number: NullableOptional<string>;
  /** HMAC-SHA256 of the E.164 with CONTACT_HASH_PEPPER — the value matched
   *  against uploaded, client-hashed contact numbers (ADR 0065). Denormalized
   *  so contact resolution is an indexed lookup, never a re-hash of every row. */
  phone_hash: NullableOptional<string>;
  /** 1 once ownership was proven (SMS OTP, or WhatsApp backfill). */
  phone_verified: ColumnType<number, number | undefined, number>;
}

export interface SessionsTable {
  token: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
}

export interface GroupsTable {
  id: string;
  name: string;
  kind: 'group' | 'personal';
  invite_code: string;
  ingest_email: string;
  created_by: string;
  created_at: string;
  adults_only: number;
  /**
   * 0 (default) = "no mirror": external non-bot-mention messages are
   * dropped instead of becoming Chord messages. Bot @-mentions still
   * round-trip but are kept chord_visible=0 so they don't show up in
   * the Chord client.
   * 1 = "mirror": every external message becomes a Chord message
   * (current pre-flag behavior).
   */
  mirror_inbound: number;
  /** ADR 0040 — default Google calendar id for events created in this group
   *  (the Family group still defaults to the Family calendar). */
  default_calendar_id: NullableOptional<string>;
  /** ADR 0067 — for a cross-user "pair" group: the two member ids sorted +
   *  joined ("<a>|<b>"), so ensurePairGroup is a find-or-create. NULL for all
   *  ordinary groups. */
  pair_key: NullableOptional<string>;
  /** 1 once a person deliberately named this chat (renamed it, or typed a
   *  name when creating it). 0 means the name is ours or the platform's, so a
   *  two-person chat may display the other member instead. */
  name_is_custom: ColumnType<number, number | undefined, number>;
  /** ADR 0234 — the family-plan owner whose shared chat this is. NULL for every
   *  other group. */
  family_owner_id: NullableOptional<string>;
  /** ADR 0281 — when the memory clean-up pass last reviewed this chat's
   *  confirmed facts for duplicates. NULL = never. */
  memories_reviewed_at: NullableOptional<string>;
}

export interface GroupMembersTable {
  group_id: string;
  user_id: string;
  role: 'owner' | 'member';
  tier: 'verified' | 'trusted' | 'guest';
  joined_at: string;
  /** Last time this member opened the group (ISO). Nullable until first read. */
  last_read_at: string | null;
  /** ADR 0242 — this member cleared the chat at this time; older messages
   *  are out of their view. Null = never cleared. */
  cleared_at?: string | null;
  /** ADR 0054 — 1 = this member muted push notifications for this group. */
  muted: ColumnType<number, number | undefined, number>;
}

/**
 * The kinds of message Chord starts on its own (`messages.proactive_kind`).
 *
 * The first four are scheduled `proactive_messages` rows; the last two are
 * one-off warnings written straight to `messages` (ADR 0042), which is why this
 * union is wider than `ProactiveKind` and why it is declared here — at the
 * column, where every writer can reach it without importing a service.
 */
export type ProactiveMessageKind =
  | 'daily_morning_scan'
  | 'email_digest'
  | 'task_remind'
  | 'event_created_nudge'
  | 'calendar_reconnect'
  | 'gmail_reconnect'
  | 'byok_key_issue'
  | 'trip_cancellation'
  | 'email_change_notice';

/**
 * Whether a proactive message is the user's scheduled daily briefing, in the
 * sense both publishers need: it arrives at a moment the USER chose, so it may
 * spend WhatsApp's one out-of-window template ask (ADR 0089/0091) and it is
 * exempt from push quiet hours (ADR 0054).
 *
 * `task_remind` qualifies — the user named that moment when they set the
 * reminder. An event echo or a reconnect warning does not: nobody asked for it
 * at 9pm, which is exactly how the briefing template came to be sent then.
 */
export function isScheduledBriefing(kind: string | null | undefined): boolean {
  return (
    kind === 'daily_morning_scan' || kind === 'email_digest' || kind === 'task_remind'
  );
}

export interface MessagesTable {
  id: string;
  group_id: string;
  sender_id: string | null;
  kind: 'text' | 'file' | 'system' | 'bot';
  body: string;
  attachment_id: string | null;
  reply_to_id: string | null;
  mentions_bot: number; // 0/1
  created_at: string;
  /**
   * null = live chat (default); 'import' = inserted by WhatsApp export;
   * 'slack' | 'discord' | 'telegram' | 'whatsapp' = inserted by an IM connector (ADR 0010).
   */
  source: 'chat' | 'import' | 'slack' | 'discord' | 'telegram' | 'whatsapp' | null;
  /** Platform-native message id when `source` is a connector. */
  external_message_id: string | null;
  /**
   * 1 = visible in Chord clients (default). 0 = silent — the bot still
   * uses it for context but the Chord client filters it out. Used when
   * mirror_inbound=0 + bot is @-mentioned in an external chat (so the
   * conversation has continuity for the bot but doesn't leak into the
   * Chord group), and when mirror_inbound=1 + the message addresses
   * only the bot (so private bot interactions don't pollute Chord).
   */
  chord_visible: number;
  /**
   * 1 if the message @-mentions any user besides the bot. 0 if the
   * message either has no mentions, or only mentions the bot. Used
   * by the outbound publisher to decide whether to auto-mirror the
   * bot's reply across other bridges (we mirror only when the user
   * is addressing other people too).
   */
  mentions_others: number;
  /**
   * 1 (default) = outbound-publisher fans this message out to bound
   * external bridges if it's a bot reply. 0 = stay local. Set to 0 by
   * the relay tool's target='chord' path so a bot message it
   * deliberately routed to Chord doesn't loop back to every bridge.
   */
  auto_mirror: number;
  /**
   * ADR 0027 — set on bot reply rows to identify which configured
   * persona produced the message. NULL on user/system rows and on
   * pre-migration bot rows (rendered with the default display name).
   */
  bot_persona_id: string | null;
  /**
   * 1 = inserted by proactive.service (morning scan, task reminder,
   * event-created nudge). buildLlmContext filters these out of the
   * LLM's history so templated nudges don't pollute the assistant's
   * apparent prior turns. Still rendered in mobile via SSE.
   */
  is_proactive: number;
  /**
   * WHICH proactive message this is (ADR 0137). `is_proactive` says Chord
   * started the conversation; this says what it started it about, which is the
   * question the WhatsApp session-window gate and the push categoriser were
   * both answering wrong by reading the flag alone.
   *
   * NULL on every non-proactive row, and on proactive rows written before the
   * column existed — treat that as "not the briefing".
   *
   * Optional so the many `const msg: MessagesTable = {…}` literals that are
   * handed straight to `insertInto` stay untouched: absent means the same as
   * NULL, and the failure direction of a forgotten one is the safe one (the
   * briefing's ask does not get spent on a message nobody classified).
   */
  proactive_kind?: ProactiveMessageKind | null;
}

export interface AttachmentsTable {
  id: string;
  scope_kind: 'group' | 'user';
  scope_id: string;
  uploaded_by: string;
  filename: string;
  mime_type: string;
  size: number;
  path: string;
  summary: string | null;
  extracted_text: string | null;
  image_meta: string | null;
  pinned: number;
  indexed_at: string | null;
  // NOT NULL DEFAULT 1 in the DB (migration 010). Optional here so inserts can
  // omit it and fall back to the default; `saveFile` sets it from `input.index`.
  index_requested?: number;
  // ADR 0021 Tier-2 — newline-joined "questions this document answers",
  // generated at extraction and indexed as a high-weight 'questions' chunk.
  answerable_questions?: string | null;
  // Stamped by the download route when the blob is gone from disk (migration
  // 033) — such rows are excluded from search but stay listed so the user
  // can see what needs re-uploading.
  blob_missing_at?: string | null;
  // Migration 036 — source email thread for ADR 0071 imports (SET NULL when
  // the mailbox mirror is wiped; the file stays).
  origin_email_thread_id?: string | null;
  created_at: string;
}

export interface TasksTable {
  id: string;
  group_id: string;
  title: string;
  details: string | null;
  assignee_id: string | null;
  status: 'open' | 'active' | 'done' | 'superseded' | 'archived';
  due_at: string | null;
  remind_at: string | null;
  remind_cue: string | null;
  live_until: string | null;
  archived_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  source_raw_context: string | null;
  /** ADR 0151 — a managed persona (a kid, a grandparent) as the assignee.
   *  Mutually exclusive with assignee_id (service-enforced). */
  assignee_persona_id: string | null;
  /** ADR 0285 — why it was archived; null while live, and for rows archived
   *  before migration 119. */
  archived_reason: TaskArchivedReason | null;
  /** ADR 0314 — 1 when doing it IS replying to the email it came from, so the
   *  user's reply in that thread marks it done. Defaults to 0 in the table;
   *  optional here so every older insert and row literal stays valid. */
  closes_on_reply?: number;
}

/** ADR 0285 — defined once in kernel, which the app reads too. */
export type { TaskArchivedReason };

export interface ListsTable {
  id: string;
  group_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

/** ADR 0311 addendum - the first answer to a write the app may repeat. */
export interface ClientRequestsTable {
  user_id: string;
  key: string;
  /** Null while the first attempt is still running. */
  status: number | null;
  body: string | null;
  created_at: string;
}

/** ADR 0318 - a chat invite sent to an email address. */
export interface ChatInvitesTable {
  id: string;
  inviter_id: string;
  email: string;
  invitee_user_id: string | null;
  group_id: string | null;
  direct: number;
  message: string | null;
  /** 1 once `message` is in the chat (an emailed invite posts it up front). */
  message_posted: number;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
  responded_at: string | null;
}

/** ADR 0326 - a picture from a signature, served publicly by its id. */
export interface SignatureImagesTable {
  id: string;
  user_id: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
  created_at: string;
}

/**
 * AI work that could not run when it was due because the user had not agreed
 * to AI (ADR 0283) or had no allowance (ADR 0079/0325). Re-run once both are
 * met; one row per piece of work.
 */
export interface AiBacklogTable {
  id: string;
  user_id: string;
  kind: 'attachment' | 'whatsapp_import' | 'meeting_context' | 'memory_message';
  ref: string;
  payload: string | null;
  checked_at: string | null;
  created_at: string;
}

export interface ListItemsTable {
  id: string;
  list_id: string;
  text: string;
  checked: number;
  created_at: string;
}

export interface SavesTable {
  id: string;
  group_id: string;
  kind: 'link' | 'place' | 'media' | 'note' | 'contact';
  title: string;
  url: string | null;
  note: string | null;
  tags: string; // JSON
  trip_label: string | null;
  created_by: string | null;
  created_at: string;
  source_raw_context: string | null;
}

export interface EventsTable {
  id: string;
  group_id: string;
  title: string;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
  source_raw_context: string | null;
  /** ADR 0013: dedup key for events sourced from external calendars. */
  external_uid: string | null;
  /** When set, the event belongs to this user (gcal target, "for me" filter). */
  assignee_id: string | null;
  /** ADR 0151 — a managed persona as the subject; the event's owner_user_id is
   *  the persona's managed_by. Mutually exclusive with assignee_id. */
  assignee_persona_id: NullableOptional<string>;
  /** ADR 0015 write half: Google Calendar event id once we've pushed. */
  gcal_event_id: ColumnType<string | null, string | null | undefined, string | null>;
  gcal_sync_status: ColumnType<
    'pending' | 'synced' | 'error' | 'skipped',
    'pending' | 'synced' | 'error' | 'skipped' | undefined,
    'pending' | 'synced' | 'error' | 'skipped'
  >;
  gcal_synced_at: ColumnType<string | null, string | null | undefined, string | null>;
  gcal_last_error: ColumnType<string | null, string | null | undefined, string | null>;
  /** ADR 0033: 'opaque' (default, blocks time) or 'transparent' (informational only). */
  transparency: ColumnType<
    'opaque' | 'transparent',
    'opaque' | 'transparent' | undefined,
    'opaque' | 'transparent'
  >;
  // ── ADR 0040 (expand phase) — user-owned, two-way calendar model. ──
  // All optional on insert during the transition; the existing one-way
  // create path doesn't set them and the contract migration adds the
  // NOT NULLs / UNIQUE constraints once services are cut over.
  /** Our origin stamp (→ Google extendedProperties.private.chordUid). Set only
   *  on events Chord authored; the loop-prevention signal (replaces `gcal:` sniff). */
  chord_uid: NullableOptional<string>;
  /** RFC5545 UID, shared across every copy of a logical event. */
  ical_uid: NullableOptional<string>;
  /** RFC5545 revision counter. Organizer-owned; only the organizer copy bumps. */
  sequence: ColumnType<number, number | undefined, number>;
  /** Google transport-level concurrency token (If-Match on PATCH/DELETE). */
  etag: NullableOptional<string>;
  /** Which Google calendar this copy lives on (selectable target calendar). */
  google_calendar_id: NullableOptional<string>;
  /** Whose calendar this copy lives on — the primary scoping axis. */
  owner_user_id: NullableOptional<string>;
  /** Content authority for the logical event. */
  organizer_user_id: NullableOptional<string>;
  role: ColumnType<'organizer' | 'attendee', 'organizer' | 'attendee' | undefined, 'organizer' | 'attendee'>;
  /** Append-only set of group ids that can see this copy. jsonb: parsed to
   *  string[] on read, JSON string on write. */
  group_ids: ColumnType<string[], string | undefined, string>;
  /** Free-text body, mirrors the Google event `description`. */
  description: NullableOptional<string>;
  /** ADR 0163 — short "what this is about" mined once from prior
   *  correspondence with the event's invitee(s); null until computed, and
   *  stays null when no correspondence was found (never a guess). */
  meeting_context: NullableOptional<string>;
  /** ADR 0223 addendum — guests + organizer the provider lists, lowercased
   *  (migration 145). Read-only: never pushed (ADR 0295). Null = not pulled. */
  guest_emails: ColumnType<string[] | null, string | null | undefined, string | null>;
  /** Named IANA timezones (e.g. 'America/New_York'); the offset is also baked
   *  into starts_at/ends_at. */
  start_tz: NullableOptional<string>;
  end_tz: NullableOptional<string>;
  all_day: ColumnType<number, number | undefined, number>;
  status: ColumnType<
    'confirmed' | 'tentative' | 'cancelled',
    'confirmed' | 'tentative' | 'cancelled' | undefined,
    'confirmed' | 'tentative' | 'cancelled'
  >;
  /** This owner's RSVP on their own copy (per-attendee authority). */
  response_status: NullableOptional<'needsAction' | 'accepted' | 'declined' | 'tentative'>;
  /** Reserved — recurrence is deferred (ADR 0040 decision 3). */
  recurrence: NullableOptional<string>;
  recurring_event_id: NullableOptional<string>;
  original_start: NullableOptional<string>;
  /** A local edit/delete not yet pushed to Google. */
  local_dirty: ColumnType<number, number | undefined, number>;
  /** "Time of update" — the LWW conflict tiebreak. */
  updated_at: NullableOptional<string>;
  /** Soft-delete tombstone timestamp; drives two-way delete. */
  deleted_at: NullableOptional<string>;
  /** ADR 0217 — this row is one occurrence of a Chord series. */
  series_id: NullableOptional<string>;
  /** ADR 0289 addendum 2026-10-24 — the trip this entry is part of. */
  trip_id: NullableOptional<string>;
  /** How `trip_id` was set: NULL = not decided, 'auto' = matched, 'user' =
   *  the user said so (with `trip_id` NULL meaning "not travel"). */
  trip_link: NullableOptional<'auto' | 'user'>;
  /** ADR 0328 — set on a member's row when they were INVITED to a group
   *  event rather than given a copy: the address invited. Such a row is
   *  Chord's own record and is never pushed. */
  invite_email: NullableOptional<string>;
  /** How the invitation went: the organizer's calendar, or an iTIP request
   *  mailed from the organizer's mailbox. */
  invite_via: NullableOptional<'calendar' | 'mail'>;
  /** The UID the invitation arrives under on the member's calendar (the
   *  organizer's provider event's iCalUID); their pull matches on it. */
  invite_uid: NullableOptional<string>;
  /** 1 = the next push of this row should notify its guests (the time or
   *  place changed). Cleared once pushed. */
  guest_notice_due: ColumnType<number, number | undefined, number>;
  /** ADR 0328 — on the organizer's row: each guest and their answer, as the
   *  calendar or a mailed reply last reported it. JSON `GuestAnswer[]`. */
  guest_answers: NullableOptional<string>;
}

/** ADR 0217 — a repeating event. Its occurrences are `events` rows with
 *  `series_id`; this row holds the rule and the Google master. */
export interface EventSeriesTable {
  id: string;
  /** Shared by every family member's copy of one logical series. */
  series_uid: string;
  group_id: string;
  group_ids: ColumnType<string[], string | undefined, string>;
  owner_user_id: string | null;
  organizer_user_id: NullableOptional<string>;
  role: ColumnType<'organizer' | 'attendee', 'organizer' | 'attendee' | undefined, 'organizer' | 'attendee'>;
  created_by: string | null;
  assignee_id: NullableOptional<string>;
  assignee_persona_id: NullableOptional<string>;
  title: string;
  description: NullableOptional<string>;
  location: NullableOptional<string>;
  /** First occurrence, as `events.starts_at` would store it. */
  starts_at: string;
  ends_at: NullableOptional<string>;
  all_day: ColumnType<number, number | undefined, number>;
  transparency: ColumnType<'opaque' | 'transparent', 'opaque' | 'transparent' | undefined, 'opaque' | 'transparent'>;
  /** IANA zone the rule's wall-clock times are in. */
  tz: string;
  /** RRULE body without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=WE`. */
  rrule: string;
  /** Local wall-clock starts ("YYYY-MM-DDTHH:mm:ss") removed from the series. */
  exdates: ColumnType<string[], string | undefined, string>;
  /** Occurrences exist up to here (ISO date). */
  materialized_until: NullableOptional<string>;
  source_raw_context: NullableOptional<string>;
  google_calendar_id: NullableOptional<string>;
  /** The Google series master. */
  gcal_event_id: NullableOptional<string>;
  etag: NullableOptional<string>;
  chord_uid: NullableOptional<string>;
  local_dirty: ColumnType<number, number | undefined, number>;
  deleted_at: NullableOptional<string>;
  gcal_sync_status: NullableOptional<string>;
  gcal_last_error: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}

/** ADR 0040 — invitees of a logical event (the rsvps successor). One row per
 *  (logical event, person); copies are linked by `ical_uid`. */
export interface EventAttendeesTable {
  id: string;
  ical_uid: string;
  user_id: string | null;
  email: string | null;
  display_name: string;
  role: ColumnType<'viewer' | 'editor', 'viewer' | 'editor' | undefined, 'viewer' | 'editor'>;
  response_status: ColumnType<
    'needsAction' | 'accepted' | 'declined' | 'tentative',
    'needsAction' | 'accepted' | 'declined' | 'tentative' | undefined,
    'needsAction' | 'accepted' | 'declined' | 'tentative'
  >;
  is_organizer: ColumnType<number, number | undefined, number>;
  solo: ColumnType<number, number | undefined, number>;
  dish: string | null;
  notes: string | null;
  updated_at: string;
}

/**
 * ADR 0033 — one row per (user, Google calendar) tracking whether
 * events from that calendar count toward conflict checks. Auto picked
 * on each sync from Google's calendar list; the user may set an
 * override that wins over auto.
 */
/** ADR 0228 — 'outlook' rows store `outlook:<accountId>:<calendarId>` in
 *  `google_calendar_id`, the same generic source-id column 'device' uses. */
export type CalendarProvider = 'google' | 'device' | 'outlook';

export interface CalendarSourcesTable {
  id: string;
  user_id: string;
  /** ADR 0057 — the source provider. 'device' rows store the device calendar id
   *  in `google_calendar_id` (the generic source-id column). */
  provider: ColumnType<CalendarProvider, CalendarProvider | undefined, CalendarProvider>;
  /** Generic source calendar id. For 'google' this is the Google calendar id;
   *  for 'device' it's the EventKit/CalendarProvider calendar id. */
  google_calendar_id: string;
  summary: string | null;
  /** ADR 0057 — display color (hex) from the source calendar; NULL if unknown. */
  color: NullableOptional<string>;
  /** ADR 0278 — the color the user picked in Chord (`#RRGGBB`); NULL = not
   *  picked. Its own column so a provider sync rewriting `color` keeps it. */
  color_choice: NullableOptional<string>;
  /** 'reader' | 'writer' | 'owner' — freeBusyReader cals aren't synced. */
  access_role: string;
  is_primary: number;
  /** Mirror of Google's calendarListEntry.selected (UI hint). */
  selected_in_google: number;
  /**
   * Auto-picked busy-ness flag. NULL means "we don't know, ask the
   * user" — surfaced as a pending decision in the settings UI.
   */
  counts_for_busy_auto: number | null;
  /** User override; NULL = use auto. */
  counts_for_busy_override: number | null;
  first_seen_at: string;
  last_seen_at: string;
  /** ADR 0040 — this is the user's default write/target calendar. */
  is_default_write: ColumnType<number, number | undefined, number>;
  /** ADR 0040 — incremental-sync cursor for the two-way pull. NULL = do an
   *  initial windowed sync to obtain the first token. */
  sync_token: NullableOptional<string>;
  /** When the pull last listed the whole window (not a delta). NULL = never. */
  full_synced_at: NullableOptional<string>;
}

export interface RsvpsTable {
  id: string;
  event_id: string;
  user_id: string | null;
  display_name: string;
  status: 'yes' | 'no' | 'maybe' | 'pending';
  solo: number;
  dish: string | null;
  notes: string | null;
  updated_at: string;
}

export interface PlacesTable {
  id: string;
  group_id: string;
  name: string;
  area: string | null;
  city: string | null;
  tags: string; // JSON
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ContactsTable {
  id: string;
  group_id: string;
  name: string;
  org: string | null;
  education: string | null; // JSON
  family: string | null;
  tags: string; // JSON
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface MediaItemsTable {
  id: string;
  group_id: string;
  kind: 'book' | 'podcast' | 'show' | 'movie' | 'article';
  title: string;
  note: string | null;
  done: number;
  created_by: string | null;
  created_at: string;
}

export interface MemoriesTable {
  id: string;
  group_id: string;
  persona_id: string | null;
  scope: 'persona' | 'group' | 'event';
  key: string;
  value: string;
  source: 'passive' | 'extracted' | 'explicit';
  confidence: number;
  status: 'proposed' | 'confirmed';
  superseded_by: string | null;
  created_at: string;
  /** Family-profile surface — denormalised subject identity + grouping.
   *  Nullable: derived from scope/persona_id for legacy rows, kept in
   *  lockstep on write. See family-profile-design.md.
   *  'person' (migration 082) — a private `people` row, not a group persona;
   *  always written under the owner's personal group (see memory.service.ts). */
  subject_type: 'user' | 'persona' | 'household' | 'person' | null;
  subject_id: string | null;
  category:
    | 'health'
    | 'school'
    | 'contact'
    | 'sizes'
    | 'prefs'
    | 'logistics'
    | 'dates'
    | 'note'
    | null;
  provenance: string | null;
  dated_at: string | null;
  /** Migration 082 — set only for an attribute fact about an ALREADY-confirmed
   *  subject (never for a new person/relationship claim); a background sweep
   *  auto-confirms it at this time unless a human acts first. NULL = manual only. */
  auto_confirm_at: string | null;
}

export interface TripsTable {
  id: string;
  group_id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  created_by: string | null;
  created_at: string;
  source_raw_context: string | null;
  /** ADR 0168 — derived: set when every leg/accommodation/reservation is cancelled. */
  cancelled_at: string | null;
  /** Soft-delete: set by the user's own "x" on the Trips tab, or derived when
   *  the last leg/accommodation/reservation on the trip is removed. Never a
   *  cascade — legs/accommodations are hard-deleted individually. */
  deleted_at: string | null;
}

export interface TripParticipantsTable {
  trip_id: string;
  persona_id: string;
}

/** ADR 0289 addendum - someone on a trip with no account in its group. */
export interface TripNamedTravelersTable {
  trip_id: string;
  /** `tokenSetKey(nameTokens(name))`, so one person is stored once. */
  name_key: string;
  name: string;
  /** Set when the name is a family member (persona) of the trip's group. */
  persona_id: string | null;
}

export interface TravelLegsTable {
  id: string;
  trip_id: string;
  persona_id: string | null;
  passenger_name: string | null;
  mode: 'flight' | 'train' | 'car' | 'ferry' | 'other';
  origin: string;
  destination: string;
  depart_at: string;
  arrive_at: string;
  carrier: string | null;
  flight_no: string | null;
  confirmation: string | null;
  /** ADR 0158 — free-text booking detail (e.g. "Itinerary 73541634338201"). */
  notes: string | null;
  source_doc_id: string | null;
  created_at: string;
  source_raw_context: string | null;
  /** ADR 0168 — set when a cancellation email matches this specific leg. */
  cancelled_at: string | null;
}

export interface AccommodationsTable {
  id: string;
  trip_id: string;
  property_name: string;
  address: string | null;
  checkin_date: string;
  checkout_date: string;
  room_count: number | null;
  confirmation: string | null;
  /** ADR 0158 — free-text booking detail. */
  notes: string | null;
  source_doc_id: string | null;
  created_at: string;
  source_raw_context: string | null;
  /** ADR 0168 — set when a cancellation email matches this specific stay. */
  cancelled_at: string | null;
}

export interface TripReservationsTable {
  id: string;
  trip_id: string;
  kind: 'restaurant' | 'tour' | 'event' | 'activity' | 'other';
  name: string;
  date_time: string | null;
  address: string | null;
  confirmation: string | null;
  notes: string | null;
  created_at: string;
  source_raw_context: string | null;
}

export interface ExternalIdentitiesTable {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  external_id: string;
  external_display: string | null;
  user_id: string;
  created_at: string;
}

export interface GroupExternalChannelsTable {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  external_channel_id: string;
  group_id: string;
  /** JSON-encoded per-platform extras (workspace id, guild id, etc.). */
  config_json: string | null;
  /** Per-Chord-group short label ("telegram", "family"). Unique per group. */
  alias: string;
  created_at: string;
  // ADR 0025 — BYO bot token columns. NULL trio means "use deploy-wide
  // bot." Non-NULL means this binding has its own bot identity; the
  // connector registry keys by (platform, bot_user_id).
  bot_user_id: NullableOptional<string>;
  bot_token_ciphertext: NullableOptional<Buffer>;
  bot_token_iv: NullableOptional<Buffer>;
  bot_token_tag: NullableOptional<Buffer>;
  // ADR 0089 — WhatsApp's 24h session window. `last_inbound_at` is stamped on
  // every inbound (including button taps, which are not messages) and decides
  // whether a proactive send may be free-form text or must be a template.
  last_inbound_at: NullableOptional<string>;
  /** Channel-scoped briefing mute. `users.nudge_enabled` stays untouched. */
  briefing_opted_out: ColumnType<number, number | undefined, number>;
  /** Set when the nudge template goes out; cleared when the user writes. */
  nudge_prompt_sent_at: NullableOptional<string>;
  /** Briefing held back pending the user's answer to that template. */
  pending_briefing_message_id: NullableOptional<string>;
}

export interface PendingConnectorPairingsTable {
  code: string;
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  group_id: string;
  created_by_user_id: string;
  /** Alias to attach to the binding once the code is consumed. */
  alias: string;
  created_at: string;
  expires_at: string;
  // ADR 0025 — BYO. Captured at pair-start when the user supplies their
  // own token; copied onto the binding row when the code is consumed.
  bot_user_id: NullableOptional<string>;
  bot_username: NullableOptional<string>;
  bot_token_ciphertext: NullableOptional<Buffer>;
  bot_token_iv: NullableOptional<Buffer>;
  bot_token_tag: NullableOptional<Buffer>;
}

export interface ProposalsTable {
  id: string;
  group_id: string;
  proposed_by_user_id: string | null;
  proposed_by_message_id: string | null;
  tool_name: string;
  args_json: string;
  provenance: string | null;
  /** ADR 0063 — execute the tool in this group on confirm (email magics
   *  route to the matched Chord group for fan-out). NULL = use group_id. */
  target_group_id: string | null;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired';
  resolved_by_user_id: string | null;
  resolved_by_message_id: string | null;
  resolved_at: string | null;
  bundle_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface ProactiveMessagesTable {
  id: string;
  group_id: string;
  persona_id: string | null;
  kind: string;
  /** JSON-encoded per-kind payload. */
  payload: string;
  scheduled_for: string;
  fired_at: string | null;
  created_at: string;
  /** Failed renders/sends so far; drives the retry backoff (migration 137). */
  attempts?: number;
  /** Not retried before this instant; NULL = due now. */
  retry_after?: string | null;
}

export interface DocumentPermissionsTable {
  id: string;
  attachment_id: string;
  /** Exactly one of group_id / user_id is set (CHECK constraint). */
  group_id: string | null;
  user_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

export interface MessageCardsTable {
  message_id: string;
  cards_json: string;
  created_at: string;
}

/** ADR 0281 — which message carries a learned fact's chat card. No FK to
 *  memories, so a deleted fact's card can still be updated to "removed". */
export interface MemoryNoticesTable {
  memory_id: string;
  message_id: string;
  created_at: string;
}

/** ADR 0299 — a user's progress through one chat skill. */
/** ADR 0301 — a reported message, kept and emailed to the support address. */
export interface ContentReportsTable {
  id: string;
  reporter_user_id: string;
  reported_user_id: string | null;
  group_id: string | null;
  message_id: string;
  /** The message text as it was when reported. */
  message_body: string;
  attachment_name: string | null;
  reason: string | null;
  created_at: string;
  emailed_at: string | null;
  email_attempts: ColumnType<number, number | undefined, number>;
  last_attempt_at: string | null;
  last_error: string | null;
}

export interface SkillRunsTable {
  id: string;
  user_id: string;
  group_id: string;
  skill_id: string;
  status: 'active' | 'paused' | 'done' | 'stopped';
  /** The step being asked now; null for a skill with no steps. */
  step_id: string | null;
  /** Step ids, JSON arrays. */
  answered: ColumnType<string[], string | undefined, string>;
  skipped: ColumnType<string[], string | undefined, string>;
  started_at: string;
  updated_at: string;
}

/** ADR 0300 — a skill stored as data. `definition` is checked by
 *  `skills/definition.ts` on save and again on load. */
export interface SkillDefinitionsTable {
  id: string;
  definition: ColumnType<unknown, string, string>;
  enabled: number;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

export interface SkillDefinitionVersionsTable {
  skill_id: string;
  version: number;
  definition: ColumnType<unknown, string, string>;
  created_at: string;
  created_by: string | null;
}

/** ADR 0284 — a fact's search vector for one embedding model. Not sealed:
 *  the fact it comes from is not. */
export interface MemoryEmbeddingsTable {
  memory_id: string;
  model: string;
  content_hash: string;
  vec: Buffer;
  embedded_at: string;
}

export interface PeopleTable {
  id: string;
  owner_user_id: string;
  display_name: string;
  notes: string | null;
  /** ADR 0076 — sender anchor: known email address for this person. */
  email: NullableOptional<string>;
  /** ADR 0212 — phone number as the user gave it (not E.164-normalised). */
  phone: NullableOptional<string>;
  /** ADR 0312 — what produced this person (`gmail:<threadId>`), so the
   *  mailbox's disconnect removes it. Null = typed, chatted, or older. */
  provenance: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}

/**
 * Family personas — the roster for the per-group family-profile surface
 * (design doc family-profile-design.md). Every member of a `kind='group'`
 * group is a persona; account-holders carry `member_user_id`, managed
 * non-users carry `is_managed` + `managed_by`. Distinct from `bot_personas`.
 */
export interface PersonasTable {
  id: string;
  group_id: string;
  /** Set iff this member has a Chord account. */
  member_user_id: string | null;
  name: string;
  household_role: 'parent' | 'child' | 'grandparent' | 'caregiver' | 'other';
  is_managed: number;
  managed_by: string | null;
  /** 'YYYY-MM-DD'; null when unknown. */
  birthdate: string | null;
  linked_person_id: string | null;
  created_at: string;
}

export interface ImportantDatesTable {
  id: string;
  person_id: string;
  /** 'birthday' | 'anniversary' | 'death' | 'other' */
  kind: string;
  /** 'YYYY-MM-DD' — year '0000' = unknown, used with recurs=1 for month/day. */
  date: string;
  recurs: ColumnType<number, number | undefined, number | undefined>;
}

/**
 * Migration 083 — a person extracted from mail/chat that the user has not
 * confirmed. Deliberately NOT `people`: that table is read by the bulk gate,
 * autocomplete, invite resolution and the People screen, and an unconfirmed
 * contact must be invisible to all of them. `id` becomes `people.id` on promote.
 */
export interface ProvisionalPeopleTable {
  id: string;
  owner_user_id: string;
  display_name: string;
  email: string | null;
  notes: string | null;
  /** The pending add_person proposal this row rides on; the orphan sweep keys off it. */
  proposal_id: string | null;
  created_at: string;
}

/**
 * Migration 082 — completes ADR 0016's never-shipped `relationships` table.
 * A structural edge ("X is spouse-of Y") between two subjects, each a `user`,
 * a group `persona`, or a private `person`. Polymorphic without FKs, same
 * pattern `memories.subject_type`/`subject_id` already uses — never a single
 * "current value" to supersede (two people can be both coworkers AND
 * friends), so no supersede chain like `memories` has. Deliberately never
 * lighter-barred: asserting a relationship is an identity claim, same stakes
 * as `add_person` (see people.service.ts's `addPersonRelationship`).
 */
export interface PersonRelationshipsTable {
  id: string;
  owner_user_id: string;
  subject_type: 'user' | 'persona' | 'person';
  subject_id: string;
  related_type: 'user' | 'persona' | 'person';
  related_id: string;
  /** Canonical vocabulary — see `normalizeRelation` in people.service.ts. */
  relation: string;
  confidence: number;
  status: 'proposed' | 'confirmed';
  source: 'passive' | 'extracted' | 'explicit';
  provenance: string | null;
  created_at: string;
}

export interface CatchupFoldersTable {
  id: string;
  user_id: string;
  /** One word, lowercase. Stable identifier — never renamed once created. */
  name: string;
  /** Title-cased presentation label. Renamable. */
  display: string;
  /** 'seed' = always shown (tasks/lists/trips/other); 'derived' = promoted; 'archived' = demoted but reusable. */
  kind: 'seed' | 'derived' | 'archived';
  /** Pinned derived folders are exempt from demotion. */
  pinned: number;
  created_at: string;
}

export interface CatchupAssignmentsTable {
  user_id: string;
  entity_type: 'task' | 'list' | 'save' | 'trip';
  entity_id: string;
  folder_id: string;
  source: 'classifier' | 'manual';
  /**
   * When the classifier suggested a name we don't have a folder for, the
   * entity lands in `other` and the suggestion is recorded here so the
   * promotion job can find clusters.
   */
  pending_folder_name: string | null;
  created_at: string;
}

export interface AttachmentChunkMetaTable {
  attachment_id: string;
  chunk_idx: number;
  kind: 'summary' | 'ocr' | 'text' | 'caption' | 'keyfacts';
  char_offset: number;
}

export interface FormsTable {
  id: string;
  group_id: string;
  title: string;
  source_attachment_id: string;
  subject_person_id: string | null;
  /** JSON-encoded FormSchema (kernel/src/types/form.ts) */
  schema_json: string;
  /** JSON-encoded `Record<fieldName, value>` */
  answers_json: string;
  status: 'draft' | 'filled';
  filled_attachment_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * ADR 0027 — configurable bot persona. One row per persona; Phase 1
 * deployments use a single 'default' row seeded from env at first
 * boot. `mention_aliases` and `enabled_tools` are JSON-encoded string
 * arrays. NULL `enabled_tools` means "all tools allowed" (subject to
 * `write_allowed`).
 */
export interface BotPersonasTable {
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
}

/**
 * Tracks which external DM senders have already received the
 * "welcome to Chord" templated reply. Composite (platform,
 * external_user_id) primary key so a single user can DM multiple
 * platforms; re-greet logic uses `greeted_at` for a stale-cooldown
 * check.
 */
export interface ConnectorDmGreetedTable {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  external_user_id: string;
  greeted_at: string;
  /**
   * Drives the DM-onboarding state machine. NULL = pre-onboarding row
   * (legacy / kill-switched). `pending_email` = bot asked for email,
   * waiting for the user's reply. `invited` = magic-link issued. `completed`
   * = user signed up; shadow user has been flipped to a real account.
   */
  state: ColumnType<
    'pending_email' | 'invited' | 'completed' | null,
    'pending_email' | 'invited' | 'completed' | null | undefined,
    'pending_email' | 'invited' | 'completed' | null | undefined
  >;
}

/**
 * One row per signup magic link DMed to a stranger on a connector.
 * Consumed by POST /auth/google when the user completes OAuth — on
 * email match we flip the shadow user row in place. Tokens carry
 * their own TTL; consumed_at locks them after a successful use.
 */
export interface SignupIntentsTable {
  token: string;
  /**
   * Legacy column from the killed email-collect-on-bot-side flow.
   * Nullable as of migration 040: the referrer-token flow mints an
   * intent before we know the user's email. Populated post-consume with
   * the Google-verified email so we have an audit trail.
   */
  email: string | null;
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  external_user_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface MigrationsTable {
  name: string;
  applied_at: string;
  _pk: Generated<number>;
}

export interface WaitlistTable {
  id: string;
  email: string;
  name: string | null;
  note: string | null;
  created_at: string;
}

/** ADR 0063 — append-only token movements; source of truth reconciled with
 *  users.credit_balance. `ref` is unique so a purchase/turn can't double-post. */
export interface CreditLedgerTable {
  id: string;
  user_id: string;
  /** Signed: +grant/+purchase/+subscription_reset, −turn_debit. A
   *  `subscription_reset` delta can be negative (this period's grant is
   *  less than what was left over, though it never rolls over anyway). */
  delta: number;
  reason: 'purchase' | 'turn_debit' | 'grant' | 'refund' | 'subscription_reset';
  /** Idempotency key: Stripe session/invoice id, or the bot message id for a turn. */
  ref: string;
  balance_after: number;
  created_at: string;
}

/** ADR 0201 — one wrapped data key per owner. `wrapped_dek` is null once destroyed. */
export interface ContentKeysTable {
  owner: string;
  wrapped_dek: Buffer | null;
  provider: string;
  created_at: string;
  destroyed_at: string | null;
}

/** ADR 0231 — a single-use code that gives a new subscriber a free first
 *  period (a trial: the card is taken up front and charged when it ends). */
export interface PromoCodesTable {
  code: string;
  kind: 'free_month';
  trial_days: ColumnType<number, number | undefined, number>;
  note: NullableOptional<string>;
  created_at: string;
  expires_at: NullableOptional<string>;
  redeemed_by: NullableOptional<string>;
  redeemed_at: NullableOptional<string>;
}

/** ADR 0242 — a message one member deleted for themselves in a shared chat.
 *  Everyone else still sees it. */
export interface MessageHidesTable {
  user_id: string;
  message_id: string;
  group_id: string;
  created_at: string;
}

/** ADR 0249 — a receipt kept apart from its email, so deleting or trashing
 *  the mail does not take it out of the totals. Keyed by the provider thread
 *  id; removed RETENTION_RECEIPT_DAYS after `email_at` and with the account. */
export interface EmailReceiptsTable {
  id: string;
  user_id: string;
  gmail_thread_id: string;
  receipt_json: ColumnType<
    {
      merchant?: string | null;
      amount?: number | null;
      currency?: string | null;
      purchasedAt?: string | null;
      orderNumber?: string | null;
      /** Card type and last four digits ("Visa ••1234"), or "PayPal" etc. Never a full number. */
      paymentMethod?: string | null;
    },
    string,
    string
  >;
  from_name: string | null;
  from_email: string | null;
  /** The mailbox it arrived in: null = the primary Gmail (ADR 0080). Not a key. */
  account_id: string | null;
  /** That mailbox's address when the receipt was kept. */
  mailbox: string | null;
  email_at: string;
  created_at: string;
}

/** ADR 0235 — one open "connect OpenRouter" attempt. `state` is the unguessable
 *  single-use credential the callback arrives with; the PKCE verifier never
 *  leaves this table. Rows live ten minutes. */
/** ADR 0335 — an MCP client that registered itself (RFC 7591). */
export interface OauthClientsTable {
  id: string;
  /** `h_<sha256>` of the client secret; null for a public (PKCE-only) client. */
  secret_hash: string | null;
  name: string;
  client_uri: string | null;
  /** JSON array of exact redirect URIs (written as a JSON string). */
  redirect_uris: ColumnType<string[], string, string>;
  created_at: string;
}

/** ADR 0335 — one authorization attempt, then the code it produced. */
export interface OauthRequestsTable {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string;
  resource: string | null;
  created_at: string;
  expires_at: string;
  user_id: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  used_at: string | null;
}

/** ADR 0335 — what one user allowed one client to do. */
export interface OauthGrantsTable {
  id: string;
  user_id: string;
  client_id: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** ADR 0335 — access and refresh tokens, stored hashed. */
export interface OauthTokensTable {
  token_hash: string;
  grant_id: string;
  kind: 'access' | 'refresh';
  created_at: string;
  expires_at: string;
  /** Set when a refresh token was exchanged for a new one; presenting it again revokes the grant. */
  rotated_at: string | null;
}

export interface OpenrouterConnectsTable {
  state: string;
  user_id: string;
  code_verifier: string;
  model: string;
  platform: 'web' | 'native';
  created_at: string;
}

/** ADR 0231 — the family plan's roster. `owner_user_id` pays; `user_id` is set
 *  once the person has a Chord account on the plan. A `profile` row is a person
 *  with no invite out (uses no seat); `invited` holds a seat; `active` is covered. */
export interface FamilyMembersTable {
  id: string;
  owner_user_id: string;
  user_id: NullableOptional<string>;
  name: string;
  email: NullableOptional<string>;
  phone: NullableOptional<string>;
  relationship: NullableOptional<string>;
  status: 'profile' | 'invited' | 'active';
  chordinator: ColumnType<number, number | undefined, number>;
  invite_code: NullableOptional<string>;
  /** The owner's private People row this member mirrors (ADR 0078). */
  person_id: NullableOptional<string>;
  created_at: string;
  invited_at: NullableOptional<string>;
  joined_at: NullableOptional<string>;
}

/** ADR 0193 — per-user token-usage visibility. Append-only, no unique `ref`
 *  (not a billing ledger — credit_ledger above stays the actual gate). */
export interface TokenUsageTable {
  id: string;
  user_id: string;
  source:
    | 'bot_turn'
    | 'email_classify'
    | 'email_magics'
    | 'email_persons'
    | 'email_reply'
    | 'email_summary'
    | 'embedding'
    | 'memory_cleanup'
    | 'briefing'
    | 'nudge'
    | 'memory_extract'
    | 'attachment_read'
    | 'content_classify'
    | 'trip_classify'
    | 'form_fill'
    | 'meeting_context'
    | 'whatsapp_import';
  ref: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** ADR 0332 — prompt tokens read from cache; null when not reported. */
  cached_tokens: number | null;
  /** ADR 0332 — dollars billed for the call; null when not reported. Recorded
   *  to price the allowance; the allowance itself counts total_tokens. */
  cost_usd: number | null;
  created_at: string;
}

/** ADR 0067 — sender-initiated / recipient-opt-out consent for cross-user
 *  messaging. A row means `blocker` refuses messages from `blocked`. */
export interface BlocksTable {
  blocker_user_id: string;
  blocked_user_id: string;
  created_at: string;
}

/** ADR 0342 — a deleted account's sign-in identities, fingerprinted, so a
 *  new account with any of them gets no second free allowance. */
export interface SpentFreeAllowancesTable {
  fingerprint: string;
  created_at: string;
}

export interface DB {
  users: UsersTable;
  spent_free_allowances: SpentFreeAllowancesTable;
  credit_ledger: CreditLedgerTable;
  token_usage: TokenUsageTable;
  content_keys: ContentKeysTable;
  blocks: BlocksTable;
  sessions: SessionsTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  messages: MessagesTable;
  attachments: AttachmentsTable;
  tasks: TasksTable;
  lists: ListsTable;
  list_items: ListItemsTable;
  client_requests: ClientRequestsTable;
  chat_invites: ChatInvitesTable;
  signature_images: SignatureImagesTable;
  ai_backlog: AiBacklogTable;
  saves: SavesTable;
  events: EventsTable;
  event_series: EventSeriesTable;
  rsvps: RsvpsTable;
  event_attendees: EventAttendeesTable;
  places: PlacesTable;
  contacts: ContactsTable;
  media_items: MediaItemsTable;
  memories: MemoriesTable;
  document_permissions: DocumentPermissionsTable;
  proactive_messages: ProactiveMessagesTable;
  trips: TripsTable;
  trip_participants: TripParticipantsTable;
  trip_named_travelers: TripNamedTravelersTable;
  travel_legs: TravelLegsTable;
  accommodations: AccommodationsTable;
  trip_reservations: TripReservationsTable;
  proposals: ProposalsTable;
  message_cards: MessageCardsTable;
  memory_notices: MemoryNoticesTable;
  skill_runs: SkillRunsTable;
  skill_definitions: SkillDefinitionsTable;
  skill_definition_versions: SkillDefinitionVersionsTable;
  content_reports: ContentReportsTable;
  memory_embeddings: MemoryEmbeddingsTable;
  external_identities: ExternalIdentitiesTable;
  group_external_channels: GroupExternalChannelsTable;
  pending_connector_pairings: PendingConnectorPairingsTable;
  people: PeopleTable;
  personas: PersonasTable;
  family_members: FamilyMembersTable;
  promo_codes: PromoCodesTable;
  openrouter_connects: OpenrouterConnectsTable;
  oauth_clients: OauthClientsTable;
  oauth_requests: OauthRequestsTable;
  oauth_grants: OauthGrantsTable;
  oauth_tokens: OauthTokensTable;
  message_hides: MessageHidesTable;
  important_dates: ImportantDatesTable;
  person_relationships: PersonRelationshipsTable;
  provisional_people: ProvisionalPeopleTable;
  attachment_chunk_meta: AttachmentChunkMetaTable;
  catchup_folders: CatchupFoldersTable;
  catchup_assignments: CatchupAssignmentsTable;
  forms: FormsTable;
  trusted_senders: TrustedSendersTable;
  permission_requests: PermissionRequestsTable;
  phone_verifications: PhoneVerificationsTable;
  contact_links: ContactLinksTable;
  bot_personas: BotPersonasTable;
  connector_dm_greeted: ConnectorDmGreetedTable;
  signup_intents: SignupIntentsTable;
  outbound_connector_messages: OutboundConnectorMessagesTable;
  waitlist: WaitlistTable;
  calendar_sources: CalendarSourcesTable;
  push_tokens: PushTokensTable;
  email_accounts: EmailAccountsTable;
  email_threads: EmailThreadsTable;
  meetings: MeetingsTable;
  email_thread_embeddings: EmailThreadEmbeddingsTable;
  attachment_embeddings: AttachmentEmbeddingsTable;
  email_receipts: EmailReceiptsTable;
  email_messages: EmailMessagesTable;
  email_drafts: EmailDraftsTable;
  email_provider_draft_removals: EmailProviderDraftRemovalsTable;
  email_read_writes: EmailReadWritesTable;
  mail_subscriptions: MailSubscriptionsTable;
  email_image_senders: EmailImageSendersTable;
  email_image_cache: EmailImageCacheTable;
  email_unsubscribes: EmailUnsubscribesTable;
  email_auto_replies: EmailAutoRepliesTable;
  email_categories: EmailCategoriesTable;
  email_message_categories: EmailMessageCategoriesTable;
  email_extraction_marks: EmailExtractionMarksTable;
  email_routing_rules: EmailRoutingRulesTable;
  email_briefing_rules: EmailBriefingRulesTable;
  _migrations: MigrationsTable;
}

/** ADR 0077 — user-declared email→group routing ("school email → family").
 *  Consulted by the magics group-router BEFORE the LLM matcher. */
export interface EmailRoutingRulesTable {
  id: string;
  user_id: string;
  kind: 'sender_domain' | 'category';
  pattern: string;
  target_group_id: string;
  created_at: string;
}

/** ADR 0161 — per-user "leave this out of my briefing" rules. No target
 *  (unlike EmailRoutingRulesTable): a hit just means digest.service.ts skips
 *  the thread when rendering the briefing's email section. */
export interface EmailBriefingRulesTable {
  id: string;
  user_id: string;
  kind: 'sender_domain' | 'sender_email' | 'category' | 'subject_keyword';
  pattern: string;
  created_at: string;
}

/** Once-ever extraction marks, keyed by gmail_thread_id so they SURVIVE a
 *  mirror wipe (disconnect / provider flip) — a reconnect must not re-stage
 *  proposals the user already saw. Kinds: 'magic' (ADR 0063), 'person'
 *  (ADR 0076). Supersedes the legacy email_threads.*_processed_at columns. */
export interface EmailExtractionMarksTable {
  user_id: string;
  gmail_thread_id: string;
  /** ADR 0180 — `read` marks the interactive, open-a-thread pass; independent
   *  of `magic`, which the background sweep uses. */
  kind: 'magic' | 'person' | 'read';
  created_at: string;
}

/**
 * ADR 0080 — one row per attached mailbox beyond the primary Gmail connection.
 * Credentials are sealed via utils/crypto-tokens (Outlook: {refreshToken};
 * IMAP: hosts + app password). `sync_cursor` is provider-shaped JSON text
 * (Outlook: {deltaLink}; IMAP: {uidValidity,lastUid}).
 */
export interface EmailAccountsTable {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook' | 'imap';
  email_address: string;
  display_name: string | null;
  preset_key: string | null;
  auth_ciphertext: Buffer | null;
  auth_iv: Buffer | null;
  auth_tag: Buffer | null;
  sync_cursor: string | null;
  synced_at: string | null;
  backfill_done: ColumnType<number, number | undefined, number>;
  status: ColumnType<'ok' | 'reconnect', 'ok' | 'reconnect' | undefined, 'ok' | 'reconnect'>;
  /** ADR 0145 — user-chosen name; null falls back to the address local part.
   *  Its own column: `display_name` is provider-owned and rewritten on
   *  re-attach, which would silently erase a nickname. */
  nickname?: string | null;
  /** ADR 0142 — mailbox can receive Chord label push (IMAP: PERMANENTFLAGS). */
  label_push_supported: ColumnType<number, number | undefined, number>;
  /** ADR 0142 — user opted in to push Chord labels into this mailbox. */
  label_push_enabled: ColumnType<number, number | undefined, number>;
  /** ADR 0228 — the Outlook grant covers Calendars.ReadWrite. */
  calendar_enabled: ColumnType<number, number | undefined, number>;
  /** ADR 0228 — this mailbox's default calendar, as a namespaced source id. */
  calendar_default_id: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}

/**
 * ADR 0060 — one row per Gmail thread per user; the classification + tile unit.
 * Booleans are integer 0/1 (ADR 0038). JSON columns store string arrays as text.
 * ADR 0080 — account_id NULL = the primary Gmail mailbox; non-null rows belong
 * to an attached account and store ACCOUNT-PREFIXED provider ids in the
 * gmail_*_id columns ("<accountId>:<nativeId>").
 */
export interface EmailThreadsTable {
  id: string;
  user_id: string;
  account_id: NullableOptional<string>;
  gmail_thread_id: string;
  subject: ColumnType<string, string | undefined, string>;
  snippet: ColumnType<string, string | undefined, string>;
  from_name: string | null;
  from_email: string | null;
  last_message_at: string;
  message_count: ColumnType<number, number | undefined, number>;
  is_unread: ColumnType<number, number | undefined, number>;
  is_archived: ColumnType<number, number | undefined, number>;
  /** jsonb string array of Gmail label ids (read parsed; write JSON.stringify). */
  gmail_label_ids: ColumnType<string[], string | undefined, string>;
  /**
   * ADR 0141 — Chord-owned labels. `recomputeThread` never touches this
   * column (it owns `gmail_label_ids`). Ids are display names; usage-derived.
   */
  chord_label_ids: ColumnType<string[], string | undefined, string>;
  /** Leaf category assigned by the external classifier, if any. */
  category_id: string | null;
  /** What the thread wants from the user, orthogonal to `category_id`
   *  (to_do | reply_needed | informational | other). Null = not classified
   *  yet, which is distinct from an explicit 'other'. */
  action: NullableOptional<EmailAction>;
  /** ADR 0109 — every message in the thread was bulk-sent, as DECLARED by the
   *  sender (List-Unsubscribe / List-Id) or by Gmail's own tab. Owned by
   *  `recomputeThread`. A signal, never a verdict. */
  bulk: ColumnType<number, number | undefined, number>;
  /** ADR 0110 — the model's read of the same question, from the body it can
   *  now see. Owned by ingest, and kept apart from `bulk` because the two
   *  writers run on different schedules: merged, whichever ran last would win.
   *  Effective bulk is the OR of the pair. */
  bulk_inferred: ColumnType<number, number | undefined, number>;
  /** ADR 0129 - out of the inbox until this instant. */
  snoozed_until: NullableOptional<string>;
  /** When it was snoozed, so a message newer than this wakes it. */
  snoozed_at: NullableOptional<string>;
  /** ADR 0110 — which generation of prompt+inputs classified this thread. A
   *  row behind the current version is re-queued, so changing the prompt no
   *  longer needs a migration to re-run the mailbox. */
  classifier_version: ColumnType<number, number | undefined, number>;
  /** ADR 0135 — what a delivery email said: `{etaAt, carrier,
   *  trackingNumber, needsPresence}`. Written once by the magics pass, which
   *  is the only place with the body in hand; tile facts are built at render
   *  time from stored columns and cannot run a model. */
  delivery_json: ColumnType<
    { etaAt?: string | null; carrier?: string | null; trackingNumber?: string | null; needsPresence?: boolean } | null,
    string | null | undefined,
    string | null
  >;
  /** ADR 0138 — what a flight email said. Identity is parsed from the text
   *  (ground truth); the times, route and status are read off the same magics
   *  reply. No URL: it is rebuilt from `ident` + `number` at render. */
  flight_json: ColumnType<
    {
      iata?: string | null;
      number?: string | null;
      ident?: string | null;
      airline?: string | null;
      departAt?: string | null;
      arriveAt?: string | null;
      origin?: string | null;
      destination?: string | null;
      status?: string | null;
    } | null,
    string | null | undefined,
    string | null
  >;
  /** ADR 0160 — what a receipt email said: `{merchant, amount, currency,
   *  purchasedAt, orderNumber}`. Written once by the magics pass, same as
   *  `delivery_json`/`flight_json`; read-don't-propose (nothing to confirm
   *  about a purchase already made) and mined now against Finance's future
   *  arrival, since the extraction mark that gates this pass never re-fires. */
  receipt_json: ColumnType<
    {
      merchant?: string | null;
      amount?: number | null;
      currency?: string | null;
      purchasedAt?: string | null;
      orderNumber?: string | null;
    } | null,
    string | null | undefined,
    string | null
  >;
  /** ADR 0180 — a caution worth showing from the interactive read-time pass
   *  (`{note, severity}`), when nothing was actionable but the message itself
   *  is the concern. Never a proposal; rendered as-is in the reader. */
  read_advisory_json: ColumnType<
    { note: string; severity: 'info' | 'caution' } | null,
    string | null | undefined,
    string | null
  >;
  /** ADR 0346 - what the newest scheduling message on this thread said about
   *  the meeting it arranges (`SchedulingFacts`). Sealed like the facts above.
   *  Read-only; nothing acts on it by itself. */
  scheduling_json: ColumnType<SchedulingFacts | null, string | null | undefined, string | null>;
  /** ADR 0201 — the blind search index, keyed hashes of words and trigrams as a
   *  tsvector. Written by the application (`content-seal.ts`), never generated
   *  from the sealed text. Null on rows the backfill has not reached. */
  blind_words: ColumnType<string | null, string | null | undefined, string | null>;
  blind_grams: ColumnType<string | null, string | null | undefined, string | null>;
  blind_from: ColumnType<string | null, string | null | undefined, string | null>;
  classified_at: string | null;
  /** ADR 0063 — set once the magics pass has processed this thread (dedup). */
  magic_processed_at: NullableOptional<string>;
  /** ADR 0076 — person/family extraction ran for this thread (once ever). */
  person_processed_at: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}

/** ADR 0060 — one row per message; bodies lazy (fetched on thread open). */
/** ADR 0120 — senders whose remote images the reader agreed to load. */
export interface EmailAutoRepliesTable {
  user_id: string;
  sender_email: string;
  sent_at: string;
}

export interface EmailUnsubscribesTable {
  user_id: string;
  sender_email: string;
  /** Which mechanism was used, so a later look can tell a request from a fact. */
  kind: string;
  requested_at: string;
}

export interface EmailImageSendersTable {
  user_id: string;
  /** Lowercased address. */
  sender_email: string;
  created_at: string;
}

/** ADR 0225 — a remote email image fetched ahead of the open. The bytes are a
 *  file under DATA_DIR/email-images/<user>/<url_hash>. */
export interface EmailImageCacheTable {
  user_id: string;
  /** sha256 of the image's absolute address. */
  url_hash: string;
  content_type: string;
  bytes: number;
  fetched_at: string;
}

/** ADR 0118 — one live push registration per watched mailbox. */
export interface MailSubscriptionsTable {
  id: string;
  user_id: string;
  /** NULL = the primary Gmail on the users row (ADR 0080's convention). */
  account_id: string | null;
  /** 'gmail' | 'outlook' | 'imap'. */
  provider: string;
  /** The provider's own handle: a Graph subscription id; null for Gmail,
   *  whose watch is addressed by the mailbox rather than by an id. */
  external_id: string | null;
  /** Secret a notification must carry to be believed. */
  client_state: string;
  expires_at: string;
  /** Set when arming or renewing failed; polling carries the mailbox
   *  meanwhile, so this is a latency regression rather than an outage. */
  failed_at: NullableOptional<string>;
  last_error: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}

/** ADR 0113 — unsent mail, kept by Chord rather than the provider. */
/** docs/notes/0199 — a read-state change still owed to the provider. */
export interface EmailReadWritesTable {
  thread_id: string;
  user_id: string;
  /** 1 = the user wants it unread, 0 = read. */
  desired_unread: number;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailDraftsTable {
  id: string;
  user_id: string;
  /** 'new' | 'reply' | 'forward'. */
  kind: string;
  /** Null for a composed message, which has no thread yet. */
  thread_id: string | null;
  account_id: string | null;
  to_emails: ColumnType<string[], string | undefined, string>;
  cc_emails: ColumnType<string[], string | undefined, string>;
  bcc_emails: ColumnType<string[], string | undefined, string>;
  subject: ColumnType<string, string | undefined, string>;
  body: ColumnType<string, string | undefined, string>;
  attachment_ids: ColumnType<string[], string | undefined, string>;
  /** ADR 0115 — set means outgoing: a draft with a time on it. Clearing it
   *  is what undo, and a failed send, both do. */
  send_after: NullableOptional<string>;
  include_attachments: ColumnType<number, number | undefined, number>;
  /** Why the last attempt did not go, shown on the draft it became again. */
  last_error: NullableOptional<string>;
  /** ADR 0303 — the copy in the mailbox's own Drafts folder. */
  provider_ref: NullableOptional<string>;
  /** 'primary' or an account id: the mailbox `provider_ref` lives in. */
  provider_mailbox: NullableOptional<string>;
  /** The `updated_at` last copied to the provider. */
  provider_synced_at: NullableOptional<string>;
  provider_attempts: ColumnType<number, number | undefined, number>;
  provider_retry_at: NullableOptional<string>;
  provider_error: NullableOptional<string>;
  /** When the copy was last checked for a deletion in another mail app. */
  provider_checked_at: NullableOptional<string>;
  /** Forward only: the message passed on. Null = the thread's newest. */
  forward_message_id: NullableOptional<string>;
  /** ADR 0339 - 'plain' | 'rich'; null = written before the switch. */
  body_format: NullableOptional<string>;
  /** ADR 0339 - rich only: what the editor held. Sealed like `body`. */
  body_html: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}

/** ADR 0303 — a provider draft whose Chord draft is gone (sent or discarded),
 *  kept until the provider has deleted it too. */
export interface EmailProviderDraftRemovalsTable {
  id: string;
  user_id: string;
  provider_mailbox: string;
  provider_ref: string;
  attempts: ColumnType<number, number | undefined, number>;
  retry_at: string;
  created_at: string;
}

export interface EmailMessagesTable {
  id: string;
  user_id: string;
  account_id: NullableOptional<string>;
  thread_id: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: ColumnType<string[], string | undefined, string>;
  cc_emails: ColumnType<string[], string | undefined, string>;
  subject: ColumnType<string, string | undefined, string>;
  snippet: ColumnType<string, string | undefined, string>;
  body_text: string | null;
  body_html: string | null;
  internal_date: string;
  is_unread: ColumnType<number, number | undefined, number>;
  gmail_label_ids: ColumnType<string[], string | undefined, string>;
  rfc822_message_id: string | null;
  /** ADR 0109 — RFC 8058 List-Unsubscribe and RFC 2919 List-Id, as the sender
   *  wrote them. Null = the provider exposed no such header (Outlook), which is
   *  not the same claim as the sender having omitted it. */
  list_unsubscribe: NullableOptional<string>;
  list_unsubscribe_post: NullableOptional<string>;
  list_id: NullableOptional<string>;
  /** ADR 0314 — 1 = an automatic message (Chord's vacation reply, or one
   *  carrying `Auto-Submitted`); never counts as the user replying. */
  auto_reply: ColumnType<number, number | undefined, number>;
  /** ADR 0294 — the Reply-To address, and the receiving server's verdict
   *  (`SenderAuth`, from the topmost Authentication-Results). Plaintext like
   *  `from_email`. Null = absent or not yet seen on a full fetch. */
  reply_to: NullableOptional<string>;
  auth_results: ColumnType<SenderAuth | null, string | null | undefined, string | null>;
  /** jsonb object of relevant headers (References / In-Reply-To) for reply. */
  headers_json: ColumnType<Record<string, string | null>, string | undefined, string>;
  /** ADR 0071 — set once the attachment-import pass has scanned this message. */
  attachments_imported_at: NullableOptional<string>;
  /** ADR 0225 — set once the image-preload pass has been through this message. */
  images_preloaded_at: NullableOptional<string>;
  /** Attachment metadata for the reader (jsonb array; null = undiscovered). */
  attachments_json: ColumnType<
    { id: string; filename: string; mimeType: string; size: number; contentId?: string }[] | null,
    string | null | undefined,
    string | null
  >;
  /** ADR 0110 — the first slice of body text, captured at SYNC so the AI
   *  passes have something to read. `body_text` above stays lazy and belongs
   *  to the reader (ADR 0060); one writer each, so neither can truncate the
   *  other. null = never fetched; a message with no text part stores null too,
   *  which the backfill treats as still owed. */
  body_excerpt: NullableOptional<string>;
  /** Invite .ics captured at sync. null = never parsed; '' = no invite. */
  ics_text: ColumnType<string | null, string | null | undefined, string | null>;
  /** 1 once the part list was re-read for a body's `cid:` images (migration 128). */
  cid_parts_checked: ColumnType<number, number | undefined, number>;
  /** 1 when a part is a downloadable file (not an inline image); null = not known yet (migration 129). */
  has_attachments: ColumnType<number | null, number | null | undefined, number | null>;
  /** ADR 0201 — the blind search index for this message (see EmailThreadsTable). */
  blind_words: ColumnType<string | null, string | null | undefined, string | null>;
  blind_grams: ColumnType<string | null, string | null | undefined, string | null>;
  blind_from: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: string;
}

/**
 * ADR 0061 — the EXTERNAL classifier's category tree (adjacency list). Written
 * by the classifier / ingest route; Chord read paths query it. parent_id NULL
 * marks a root tile.
 */
export interface EmailCategoriesTable {
  id: string;
  user_id: string;
  parent_id: string | null;
  title: string;
  depth: ColumnType<number, number | undefined, number>;
  sort_order: ColumnType<number, number | undefined, number>;
  color: string | null;
  icon: string | null;
  gmail_label_id: string | null;
  updated_at: string;
}

/** ADR 0061 — per-thread category assignment (classifier writes, we read). */
export interface EmailMessageCategoriesTable {
  id: string;
  user_id: string;
  thread_id: string;
  category_id: string;
  assigned_at: string;
  confidence: number | null;
}

/**
 * Device push-notification tokens (Expo push). One row per device; the
 * presence of a row is the per-device enable signal (no separate flag —
 * the Settings toggle registers/unregisters). `token` is Expo's
 * "ExponentPushToken[...]" string and serves as the primary key, so the
 * same physical device re-registering upserts rather than duplicating.
 */
export interface PushTokensTable {
  token: string;
  user_id: string;
  platform: string | null;
  created_at: string;
  last_seen_at: string;
}

/**
 * ADR 0029 — records the external_message_id every connector send
 * returns so we can later edit the message (e.g. update inline-keyboard
 * buttons when a referenced proposal resolves).
 */
export interface OutboundConnectorMessagesTable {
  chord_message_id: string;
  platform: string;
  external_channel_id: string;
  external_message_id: string;
  bot_user_id: string | null;
  created_at: string;
}

export interface TrustedSendersTable {
  id: string;
  recipient_user_id: string;
  sender_user_id: string;
  /** Comma-separated subset of 'task,event'. */
  scopes: string;
  granted_at: string;
}

/**
 * ADR 0064 — pending SMS-OTP verifications for the mock/DB-backed provider.
 * One active row per number (re-starting overwrites). The real Twilio Verify
 * provider keeps its own state at Twilio and never touches this table. On a
 * successful check the row is deleted.
 */
export interface PhoneVerificationsTable {
  /** E.164 being verified. */
  phone: string;
  code: string;
  expires_at: string;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: string;
}

/**
 * ADR 0065 — the durable name→Chord-user map. One row per (owner, resolved
 * contact): the owner's local display name for the person plus the HMAC of
 * their number (never the raw number) and the Chord user it resolved to. Only
 * contacts that matched a verified Chord user are persisted; non-matches are
 * discarded so we never hold a hash of the owner's entire address book.
 */
export interface ContactLinksTable {
  id: string;
  owner_user_id: string;
  /** The owner's address-book display name for this contact. */
  contact_name: string;
  /** HMAC-SHA256 of the contact's E.164 (matches users.phone_hash). */
  phone_hash: string;
  /** Resolved Chord user. */
  chord_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface PermissionRequestsTable {
  id: string;
  recipient_user_id: string;
  sender_user_id: string;
  group_id: string | null;
  scopes: string;
  reason: string | null;
  status: ColumnType<
    'pending' | 'approved' | 'denied',
    'pending' | 'approved' | 'denied' | undefined,
    'pending' | 'approved' | 'denied'
  >;
  requested_at: string;
  resolved_at: string | null;
}

/** ADR 0276 — one search vector per email thread, sealed under the user. */
export interface EmailThreadEmbeddingsTable {
  thread_id: string;
  user_id: string;
  /** Embedding model id (`text-embedding-3-small@512`); only equal ids compare. */
  model: string;
  /** Hash of the embedded text: unchanged text is never embedded twice. */
  content_hash: string;
  vec: Buffer;
  embedded_at: string;
}

/** ADR 0276 — one search vector per file, sealed under the file's owner. */
export interface AttachmentEmbeddingsTable {
  attachment_id: string;
  owner: string;
  model: string;
  content_hash: string;
  vec: Buffer;
  embedded_at: string;
}

/** ADR 0346 phase 3 - one meeting followed across its scheduling thread. */
export interface MeetingsTable {
  id: string;
  user_id: string;
  /** `gmail:<thread id>` of the thread arranging it. */
  thread_key: string;
  state: 'offered' | 'proposed' | 'agreed' | 'invited' | 'answered' | 'cancelled';
  /** Lowercased addresses the meeting is WITH (never the user, never assistants). */
  core_people: ColumnType<string[], string | undefined, string>;
  not_core: ColumnType<string[], string | undefined, string>;
  invite_by: ColumnType<'them' | 'me' | 'unknown', 'them' | 'me' | 'unknown' | undefined, 'them' | 'me' | 'unknown'>;
  /** The agreed slot, ISO with offset. */
  agreed_start: string | null;
  agreed_end: string | null;
  /** The invitation that arrived for it, once one did. */
  invite_uid: string | null;
  /** The calendar event it became, once it did. */
  event_id: string | null;
  /** Sealed `MeetingFacts`: title, offered and agreed slots as quoted, format. */
  facts_json: ColumnType<MeetingFacts | null, string | null | undefined, string | null>;
  /** The newest of the user's own sent messages already read for it. */
  read_through: string | null;
  /** ADR 0346 phase 4 - the user stopped holding the slot. */
  hold_dropped_at: NullableOptional<string>;
  created_at: string;
  updated_at: string;
}
