/**
 * Postgres migration runner. Each entry has a name; applied names live
 * in `_migrations`. Idempotent — `CREATE TABLE IF NOT EXISTS` everywhere,
 * safe to re-run.
 *
 * ADR 0038 — the historical 46 SQLite migrations were squashed into the
 * single `001_pg_init` entry below, capturing the end-state schema
 * reached after the SQLite cutover. The legacy migration list is
 * preserved in `docs/notes/legacy-sqlite-migrations.ts.md` for context.
 * New migrations resume sequential numbering (`002_*`, `003_*`).
 */
import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';

import { logger } from '../config/logging.js';
import { openDb } from './index.js';
import { scopeEmailCategoryIds } from './email-category-ids.js';
import { hashSessionTokens } from './session-token-hash.js';
import { mergeDuplicateLists } from './list-merge.js';
import { repairSeriesOffsets } from './series-offset-repair.js';
import { seedGroupPersonas } from './personas-seed.js';
import { classifyLegacyMemories } from './memories-facts.js';
import { INVISIBLE_PATTERN } from '../utils/email-text.js';

interface Migration {
  name: string;
  up: (db: ReturnType<typeof openDb>) => Promise<void>;
}

const migrations: Migration[] = [
  {
    name: '001_pg_init',
    up: async (db) => {
      // ── core identity ───────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS users (
        id                            text PRIMARY KEY,
        username                      text NOT NULL UNIQUE,
        display_name                  text,
        created_at                    text NOT NULL,
        shadow                        integer NOT NULL DEFAULT 0,
        google_sub                    text,
        email                         text,
        email_verified                integer NOT NULL DEFAULT 0,
        refresh_token_ciphertext      bytea,
        refresh_token_iv              bytea,
        refresh_token_tag             bytea,
        refresh_token_scopes          text,
        google_connected_at           text,
        google_calendar_id            text,
        google_calendar_synced_at     text,
        listening_mode                text NOT NULL DEFAULT 'invocation',
        about_me                      text,
        model_provider                text,
        model_name                    text,
        model_key_ciphertext          bytea,
        model_key_iv                  bytea,
        model_key_tag                 bytea,
        model_base_url                text,
        cross_group_personal_context  integer NOT NULL DEFAULT 0,
        last_tz                       text,
        first_name                    text,
        last_name                     text,
        preferred_name                text,
        nudge_hour                    integer NOT NULL DEFAULT 7,
        nudge_minute                  integer NOT NULL DEFAULT 0,
        nudge_enabled                 integer NOT NULL DEFAULT 1
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
        ON users (google_sub) WHERE google_sub IS NOT NULL`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token         text PRIMARY KEY,
        user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    text NOT NULL,
        last_seen_at  text NOT NULL
      )`.execute(db);

      // ── groups, members, messages ───────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS groups (
        id              text PRIMARY KEY,
        name            text NOT NULL,
        kind            text NOT NULL CHECK (kind IN ('group','personal')),
        invite_code     text NOT NULL UNIQUE,
        ingest_email    text NOT NULL UNIQUE,
        created_by      text NOT NULL REFERENCES users(id),
        created_at      text NOT NULL,
        adults_only     integer NOT NULL DEFAULT 0,
        mirror_inbound  integer NOT NULL DEFAULT 0
      )`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS group_members (
        group_id      text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role          text NOT NULL CHECK (role IN ('owner','member')),
        joined_at     text NOT NULL,
        tier          text NOT NULL DEFAULT 'trusted',
        last_read_at  text,
        PRIMARY KEY (group_id, user_id)
      )`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS messages (
        id                    text PRIMARY KEY,
        group_id              text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_id             text REFERENCES users(id),
        kind                  text NOT NULL CHECK (kind IN ('text','file','system','bot')),
        body                  text NOT NULL,
        attachment_id         text,
        reply_to_id           text,
        mentions_bot          integer NOT NULL DEFAULT 0,
        created_at            text NOT NULL,
        source                text,
        external_message_id   text,
        chord_visible         integer NOT NULL DEFAULT 1,
        mentions_others       integer NOT NULL DEFAULT 0,
        auto_mirror           integer NOT NULL DEFAULT 1,
        bot_persona_id        text,
        is_proactive          integer NOT NULL DEFAULT 0
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_messages_group_created
        ON messages (group_id, created_at)`.execute(db);

      // ── attachments + tsvector FTS index (ADR 0021 + ADR 0038) ──────
      await sql`CREATE TABLE IF NOT EXISTS attachments (
        id              text PRIMARY KEY,
        scope_kind      text NOT NULL CHECK (scope_kind IN ('group','user')),
        scope_id        text NOT NULL,
        uploaded_by     text NOT NULL REFERENCES users(id),
        filename        text NOT NULL,
        mime_type       text NOT NULL,
        size            integer NOT NULL,
        path            text NOT NULL,
        summary         text,
        extracted_text  text,
        pinned          integer NOT NULL DEFAULT 0,
        indexed_at      text,
        created_at      text NOT NULL,
        image_meta      text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_attachments_scope
        ON attachments (scope_kind, scope_id)`.execute(db);

      // attachment_chunks replaces the SQLite FTS5 virtual table. The
      // generated tsvector column lets us GIN-index it and use
      // ts_rank_cd / ts_headline at query time. Porter English matches
      // the SQLite FTS5 tokenizer settings we used to ship with.
      // body_tsv folds filename into the tsvector so a filename-only
      // match (e.g. user types "soccer", attachment is `soccer-roster.pdf`
      // with no other body hit) still surfaces the row. The JS-side
      // filename boost in searchAttachmentChunks then ranks it ahead
      // of pure-body matches. Mirrors the SQLite FTS5 behaviour where
      // both columns were indexed.
      await sql`CREATE TABLE IF NOT EXISTS attachment_chunks (
        attachment_id  text NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        chunk_idx      integer NOT NULL,
        kind           text NOT NULL,
        filename       text NOT NULL,
        content        text NOT NULL,
        body_tsv       tsvector GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(content, '') || ' ' || coalesce(filename, ''))
        ) STORED,
        PRIMARY KEY (attachment_id, chunk_idx, kind)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_attachment_chunks_tsv
        ON attachment_chunks USING GIN (body_tsv)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_attachment_chunks_aid
        ON attachment_chunks (attachment_id)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS attachment_chunk_meta (
        attachment_id  text NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        chunk_idx      integer NOT NULL,
        kind           text NOT NULL,
        char_offset    integer NOT NULL,
        PRIMARY KEY (attachment_id, chunk_idx, kind)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS attachment_chunk_meta_aid
        ON attachment_chunk_meta (attachment_id)`.execute(db);

      // ── lists / saves ───────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS lists (
        id          text PRIMARY KEY,
        group_id    text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name        text NOT NULL,
        created_by  text REFERENCES users(id),
        created_at  text NOT NULL
      )`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS list_items (
        id          text PRIMARY KEY,
        list_id     text NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        text        text NOT NULL,
        checked     integer NOT NULL DEFAULT 0,
        created_at  text NOT NULL
      )`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS saves (
        id                  text PRIMARY KEY,
        group_id            text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        kind                text NOT NULL CHECK (kind IN ('link','place','media','note','contact')),
        title               text NOT NULL,
        url                 text,
        note                text,
        tags                text NOT NULL DEFAULT '[]',
        trip_label          text,
        created_by          text REFERENCES users(id),
        created_at          text NOT NULL,
        source_raw_context  text
      )`.execute(db);

      // ── events + rsvps ──────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS events (
        id                  text PRIMARY KEY,
        group_id            text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        title               text NOT NULL,
        location            text,
        starts_at           text NOT NULL,
        ends_at             text,
        created_by          text REFERENCES users(id),
        created_at          text NOT NULL,
        source_raw_context  text,
        external_uid        text,
        gcal_event_id       text,
        gcal_sync_status    text NOT NULL DEFAULT 'pending',
        gcal_synced_at      text,
        gcal_last_error     text,
        assignee_id         text,
        transparency        text NOT NULL DEFAULT 'opaque'
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_external_uid_per_group
        ON events (group_id, external_uid) WHERE external_uid IS NOT NULL`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS rsvps (
        id            text PRIMARY KEY,
        event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id       text REFERENCES users(id),
        display_name  text NOT NULL,
        status        text NOT NULL CHECK (status IN ('yes','no','maybe','pending')),
        solo          integer NOT NULL DEFAULT 0,
        dish          text,
        notes         text,
        updated_at    text NOT NULL
      )`.execute(db);

      // ── places / contacts / media ──────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS places (
        id          text PRIMARY KEY,
        group_id    text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name        text NOT NULL,
        area        text,
        city        text,
        tags        text NOT NULL DEFAULT '[]',
        note        text,
        created_by  text REFERENCES users(id),
        created_at  text NOT NULL
      )`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS contacts (
        id          text PRIMARY KEY,
        group_id    text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name        text NOT NULL,
        org         text,
        education   text,
        family      text,
        tags        text NOT NULL DEFAULT '[]',
        note        text,
        created_by  text REFERENCES users(id),
        created_at  text NOT NULL
      )`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS media_items (
        id          text PRIMARY KEY,
        group_id    text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        kind        text NOT NULL CHECK (kind IN ('book','podcast','show','movie','article')),
        title       text NOT NULL,
        note        text,
        done        integer NOT NULL DEFAULT 0,
        created_by  text REFERENCES users(id),
        created_at  text NOT NULL
      )`.execute(db);

      // ── memories + document permissions ─────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS memories (
        id              text PRIMARY KEY,
        group_id        text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        persona_id      text REFERENCES users(id) ON DELETE SET NULL,
        scope           text NOT NULL CHECK (scope IN ('persona','group','event')),
        key             text NOT NULL,
        value           text NOT NULL,
        source          text NOT NULL CHECK (source IN ('passive','extracted','explicit')),
        confidence      real NOT NULL DEFAULT 0.5,
        superseded_by   text REFERENCES memories(id) ON DELETE SET NULL,
        created_at      text NOT NULL,
        status          text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed','confirmed'))
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_memories_group_scope
        ON memories (group_id, scope, superseded_by)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_memories_persona
        ON memories (persona_id) WHERE persona_id IS NOT NULL`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS document_permissions (
        id             text PRIMARY KEY,
        attachment_id  text NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        group_id       text REFERENCES groups(id) ON DELETE CASCADE,
        user_id        text REFERENCES users(id) ON DELETE CASCADE,
        granted_by     text REFERENCES users(id),
        granted_at     text NOT NULL,
        CHECK ((group_id IS NULL) <> (user_id IS NULL))
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_docperm_unique
        ON document_permissions (attachment_id, COALESCE(group_id, ''), COALESCE(user_id, ''))`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_docperm_group
        ON document_permissions (group_id) WHERE group_id IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_docperm_user
        ON document_permissions (user_id) WHERE user_id IS NOT NULL`.execute(db);

      // ── tasks + proactive nudges ────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS tasks (
        id                  text PRIMARY KEY,
        group_id            text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        title               text NOT NULL,
        details             text,
        assignee_id         text REFERENCES users(id),
        status              text NOT NULL CHECK (status IN ('open','active','done','superseded','archived')),
        due_at              text,
        remind_at           text,
        remind_cue          text,
        live_until          text,
        archived_at         text,
        created_by          text REFERENCES users(id),
        created_at          text NOT NULL,
        source_raw_context  text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_group_status
        ON tasks (group_id, status)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS proactive_messages (
        id             text PRIMARY KEY,
        group_id       text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        persona_id     text REFERENCES users(id) ON DELETE SET NULL,
        kind           text NOT NULL,
        payload        text NOT NULL,
        scheduled_for  text NOT NULL,
        fired_at       text,
        created_at     text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_proactive_due
        ON proactive_messages (scheduled_for) WHERE fired_at IS NULL`.execute(db);

      // ── trips ───────────────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS trips (
        id                  text PRIMARY KEY,
        group_id            text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name                text NOT NULL,
        destination         text NOT NULL,
        start_date          text NOT NULL,
        end_date            text NOT NULL,
        created_by          text REFERENCES users(id),
        created_at          text NOT NULL,
        source_raw_context  text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_trips_group
        ON trips (group_id, start_date)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS trip_participants (
        trip_id     text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        persona_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (trip_id, persona_id)
      )`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS travel_legs (
        id                  text PRIMARY KEY,
        trip_id             text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        persona_id          text REFERENCES users(id) ON DELETE SET NULL,
        mode                text NOT NULL CHECK (mode IN ('flight','train','car','ferry','other')),
        origin              text NOT NULL,
        destination         text NOT NULL,
        depart_at           text NOT NULL,
        arrive_at           text NOT NULL,
        carrier             text,
        flight_no           text,
        confirmation        text,
        source_doc_id       text REFERENCES attachments(id) ON DELETE SET NULL,
        created_at          text NOT NULL,
        source_raw_context  text,
        passenger_name      text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_legs_trip
        ON travel_legs (trip_id, depart_at)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS accommodations (
        id                  text PRIMARY KEY,
        trip_id             text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        property_name       text NOT NULL,
        address             text,
        checkin_date        text NOT NULL,
        checkout_date       text NOT NULL,
        room_count          integer,
        confirmation        text,
        source_doc_id       text REFERENCES attachments(id) ON DELETE SET NULL,
        created_at          text NOT NULL,
        source_raw_context  text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_accom_trip
        ON accommodations (trip_id, checkin_date)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS trip_reservations (
        id                  text PRIMARY KEY,
        trip_id             text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        kind                text NOT NULL CHECK (kind IN ('restaurant','tour','event','activity','other')),
        name                text NOT NULL,
        date_time           text,
        address             text,
        confirmation        text,
        notes               text,
        created_at          text NOT NULL,
        source_raw_context  text
      )`.execute(db);

      // ── proposals (ADR 0009) ────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS proposals (
        id                      text PRIMARY KEY,
        group_id                text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        proposed_by_user_id     text REFERENCES users(id),
        proposed_by_message_id  text REFERENCES messages(id) ON DELETE SET NULL,
        tool_name               text NOT NULL,
        args_json               text NOT NULL,
        provenance              text,
        status                  text NOT NULL CHECK (status IN ('pending','confirmed','rejected','expired')),
        resolved_by_user_id     text REFERENCES users(id),
        resolved_by_message_id  text REFERENCES messages(id) ON DELETE SET NULL,
        resolved_at             text,
        bundle_id               text,
        expires_at              text NOT NULL,
        created_at              text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_proposals_group_status
        ON proposals (group_id, status)`.execute(db);

      // ── message_cards ───────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS message_cards (
        message_id  text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        cards_json  text NOT NULL,
        created_at  text NOT NULL
      )`.execute(db);

      // ── external identity + connectors ──────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS external_identities (
        platform          text NOT NULL,
        external_id       text NOT NULL,
        external_display  text,
        user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        text NOT NULL,
        PRIMARY KEY (platform, external_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_external_identities_user
        ON external_identities (user_id)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS group_external_channels (
        platform              text NOT NULL,
        external_channel_id   text NOT NULL,
        group_id              text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        config_json           text,
        created_at            text NOT NULL,
        alias                 text NOT NULL DEFAULT 'telegram',
        bot_user_id           text,
        bot_token_ciphertext  bytea,
        bot_token_iv          bytea,
        bot_token_tag         bytea,
        PRIMARY KEY (platform, external_channel_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_group_external_channels_group
        ON group_external_channels (group_id)`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_group_alias_unique
        ON group_external_channels (group_id, alias)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_group_external_channels_bot
        ON group_external_channels (platform, bot_user_id)
        WHERE bot_user_id IS NOT NULL`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS pending_connector_pairings (
        code                  text PRIMARY KEY,
        platform              text NOT NULL,
        group_id              text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        created_by_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at            text NOT NULL,
        expires_at            text NOT NULL,
        alias                 text NOT NULL DEFAULT 'telegram',
        bot_user_id           text,
        bot_username          text,
        bot_token_ciphertext  bytea,
        bot_token_iv          bytea,
        bot_token_tag         bytea
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_pending_pairings_group
        ON pending_connector_pairings (group_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_pending_pairings_expires
        ON pending_connector_pairings (expires_at)`.execute(db);

      // ── people / important_dates ────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS people (
        id             text PRIMARY KEY,
        owner_user_id  text NOT NULL REFERENCES users(id),
        display_name   text NOT NULL,
        notes          text,
        created_at     text NOT NULL,
        updated_at     text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS people_owner_idx
        ON people (owner_user_id)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS important_dates (
        id         text PRIMARY KEY,
        person_id  text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        kind       text NOT NULL,
        date       text NOT NULL,
        recurs     integer NOT NULL DEFAULT 1
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS important_dates_person_idx
        ON important_dates (person_id)`.execute(db);

      // ── catchup folders + assignments ───────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS catchup_folders (
        id          text PRIMARY KEY,
        user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        text NOT NULL,
        display     text NOT NULL,
        kind        text NOT NULL,
        pinned      integer NOT NULL DEFAULT 0,
        created_at  text NOT NULL,
        UNIQUE (user_id, name)
      )`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS catchup_assignments (
        user_id              text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity_type          text NOT NULL,
        entity_id            text NOT NULL,
        folder_id            text NOT NULL REFERENCES catchup_folders(id) ON DELETE CASCADE,
        source               text NOT NULL,
        pending_folder_name  text,
        created_at           text NOT NULL,
        PRIMARY KEY (user_id, entity_type, entity_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS catchup_assignments_folder
        ON catchup_assignments (folder_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS catchup_assignments_pending
        ON catchup_assignments (user_id, pending_folder_name)`.execute(db);

      // ── forms ───────────────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS forms (
        id                    text PRIMARY KEY,
        group_id              text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        title                 text NOT NULL,
        source_attachment_id  text NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        subject_person_id     text REFERENCES people(id) ON DELETE SET NULL,
        schema_json           text NOT NULL,
        answers_json          text NOT NULL DEFAULT '{}',
        status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','filled')),
        filled_attachment_id  text REFERENCES attachments(id) ON DELETE SET NULL,
        created_by            text REFERENCES users(id),
        created_at            text NOT NULL,
        updated_at            text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS forms_group_id
        ON forms (group_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS forms_subject_person_id
        ON forms (subject_person_id)`.execute(db);

      // ── trust + permission requests ─────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS trusted_senders (
        id                 text PRIMARY KEY,
        recipient_user_id  text NOT NULL,
        sender_user_id     text NOT NULL,
        scopes             text NOT NULL,
        granted_at         text NOT NULL,
        UNIQUE (recipient_user_id, sender_user_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_trusted_senders_recipient
        ON trusted_senders (recipient_user_id)`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS permission_requests (
        id                 text PRIMARY KEY,
        recipient_user_id  text NOT NULL,
        sender_user_id     text NOT NULL,
        group_id           text,
        scopes             text NOT NULL,
        reason             text,
        status             text NOT NULL DEFAULT 'pending',
        requested_at       text NOT NULL,
        resolved_at        text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_permission_requests_recipient
        ON permission_requests (recipient_user_id, status)`.execute(db);

      // ── bot personas ────────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS bot_personas (
        id               text PRIMARY KEY,
        display_name     text NOT NULL,
        mention_aliases  text NOT NULL,
        prompt_name      text NOT NULL,
        llm_provider     text,
        model            text,
        enabled_tools    text,
        write_allowed    integer NOT NULL DEFAULT 1,
        created_at       text NOT NULL,
        updated_at       text NOT NULL
      )`.execute(db);

      // ── connector DM state + signup intents (ADR 0031) ──────────────
      await sql`CREATE TABLE IF NOT EXISTS connector_dm_greeted (
        platform          text NOT NULL,
        external_user_id  text NOT NULL,
        greeted_at        text NOT NULL,
        state             text,
        PRIMARY KEY (platform, external_user_id)
      )`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS signup_intents (
        token             text PRIMARY KEY,
        email             text,
        platform          text NOT NULL,
        external_user_id  text NOT NULL,
        created_at        text NOT NULL,
        expires_at        text NOT NULL,
        consumed_at       text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_signup_intents_open
        ON signup_intents (platform, external_user_id) WHERE consumed_at IS NULL`.execute(db);

      // ── outbound connector messages (ADR 0029) ──────────────────────
      await sql`CREATE TABLE IF NOT EXISTS outbound_connector_messages (
        chord_message_id      text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        platform              text NOT NULL,
        external_channel_id   text NOT NULL,
        external_message_id   text NOT NULL,
        bot_user_id           text,
        created_at            text NOT NULL,
        PRIMARY KEY (chord_message_id, platform, external_channel_id)
      )`.execute(db);

      // ── waitlist ────────────────────────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS waitlist (
        id          text PRIMARY KEY,
        email       text NOT NULL UNIQUE,
        name        text,
        note        text,
        created_at  text NOT NULL
      )`.execute(db);

      // ── calendar sources (ADR 0033) ─────────────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS calendar_sources (
        id                        text PRIMARY KEY,
        user_id                   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        google_calendar_id        text NOT NULL,
        summary                   text,
        access_role               text NOT NULL,
        is_primary                integer NOT NULL DEFAULT 0,
        selected_in_google        integer NOT NULL DEFAULT 1,
        counts_for_busy_auto      integer,
        counts_for_busy_override  integer,
        first_seen_at             text NOT NULL,
        last_seen_at              text NOT NULL,
        UNIQUE (user_id, google_calendar_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_calendar_sources_user
        ON calendar_sources (user_id)`.execute(db);
    },
  },
  {
    // List item operations hit two hot patterns: (a) join via list_id and
    // group_id for /me/lists, and (b) the cross-list checkbox fan-out in
    // setItemChecked, which previously scanned every list_item row in a
    // group. The functional index lets that fan-out filter by
    // normalized text directly in SQL — the expression mirrors
    // `normalizeText()` in kernel/src/lists-bucketing.ts.
    name: '002_list_items_indexes',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_lists_group_id
        ON lists (group_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_list_items_list_id
        ON list_items (list_id)`.execute(db);
      // `[[:space:]]+` instead of `\s+` because a JS string literal
      // collapses `\s` to plain `s` (no escape for it), and we'd
      // silently strip every "s" character. POSIX character classes
      // pass through unmolested and cover the same whitespace set.
      await sql`CREATE INDEX IF NOT EXISTS idx_list_items_norm_text
        ON list_items (LOWER(TRIM(REGEXP_REPLACE(text, '[[:space:]]+', ' ', 'g'))))`.execute(db);
    },
  },
  {
    // group_members PK is (group_id, user_id), so user_id alone is not
    // indexed. Every /me/* endpoint (tasks, lists, saves, files,
    // events, trips) joins group_members and filters by user_id — the
    // catchup screen fires several of those on tab open. An index on
    // user_id turns the seq scan into an index seek.
    name: '003_group_members_user_idx',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_group_members_user_id
        ON group_members (user_id)`.execute(db);
    },
  },
  {
    // Auto-archive of done tasks previously keyed off `due_at` — so a task
    // with an old due date got re-archived seconds after the user toggled
    // it done, oscillating done↔archived forever. Track the actual
    // completion moment instead; backfill existing done rows to now() so
    // they get a fresh 7-day window rather than disappearing on the next
    // scheduler tick.
    name: '004_tasks_completed_at',
    up: async (db) => {
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at text`.execute(db);
      await sql`UPDATE tasks SET completed_at = to_char(now() AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                WHERE status = 'done' AND completed_at IS NULL`.execute(db);
    },
  },
  {
    // ADR 0040 — user-owned, two-way calendar model. EXPAND phase only: add
    // the new columns + event_attendees table and backfill from current data.
    // Nothing is dropped — `group_id`, `external_uid`, and `rsvps` stay live so
    // the existing one-way code keeps working while the 0040 code is built on
    // top. The CONTRACT phase (drop old columns, add the UNIQUE
    // (owner_user_id, ical_uid) / (google_calendar_id, gcal_event_id)
    // constraints, set NOT NULLs) lands in a later migration once services are
    // cut over and per-user-copy dedup has run.
    name: '005_calendar_two_way_sync',
    up: async (db) => {
      // ── events: identity + versioning ───────────────────────────────
      // chord_uid: our origin stamp (→ Google extendedProperties.private.chordUid),
      // the loop-prevention signal that replaces the `gcal:` prefix sniff. Only
      // events WE created (no external_uid) get one; gcal/ICS-sourced rows stay null.
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS chord_uid text`.execute(db);
      // ical_uid: RFC5545 UID, shared across every copy of a logical event.
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS ical_uid text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS etag text`.execute(db);
      // Which Google calendar this copy lives on (selectable; not hardcoded
      // "Family"). The existing `gcal_event_id` identifies the event *within* it.
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS google_calendar_id text`.execute(db);

      // ── events: ownership + scope ───────────────────────────────────
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES users(id)`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_user_id text REFERENCES users(id)`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'organizer'
                  CHECK (role IN ('organizer','attendee'))`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS group_ids jsonb NOT NULL DEFAULT '[]'`.execute(db);

      // ── events: richer content (mirrors the Google event resource) ───
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS description text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS start_tz text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS end_tz text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS all_day integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed','tentative','cancelled'))`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS response_status text
                  CHECK (response_status IN ('needsAction','accepted','declined','tentative'))`.execute(db);

      // ── events: recurrence (reserved; ADR 0040 decision 3 defers it) ─
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence jsonb`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring_event_id text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS original_start text`.execute(db);

      // ── events: two-way sync state ──────────────────────────────────
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS local_dirty integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at text`.execute(db);

      // Indexes (NOT unique yet — expand phase may still hold pre-dedup
      // duplicates, e.g. the same .ics imported into two groups. The UNIQUE
      // constraints arrive in the contract migration after dedup).
      await sql`CREATE INDEX IF NOT EXISTS idx_events_owner
                  ON events (owner_user_id) WHERE owner_user_id IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_events_ical_uid ON events (ical_uid)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_events_chord_uid
                  ON events (chord_uid) WHERE chord_uid IS NOT NULL`.execute(db);
      // GIN for `group_ids ? '<groupId>'` containment lookups (group reads).
      await sql`CREATE INDEX IF NOT EXISTS idx_events_group_ids ON events USING gin (group_ids)`.execute(db);

      // ── event_attendees (rsvps successor) ───────────────────────────
      await sql`CREATE TABLE IF NOT EXISTS event_attendees (
        id               text PRIMARY KEY,
        ical_uid         text NOT NULL,
        user_id          text REFERENCES users(id),
        email            text,
        display_name     text NOT NULL,
        role             text NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer','editor')),
        response_status  text NOT NULL DEFAULT 'needsAction'
                           CHECK (response_status IN ('needsAction','accepted','declined','tentative')),
        is_organizer     integer NOT NULL DEFAULT 0,
        solo             integer NOT NULL DEFAULT 0,
        dish             text,
        notes            text,
        updated_at       text NOT NULL,
        UNIQUE (ical_uid, email)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_attendees_ical_uid
                  ON event_attendees (ical_uid)`.execute(db);

      // ── target-calendar selection (replaces hardcoded "Family") ─────
      await sql`ALTER TABLE groups ADD COLUMN IF NOT EXISTS default_calendar_id text`.execute(db);
      await sql`ALTER TABLE users  ADD COLUMN IF NOT EXISTS default_calendar_id text`.execute(db);
      await sql`ALTER TABLE users  ADD COLUMN IF NOT EXISTS default_invite_calendar_id text`.execute(db);
      await sql`ALTER TABLE calendar_sources ADD COLUMN IF NOT EXISTS is_default_write integer NOT NULL DEFAULT 0`.execute(db);
      // Per-calendar incremental-sync cursor for the two-way pull (ADR 0040).
      await sql`ALTER TABLE calendar_sources ADD COLUMN IF NOT EXISTS sync_token text`.execute(db);

      // Backfill last, once every column + the event_attendees table exist.
      await backfillCalendarTwoWaySync(db);
    },
  },
  {
    // ADR 0040 §7–8 — fan out existing group events into per-member copies so
    // the owner-scoped read switch doesn't hide them from non-owners. Idempotent
    // (deterministic copy ids + NOT EXISTS guard).
    name: '006_calendar_fanout_backfill',
    up: async (db) => {
      await backfillCalendarFanout(db);
    },
  },
  {
    // ADR 0040 contract phase (safe subset). Hardens calendar identity without
    // the risky parts: a partial UNIQUE on the Google link (a given event on a
    // given calendar is unique — also kills the create→push→pull duplicate
    // class), preceded by an idempotent re-backfill + dedup. Deferred to a later
    // phase: ical_uid NOT NULL, UNIQUE(owner_user_id, ical_uid) (needs the pull
    // to upsert — a user can hold the same iCalUID on two of their calendars),
    // and dropping group_id/external_uid/rsvps (still actively read).
    name: '007_calendar_identity_constraints',
    up: async (db) => {
      await hardenCalendarIdentity(db);
    },
  },
  {
    // Native iOS uses a separate public Google OAuth client; refresh tokens are
    // bound to their issuing client, so record which one issued each token to
    // refresh it correctly. Null = legacy/web (the only client before this).
    name: '008_user_oauth_client',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token_client_id text`.execute(db);
    },
  },
  {
    // Throttle for the proactive "your Google Calendar disconnected" nudge:
    // set when we warn the user, cleared on reconnect (so one warning per
    // disconnect, not every morning). Null = not currently warned.
    name: '009_calendar_reconnect_nudge',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_reconnect_nudged_at text`.execute(db);
    },
  },
  {
    // Distinguish "extraction was requested but never finished" (interrupted
    // upload → safe to retry on boot) from "indexing was deliberately skipped"
    // (bulk WhatsApp media, .ics, filled-form PDFs — `saveFile({ index: false })`).
    // Both leave `indexed_at` NULL, so without this flag the boot recovery sweep
    // would re-extract every deliberately-skipped file. New uploads set the flag
    // from `input.index`; existing NULL-indexed rows are treated as skipped so an
    // upgrade boot doesn't fan out re-extraction across the whole back catalogue.
    name: '010_attachments_index_requested',
    up: async (db) => {
      await sql`ALTER TABLE attachments
        ADD COLUMN IF NOT EXISTS index_requested integer NOT NULL DEFAULT 1`.execute(db);
      await sql`UPDATE attachments SET index_requested = 0 WHERE indexed_at IS NULL`.execute(db);
    },
  },
  {
    // ADR 0021 Tier-2 — LLM-generated "questions this document answers",
    // indexed as a high-weight chunk so a user's question phrasing matches
    // the doc even when its prose uses different words ("shots" vs "vaccine").
    name: '011_attachments_answerable_questions',
    up: async (db) => {
      await sql`ALTER TABLE attachments
        ADD COLUMN IF NOT EXISTS answerable_questions text`.execute(db);
    },
  },
  {
    // Device push-notification tokens (Expo push). ON DELETE CASCADE lets
    // account deletion (ADR 0043) auto-clean a user's devices.
    name: '012_push_tokens',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS push_tokens (
        token         text PRIMARY KEY,
        user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform      text,
        created_at    text NOT NULL,
        last_seen_at  text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_push_tokens_user
        ON push_tokens (user_id)`.execute(db);
    },
  },
  {
    // ADR 0054 — push preferences: per-category toggles + quiet-hours window
    // on users, and a per-(user,group) mute flag on group_members. Booleans
    // are integer 0/1 per ADR 0038 type mapping.
    name: '013_notification_prefs',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS notify_messages   integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS notify_bot        integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS notify_briefing   integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS quiet_enabled     integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS quiet_start_hour  integer NOT NULL DEFAULT 22,
        ADD COLUMN IF NOT EXISTS quiet_start_minute integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS quiet_end_hour    integer NOT NULL DEFAULT 7,
        ADD COLUMN IF NOT EXISTS quiet_end_minute  integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE group_members
        ADD COLUMN IF NOT EXISTS muted integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // Perf: the hot message reads (listMessages, the group-list unread/last
    // subqueries) all filter `chord_visible = 1`, but the only index was
    // (group_id, created_at) — so Postgres index-scanned then heap-filtered
    // the invisible bot rows. A partial index matching the dominant predicate
    // lets those reads skip the invisible rows entirely. (2026-06-19 perf audit.)
    name: '014_messages_visible_index',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_messages_group_visible_created
        ON messages (group_id, created_at)
        WHERE chord_visible = 1`.execute(db);
    },
  },
  {
    // ADR 0057 — device calendar as a first-class source. calendar_sources is
    // now multi-provider: a 'device' row stores the device calendar id in the
    // existing google_calendar_id column (treated as a generic source id). The
    // ADR-0033 busy policy is provider-agnostic, so nothing else changes.
    name: '015_calendar_sources_provider',
    up: async (db) => {
      await sql`ALTER TABLE calendar_sources
        ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google'`.execute(db);
    },
  },
  {
    // ADR 0060/0061 — in-app Gmail reader. A per-user local mirror of Gmail
    // (threads + messages) plus the landing tables for the EXTERNAL classifier's
    // category tree + per-thread assignments. Bodies are lazy (fetched on thread
    // open). Booleans are integer 0/1 (ADR 0038).
    name: '016_gmail_reader',
    up: async (db) => {
      // Sync cursor + scope state on the user row (mirrors google_calendar_*).
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS gmail_history_id text,
        ADD COLUMN IF NOT EXISTS gmail_synced_at text,
        ADD COLUMN IF NOT EXISTS gmail_backfill_done integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gmail_reconnect_nudged_at text`.execute(db);

      // One row per Gmail thread per user. The thread is the classification +
      // tile unit, so a tile count = COUNT(threads) per category.
      await sql`CREATE TABLE IF NOT EXISTS email_threads (
        id               text PRIMARY KEY,
        user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gmail_thread_id  text NOT NULL,
        subject          text NOT NULL DEFAULT '',
        snippet          text NOT NULL DEFAULT '',
        from_name        text,
        from_email       text,
        last_message_at  text NOT NULL,
        message_count    integer NOT NULL DEFAULT 1,
        is_unread        integer NOT NULL DEFAULT 0,
        is_archived      integer NOT NULL DEFAULT 0,
        gmail_label_ids  jsonb NOT NULL DEFAULT '[]',
        category_id      text,
        classified_at    text,
        created_at       text NOT NULL,
        updated_at       text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_email_threads_user_gmail
        ON email_threads (user_id, gmail_thread_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_user_recent
        ON email_threads (user_id, last_message_at DESC)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_user_category
        ON email_threads (user_id, category_id)`.execute(db);

      // One row per message. Bodies nullable/lazy: metadata sync stores the
      // snippet; full body fetched on thread open and cached back.
      await sql`CREATE TABLE IF NOT EXISTS email_messages (
        id                 text PRIMARY KEY,
        user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id          text NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
        gmail_message_id   text NOT NULL,
        gmail_thread_id    text NOT NULL,
        from_name          text,
        from_email         text,
        to_emails          jsonb NOT NULL DEFAULT '[]',
        cc_emails          jsonb NOT NULL DEFAULT '[]',
        subject            text NOT NULL DEFAULT '',
        snippet            text NOT NULL DEFAULT '',
        body_text          text,
        body_html          text,
        internal_date      text NOT NULL,
        is_unread          integer NOT NULL DEFAULT 0,
        gmail_label_ids    jsonb NOT NULL DEFAULT '[]',
        rfc822_message_id  text,
        headers_json       jsonb NOT NULL DEFAULT '{}',
        created_at         text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_email_messages_user_gmail
        ON email_messages (user_id, gmail_message_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_thread
        ON email_messages (thread_id, internal_date)`.execute(db);

      // Classifier OUTPUT (ADR 0061). The external engine writes these; we read.
      // Adjacency-list tree — parent_id NULL = root tile.
      await sql`CREATE TABLE IF NOT EXISTS email_categories (
        id              text PRIMARY KEY,
        user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id       text REFERENCES email_categories(id) ON DELETE CASCADE,
        title           text NOT NULL,
        depth           integer NOT NULL DEFAULT 0,
        sort_order      integer NOT NULL DEFAULT 0,
        color           text,
        icon            text,
        gmail_label_id  text,
        updated_at      text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_categories_user_parent
        ON email_categories (user_id, parent_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_categories_user
        ON email_categories (user_id)`.execute(db);

      // Per-thread assignment (classifier writes, we read). One leaf per thread.
      await sql`CREATE TABLE IF NOT EXISTS email_message_categories (
        id           text PRIMARY KEY,
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id    text NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
        category_id  text NOT NULL REFERENCES email_categories(id) ON DELETE CASCADE,
        assigned_at  text NOT NULL,
        confidence   real
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_email_msg_cat_user_thread
        ON email_message_categories (user_id, thread_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_msg_cat_category
        ON email_message_categories (category_id)`.execute(db);
    },
  },
  {
    // ADR 0063 — email magics dedup marker. Set once the magics pass has
    // extracted (or declined to extract) a suggestion from a thread, so a later
    // sync never re-runs the LLM over the same thread. Null = not yet processed.
    name: '017_email_magic_processed',
    up: async (db) => {
      await sql`ALTER TABLE email_threads
        ADD COLUMN IF NOT EXISTS magic_processed_at text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_magic_pending
        ON email_threads (user_id) WHERE magic_processed_at IS NULL`.execute(db);
    },
  },
  {
    // ADR 0063 — group-routed proposals. An email magic stages its create_event
    // / add_list_item suggestion privately in the owner's personal group, with
    // target_group_id pointing at the Chord group the mail is FOR. Only the
    // owner's confirm creates the entity in that group (→ fan-out, ADR 0040);
    // the raw email is never shared. NULL = execute in the proposal's own group.
    name: '018_proposals_target_group',
    up: async (db) => {
      await sql`ALTER TABLE proposals
        ADD COLUMN IF NOT EXISTS target_group_id text REFERENCES groups(id) ON DELETE SET NULL`.execute(db);
    },
  },
  {
    // ADR 0057 — display color (hex) per calendar source, so settings can show
    // a swatch and tell same-named Google vs device calendars apart at a glance.
    name: '019_calendar_sources_color',
    up: async (db) => {
      await sql`ALTER TABLE calendar_sources
        ADD COLUMN IF NOT EXISTS color text`.execute(db);
    },
  },
  {
    // ADR 0062 — global search FTS. Per-table STORED GENERATED tsvector + GIN
    // over each entity's human-text columns, mirroring the attachment_chunks
    // pattern (migration 001). Postgres maintains these on every write, so
    // there's no sync code and zero drift. Query path UNION-ALLs them.
    name: '020_search_tsvectors',
    up: async (db) => {
      await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_messages_search_tsv
        ON messages USING GIN (search_tsv)`.execute(db);

      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(title, '') || ' ' || coalesce(details, ''))
        ) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_search_tsv
        ON tasks USING GIN (search_tsv)`.execute(db);

      await sql`ALTER TABLE lists ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, ''))) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_lists_search_tsv
        ON lists USING GIN (search_tsv)`.execute(db);

      await sql`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_list_items_search_tsv
        ON list_items USING GIN (search_tsv)`.execute(db);

      await sql`ALTER TABLE saves ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(title, '') || ' ' || coalesce(note, ''))
        ) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_saves_search_tsv
        ON saves USING GIN (search_tsv)`.execute(db);
    },
  },
  {
    // ADR 0063 — prepaid credits for premium-model turns. Fast balance on the
    // user row + an append-only ledger (unique `ref` for idempotency).
    name: '021_credit_ledger',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS credit_balance integer NOT NULL DEFAULT 0`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS credit_ledger (
        id             text PRIMARY KEY,
        user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta          integer NOT NULL,
        reason         text NOT NULL CHECK (reason IN ('purchase','turn_debit','grant','refund')),
        ref            text NOT NULL,
        balance_after  integer NOT NULL,
        created_at     text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_ref
        ON credit_ledger (ref)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_credit_ledger_user
        ON credit_ledger (user_id, created_at)`.execute(db);
    },
  },
  {
    // ADR 0064 — verified phone number as an identity attribute. Google remains
    // the login/calendar anchor; the phone is the deterministic key contact
    // resolution (ADR 0065) matches on. `phone_number` is E.164 and unique
    // (partial: only when set). `phone_hash` is the HMAC we match uploaded
    // client-hashed contacts against — denormalized + indexed so resolution is
    // a hash-set lookup, not a per-row re-hash. `phone_verifications` backs the
    // mock/DB OTP provider (the real Twilio Verify keeps its state at Twilio).
    name: '022_user_phone',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS phone_number text,
        ADD COLUMN IF NOT EXISTS phone_hash text,
        ADD COLUMN IF NOT EXISTS phone_verified integer NOT NULL DEFAULT 0`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_number
        ON users (phone_number) WHERE phone_number IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_users_phone_hash
        ON users (phone_hash) WHERE phone_hash IS NOT NULL`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS phone_verifications (
        phone       text PRIMARY KEY,
        code        text NOT NULL,
        expires_at  text NOT NULL,
        attempts    integer NOT NULL DEFAULT 0,
        created_at  text NOT NULL
      )`.execute(db);
    },
  },
  {
    // ADR 0065 — deterministic contact resolution. The durable name→user map:
    // one row per (owner, resolved contact). We store only the HMAC of the
    // contact's number (never the raw number) plus the owner's local name and
    // the resolved Chord user. Unique on (owner, phone_hash) so re-uploading an
    // address book upserts. ON DELETE CASCADE on both user fks so account
    // deletion (ADR 0043) sweeps a user's links whether they own or are named.
    name: '023_contact_links',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS contact_links (
        id             text PRIMARY KEY,
        owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        contact_name   text NOT NULL,
        phone_hash     text NOT NULL,
        chord_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at     text NOT NULL,
        updated_at     text NOT NULL,
        UNIQUE (owner_user_id, phone_hash)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_contact_links_owner
        ON contact_links (owner_user_id)`.execute(db);
      // Name lookup for resolveContactToUser — case-insensitive match, scoped
      // to the owner. Mirrors the LOWER(TRIM(...)) list-item index (migration 002).
      await sql`CREATE INDEX IF NOT EXISTS idx_contact_links_owner_name
        ON contact_links (owner_user_id, LOWER(TRIM(contact_name)))`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_contact_links_chord_user
        ON contact_links (chord_user_id)`.execute(db);
    },
  },
  {
    // Email reader prefs: digest opt-out + auto category→Gmail label sync.
    // Renumbered from 019_email_prefs at merge time — main had already taken
    // 019–023. The runner keys on the name and the DDL is IF NOT EXISTS, so a
    // DB that applied it under the old name re-applies this one harmlessly.
    name: '024_email_prefs',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email_digest_enabled integer NOT NULL DEFAULT 1`.execute(db);
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS gmail_sync_labels_enabled integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // ADR 0067 — flagship cross-user messaging. A "pair group" is an ordinary
    // 2-member shared group (kind='group') identified by pair_key = the two
    // user ids sorted + joined, so ensurePairGroup is a clean find-or-create and
    // a real 2-person group can't be mistaken for one. `blocks` backs the
    // sender-initiated / recipient-opt-out consent model.
    name: '025_pair_groups_and_blocks',
    up: async (db) => {
      await sql`ALTER TABLE groups ADD COLUMN IF NOT EXISTS pair_key text`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_pair_key
        ON groups (pair_key) WHERE pair_key IS NOT NULL`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS blocks (
        blocker_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       text NOT NULL,
        PRIMARY KEY (blocker_user_id, blocked_user_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_blocks_blocked
        ON blocks (blocked_user_id)`.execute(db);
    },
  },
  {
    // Plain-text signature appended to outbound email replies (Settings).
    name: '026_email_signature',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email_signature text`.execute(db);
    },
  },
  {
    // ADR 0071 — email→knowledge-base attachment import marker (once per message).
    name: '027_email_attachment_import',
    up: async (db) => {
      await sql`ALTER TABLE email_messages
        ADD COLUMN IF NOT EXISTS attachments_imported_at text`.execute(db);
    },
  },
  {
    // Mirror-provider marker: a GMAIL_PROVIDER flip (mock ↔ real) wipes the
    // local mirror before syncing so fixture threads never leak into a real
    // account's reader.
    name: '028_gmail_mirror_provider',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS gmail_mirror_provider text`.execute(db);
    },
  },
  {
    // ADR 0076 — email-derived people/family facts: once-ever extraction
    // marker per thread (mirrors 017's magics marker) + the sender→person
    // anchor so repeated senders accumulate knowledge instead of being
    // re-proposed.
    name: '029_email_persons',
    up: async (db) => {
      await sql`ALTER TABLE email_threads
        ADD COLUMN IF NOT EXISTS person_processed_at text`.execute(db);
      await sql`ALTER TABLE people
        ADD COLUMN IF NOT EXISTS email text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_people_owner_email
        ON people (owner_user_id, LOWER(email))`.execute(db);
    },
  },
  {
    // Durable extraction marks: the per-thread processed markers lived on
    // email_threads, which disconnectGmail (and the 028 provider-flip wipe)
    // deletes — so a reconnect re-mined every thread and re-staged proposals
    // the user had already seen/dismissed. Keyed by gmail_thread_id in a
    // user-FK'd side table, the marks survive any mirror wipe. Backfills
    // from the legacy columns; those columns stop being written.
    name: '030_email_extraction_marks',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_extraction_marks (
        user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gmail_thread_id  text NOT NULL,
        kind             text NOT NULL CHECK (kind IN ('magic', 'person')),
        created_at       text NOT NULL,
        PRIMARY KEY (user_id, gmail_thread_id, kind)
      )`.execute(db);
      await sql`INSERT INTO email_extraction_marks (user_id, gmail_thread_id, kind, created_at)
        SELECT user_id, gmail_thread_id, 'magic', magic_processed_at
        FROM email_threads WHERE magic_processed_at IS NOT NULL
        ON CONFLICT DO NOTHING`.execute(db);
      await sql`INSERT INTO email_extraction_marks (user_id, gmail_thread_id, kind, created_at)
        SELECT user_id, gmail_thread_id, 'person', person_processed_at
        FROM email_threads WHERE person_processed_at IS NOT NULL
        ON CONFLICT DO NOTHING`.execute(db);
    },
  },
  {
    // ADR 0077 — user-declared email routing: "school email → family group".
    // Deterministic rules the magics group-router consults BEFORE the LLM
    // matcher. kind 'sender_domain' matches the sender's domain suffix;
    // 'category' matches the classifier category title (substring,
    // case-insensitive). Group membership is enforced at write AND at match.
    name: '031_email_routing_rules',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_routing_rules (
        id               text PRIMARY KEY,
        user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind             text NOT NULL CHECK (kind IN ('sender_domain', 'category')),
        pattern          text NOT NULL,
        target_group_id  text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        created_at       text NOT NULL,
        UNIQUE (user_id, kind, pattern)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_routing_rules_user
        ON email_routing_rules (user_id)`.execute(db);
    },
  },
  {
    // ADR 0080 — additional mailboxes (Outlook / Microsoft 365 via Graph,
    // Yahoo/AOL/iCloud/custom via IMAP). The primary Gmail mailbox stays on
    // `users` (threads keep account_id NULL); each attached account carries
    // its own sealed credentials + sync cursor. Provider-native thread and
    // message ids are stored ACCOUNT-PREFIXED ("<accountId>:<nativeId>") in
    // the existing gmail_*_id columns, so downstream consumers (classifier,
    // magics provenance, extraction marks) stay unchanged.
    name: '032_email_accounts',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_accounts (
        id               text PRIMARY KEY,
        user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider         text NOT NULL CHECK (provider IN ('outlook', 'imap')),
        email_address    text NOT NULL,
        display_name     text,
        preset_key       text,
        auth_ciphertext  bytea,
        auth_iv          bytea,
        auth_tag         bytea,
        sync_cursor      text,
        synced_at        text,
        backfill_done    integer NOT NULL DEFAULT 0,
        status           text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reconnect')),
        created_at       text NOT NULL,
        updated_at       text NOT NULL,
        UNIQUE (user_id, provider, email_address)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_accounts_user
        ON email_accounts (user_id)`.execute(db);
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS
        account_id text REFERENCES email_accounts(id) ON DELETE CASCADE`.execute(db);
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS
        account_id text REFERENCES email_accounts(id) ON DELETE CASCADE`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_account
        ON email_threads (account_id) WHERE account_id IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_account
        ON email_messages (account_id) WHERE account_id IS NOT NULL`.execute(db);
    },
  },
  {
    // An attachment row can outlive its blob (pre-DATA_DIR uploads lost in a
    // storage move). The download route stamps this on ENOENT so search stops
    // surfacing files that can't open; the row stays visible in the
    // Attachments tab so the user knows what to re-upload.
    name: '033_attachment_blob_missing',
    up: async (db) => {
      await sql`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS
        blob_missing_at text`.execute(db);
    },
  },
  {
    // ADR 0080 addendum — secondary Gmail mailboxes ride the same
    // email_accounts abstraction (provider 'gmail'). The primary Gmail stays
    // on `users` (login + calendar anchor); each additional Gmail carries its
    // own sealed refresh token + historyId cursor like any other account.
    name: '034_gmail_email_accounts',
    up: async (db) => {
      await sql`ALTER TABLE email_accounts
        DROP CONSTRAINT IF EXISTS email_accounts_provider_check`.execute(db);
      await sql`ALTER TABLE email_accounts
        ADD CONSTRAINT email_accounts_provider_check
        CHECK (provider IN ('gmail', 'outlook', 'imap'))`.execute(db);
    },
  },
  {
    // Attachment metadata per mirrored message (name/type/size + a
    // provider-shaped part id) so the reader can SHOW receipts/statements
    // instead of a bare body. NULL = not yet discovered (populated at thread
    // open for Gmail/Outlook, at sync for IMAP); '[]' = known to have none.
    // Bytes are never stored — the download route streams from the provider.
    name: '035_email_message_attachments',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS
        attachments_json jsonb`.execute(db);
    },
  },
  {
    // A knowledge-base file imported from email (ADR 0071) keeps a link back
    // to its source thread so the Attachments tab can open the original
    // email. SET NULL: the file outlives a disconnected/wiped mailbox.
    name: '036_attachment_email_origin',
    up: async (db) => {
      await sql`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS
        origin_email_thread_id text REFERENCES email_threads(id) ON DELETE SET NULL`.execute(db);
    },
  },
  {
    // The action axis: what a thread wants from you, orthogonal to which
    // category it sits in. Nullable - an unclassified thread has no action
    // yet, which is distinct from 'other'.
    name: '037_email_thread_action',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS action text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS email_threads_user_action_idx
        ON email_threads (user_id, action)`.execute(db);
    },
  },
  {
    // Email joins global search, using ADR 0062's pattern: a generated tsvector
    // + GIN, maintained by Postgres so there is no sync code to drift. Threads
    // only - message bodies are lazy and often absent locally, and the
    // subject/snippet/sender is what a person searches by anyway.
    name: '038_email_thread_search_tsv',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (
          to_tsvector('english',
            coalesce(subject, '') || ' ' ||
            coalesce(snippet, '') || ' ' ||
            coalesce(from_name, '') || ' ' ||
            coalesce(from_email, ''))
        ) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_search_tsv
        ON email_threads USING GIN (search_tsv)`.execute(db);
    },
  },
  {
    // ADR 0089 — WhatsApp only delivers free-form text inside a 24h window that
    // the USER opens. The briefing is proactive, so it lands outside that window
    // for anyone who didn't write yesterday. These four columns are the state a
    // per-binding gate needs: when the window last opened, whether the user
    // muted this channel, whether we already asked, and which briefing is parked
    // waiting on their answer.
    name: '039_whatsapp_session_window',
    up: async (db) => {
      await sql`ALTER TABLE group_external_channels
        ADD COLUMN IF NOT EXISTS last_inbound_at text`.execute(db);
      await sql`ALTER TABLE group_external_channels
        ADD COLUMN IF NOT EXISTS briefing_opted_out integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE group_external_channels
        ADD COLUMN IF NOT EXISTS nudge_prompt_sent_at text`.execute(db);
      await sql`ALTER TABLE group_external_channels
        ADD COLUMN IF NOT EXISTS pending_briefing_message_id text`.execute(db);
    },
  },
  {
    // The invite .ics part, captured at sync. IMAP already parses the full
    // message source to mirror it, so re-fetching one part later cost a whole
    // extra login per probed thread — and login rate is what Yahoo throttles.
    // Same convention as attachments_json: NULL = never parsed (rows predating
    // this column); '' = parsed, carries no invite; text = the VCALENDAR.
    name: '040_email_message_ics',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS
        ics_text text`.execute(db);
    },
  },
  {
    // ADR 0091 — where to ask for the briefing's weather line. Derived from
    // the request IP (resolved against a local GeoLite2 file, never stored)
    // or the timezone, and overridable in Settings. `weather_place_source`
    // is what keeps an explicit choice from being clobbered by the automatic
    // tiers on the user's next request.
    name: '041_user_weather_location',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_lat double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_lon double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_place text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_place_source text`.execute(db);
    },
  },
  {
    // ADR 0094 — list names now resolve semantically on BOTH sides, so the
    // forks the old case-sensitive `=` minted ("Restaurants", "restaurants",
    // "Restaurant list") are three views of one list. Fold each group's
    // same-key lists into the oldest, moving over only the items the keeper
    // does not already have; the emptied duplicates go, and their remaining
    // rows cascade. Idempotent: a second run finds one list per key.
    name: '042_merge_duplicate_lists',
    up: mergeDuplicateLists,
  },
  {
    // 042 folded under a stemmer that stripped `es` wholesale, so "Notes"
    // keyed as "not" while "Note" keyed as "note" and the pair it was meant
    // to merge survived it. Same function, corrected key (ADR 0094) — a
    // no-op wherever 042 already left one list per key.
    name: '043_merge_duplicate_lists_refold',
    up: mergeDuplicateLists,
  },
  {
    // Bug 12 — the same mail cc'd to two of the user's own mailboxes was
    // mined twice, because ADR 0080 account-prefixes provider ids and the
    // extraction mark is keyed on one. `rfc822_message_id` is the identity
    // that crosses accounts (RFC 5322, and all four providers store it), so
    // the AI passes now join on it. This index is what makes that join cheap.
    name: '044_email_messages_rfc822_idx',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_rfc822
        ON email_messages(user_id, rfc822_message_id)`.execute(db);
    },
  },
  {
    // A two-person chat should read as the person you are talking to, not as
    // both of your names — unless somebody deliberately named it. Nothing
    // recorded that intent before, so this column carries it forward.
    // Backfilled to 0 for EVERY existing row (owner decision 2026-08-24): a
    // name only sticks once someone renames the chat from here on, which is
    // what makes the change visible on chats that already exist.
    name: '045_groups_name_is_custom',
    up: async (db) => {
      await sql`ALTER TABLE groups ADD COLUMN IF NOT EXISTS
        name_is_custom integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // Email category ids carried no user, but `email_categories.id` is a GLOBAL
    // primary key and ingest deletes per user — so the first user to classify
    // owned `mk:newsletters` and every other user's ingest died on the pkey,
    // rolled back, and was swallowed by the fail-closed catch. Three prod
    // mailboxes sat unclassified for days on a warn-level log line.
    //
    // Re-key existing rows to `<userId>:<snapshotId>`, matching
    // `storageCategoryId`. No column changes — ids stay `text PRIMARY KEY`.
    //
    // The FKs come off for the rewrite and go straight back on. They are
    // immediate, so with them in place rewriting ids first strands the children
    // and rewriting children first points them at rows that do not exist yet:
    // no ordering of plain updates holds. `applyMigrations` runs each `up`
    // WITHOUT a transaction of its own, so this opens one — a half-rewritten
    // tree with its foreign keys dropped is not a state to leave behind.
    //
    // Every statement is guarded on the prefix being absent, so a re-run is a
    // no-op rather than `u1:u1:mk:…`.
    name: '046_email_category_ids_per_user',
    up: scopeEmailCategoryIds,
  },
  {
    // Bulk-ness is a property of how mail was SENT, not what it is about
    // (ADR 0109). The two signals that carry it were on the wire all along and
    // thrown away: Gmail's metadata allow-list never asked for the headers.
    //
    // `bulk` is derived on thread recompute, so it survives snapshot-replace
    // and costs no LLM call.
    name: '047_email_bulk_signal',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS list_unsubscribe text`.execute(db);
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS list_id text`.execute(db);
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS
        bulk integer NOT NULL DEFAULT 0`.execute(db);
      // Gmail's own tab is already stored on every existing row, so the column
      // is useful on day one instead of waiting for the whole mailbox to
      // re-sync. Deliberately looser than the runtime rule — it reads the
      // thread's UNION of labels rather than requiring every message to be
      // bulk — and the next recompute of a thread corrects it either way.
      await sql`UPDATE email_threads SET bulk = 1
        WHERE bulk = 0 AND gmail_label_ids @> '["CATEGORY_PROMOTIONS"]'::jsonb`.execute(db);
    },
  },
  {
    // ADR 0110 — the AI passes were never shown the email.
    //
    // `body_excerpt` is what sync now keeps for them to read; `body_text`
    // stays lazy and reader-owned (ADR 0060), so neither can truncate the
    // other. `bulk_inferred` is the model's read of how a thread was sent,
    // kept apart from the provider-declared `bulk` because recompute and
    // ingest write on different schedules and would clobber one column.
    // `classifier_version` is what lets a prompt change re-run the mailbox
    // without a migration next time.
    name: '048_email_read_the_message',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS body_excerpt text`.execute(db);
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS
        bulk_inferred integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS
        classifier_version integer NOT NULL DEFAULT 0`.execute(db);
      // Strip the invisible preheader padding already stored. 464 of 2,432
      // prod threads carry it, and on those the median amount of real text
      // left was 78 characters — the model's entire view of the message.
      //
      // The pattern is the helper's own, passed as a PARAMETER: a backslash
      // inside a tagged template is cooked away (\s would match the letter s),
      // and Postgres AREs read the same \u escapes the RegExp constructor does.
      // Whitespace uses the POSIX class for that reason too — nothing to escape.
      for (const table of ['email_threads', 'email_messages'] as const) {
        await sql`UPDATE ${sql.table(table)} SET snippet = btrim(regexp_replace(
            regexp_replace(snippet, ${INVISIBLE_PATTERN}, '', 'g'),
            '[[:space:]]+', ' ', 'g'))
          WHERE snippet ~ ${INVISIBLE_PATTERN}`.execute(db);
      }
    },
  },
  {
    // ADR 0110 — message bodies join the search index. The thread-level tsv
    // (038) covers subject + snippet + sender; a snippet is ~100 characters, so
    // anything said in the body of a message was unfindable.
    //
    // `left(..., 200000)` is load-bearing, not tidiness: `to_tsvector` raises
    // on a string that would exceed the 1MB tsvector limit, and this is a
    // GENERATED column — the error would land on INSERT and wedge the sync for
    // that mailbox, which is precisely how 046 was born.
    // Reads `body_text` when the reader has fetched the whole message and
    // `body_excerpt` otherwise (048): sync keeps an excerpt for EVERY message
    // while the full body stays lazy, so coalescing is what puts a floor under
    // every message rather than only the opened ones. Uniform truncation is a
    // limit worth documenting; coverage that depends on what you happened to
    // open is the invisible kind ADR 0110 refused.
    name: '049_email_message_search_tsv',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (
          to_tsvector('english', left(coalesce(body_text, body_excerpt, ''), 200000))
        ) STORED`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_search_tsv
        ON email_messages USING GIN (search_tsv)`.execute(db);
      // The body backfill drains oldest-gap-first off this predicate.
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_body_missing
        ON email_messages (user_id, internal_date DESC)
        WHERE body_text IS NULL AND body_html IS NULL`.execute(db);
    },
  },
  {
    // ADR 0113 — unsent mail is Chord's, not the provider's. A draft is an
    // unfinished ANSWER, which ADR 0107 puts on our side of the line, and
    // keeping it locally is also the only way autosave can be per-keystroke
    // rather than per-round-trip.
    //
    // `thread_id` is nullable because a composed message has no thread yet.
    // The partial unique index is what makes autosave idempotent: a reply or
    // forward has at most ONE draft per thread, so typing does not mint a row
    // per session. A `new` draft has no thread and is keyed by its id alone.
    name: '050_email_drafts',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_drafts (
        id             text PRIMARY KEY,
        user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind           text NOT NULL,
        thread_id      text REFERENCES email_threads(id) ON DELETE CASCADE,
        account_id     text REFERENCES email_accounts(id) ON DELETE CASCADE,
        to_emails      jsonb NOT NULL DEFAULT '[]',
        cc_emails      jsonb NOT NULL DEFAULT '[]',
        bcc_emails     jsonb NOT NULL DEFAULT '[]',
        subject        text NOT NULL DEFAULT '',
        body           text NOT NULL DEFAULT '',
        attachment_ids jsonb NOT NULL DEFAULT '[]',
        created_at     text NOT NULL,
        updated_at     text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_drafts_user
        ON email_drafts (user_id, updated_at DESC)`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_email_drafts_thread
        ON email_drafts (user_id, kind, thread_id)
        WHERE thread_id IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0115 — undo send. A queued message is a DRAFT with a time on it,
    // which is why this is three columns rather than an outbox table: undo
    // means "put it back in drafts", and that is literally clearing
    // `send_after`. A send that fails does the same thing and leaves
    // `last_error` behind, so the message lands somewhere the user looks
    // instead of disappearing.
    name: '051_email_outbox',
    up: async (db) => {
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS send_after text`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS
        include_attachments integer NOT NULL DEFAULT 1`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS last_error text`.execute(db);
      // The flush polls this every couple of seconds and it is empty almost
      // always, so it must not be a scan of every draft in the table.
      await sql`CREATE INDEX IF NOT EXISTS idx_email_drafts_due
        ON email_drafts (send_after)
        WHERE send_after IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0117 — new mail can finally reach a phone. Two columns, both
    // load-bearing:
    //
    // `email_notified_at` is the high-water mark. Without it the choice is
    // between notifying about a sync's counters (which count upserts, not new
    // mail) and re-notifying about the same thread every tick. It starts NULL
    // and the first pass sets it WITHOUT notifying, so connecting a mailbox
    // does not fire a push per message in the backfill window.
    //
    // `notify_email` is its own toggle rather than reusing `notify_messages`:
    // wanting chat on your phone and mail not (or the reverse) is an ordinary
    // preference, and folding them would make one switch silently govern two
    // unrelated things.
    name: '052_email_push',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notified_at text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS
        notify_email integer NOT NULL DEFAULT 1`.execute(db);
    },
  },
  {
    // ADR 0118 — real push. One row per watched mailbox, covering both the
    // primary Gmail (account_id NULL, ADR 0080's convention) and attached
    // accounts, because Gmail's watch and Graph's subscription are the same
    // kind of thing: an external registration with an id and an expiry.
    //
    // The expiry is the reason this is a table rather than two columns: both
    // providers hand back a deadline measured in DAYS, so something has to
    // find what is due and renew it, and that query wants an index.
    //
    // `client_state` is the shared secret a notification must echo back. Per
    // subscription rather than per deploy, so a leaked one is worth exactly
    // one mailbox's early sync.
    name: '053_mail_subscriptions',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS mail_subscriptions (
        id           text PRIMARY KEY,
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id   text REFERENCES email_accounts(id) ON DELETE CASCADE,
        provider     text NOT NULL,
        external_id  text,
        client_state text NOT NULL,
        expires_at   text NOT NULL,
        failed_at    text,
        last_error   text,
        created_at   text NOT NULL,
        updated_at   text NOT NULL
      )`.execute(db);
      // One live registration per mailbox. `account_id IS NULL` needs its own
      // partial index because NULL is not equal to itself in a unique index.
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_subscriptions_account
        ON mail_subscriptions (user_id, account_id)
        WHERE account_id IS NOT NULL`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_subscriptions_primary
        ON mail_subscriptions (user_id)
        WHERE account_id IS NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_mail_subscriptions_due
        ON mail_subscriptions (expires_at)`.execute(db);
    },
  },
  {
    // ADR 0120 — senders whose remote images the reader has agreed to load.
    // An allow list rather than a block list: the default is to block, so the
    // rows are the exceptions someone chose, and an empty table is the safe
    // state rather than the useless one.
    //
    // Keyed on the address, not the thread: agreeing to see one newsletter's
    // images means agreeing to that sender, which is the decision a reader
    // thinks they are making.
    name: '054_email_image_senders',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_image_senders (
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_email text NOT NULL,
        created_at   text NOT NULL,
        PRIMARY KEY (user_id, sender_email)
      )`.execute(db);
    },
  },
  {
    // ADR 0122. RFC 8058: without this header an https unsubscribe URI is a
    // page for a human, not something we may POST to on their behalf.
    name: '055_email_list_unsubscribe_post',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS list_unsubscribe_post text`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS email_unsubscribes (
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_email text NOT NULL,
        kind         text NOT NULL,
        requested_at text NOT NULL,
        PRIMARY KEY (user_id, sender_email)
      )`.execute(db);
    },
  },
  {
    // ADR 0124. The responder is ours rather than the provider's, so its
    // settings and its memory of who has been told both live here.
    name: '056_email_vacation_responder',
    up: async (db) => {
      for (const col of [
        'vacation_enabled integer NOT NULL DEFAULT 0',
        'vacation_subject text',
        'vacation_body text',
        'vacation_starts_at text',
        'vacation_ends_at text',
        // Mail older than this is not answered: switching the responder on
        // must not reply to a backfill window of already-read mail.
        'vacation_since text',
      ]) {
        await sql`${sql.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`)}`.execute(db);
      }
      await sql`CREATE TABLE IF NOT EXISTS email_auto_replies (
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_email text NOT NULL,
        sent_at      text NOT NULL,
        PRIMARY KEY (user_id, sender_email)
      )`.execute(db);
    },
  },
  {
    // ADR 0129. Two columns, not one: `snoozed_at` is what lets a NEW message
    // wake the thread, since `recomputeThread` also runs on an ordinary label
    // change and must not treat that as new mail.
    name: '057_email_thread_snooze',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS snoozed_until text`.execute(db);
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS snoozed_at text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_snoozed
        ON email_threads (user_id, snoozed_until)
        WHERE snoozed_until IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0135 — a delivery email usually says when it arrives and carries a
    // tracking number; the tile rendered the word "shipped" and dropped both.
    //
    // Persisted because tile facts are computed at RENDER time from stored
    // columns, where no model can run — and not staged as a proposal, because a
    // proposal is something you confirm and an arrival date is not a decision.
    //
    // Numbered 058, not 049: two branches both minted an 049 and the merge
    // kept both. The runner keys on the full NAME so nothing was skipped or
    // double-applied, but a repeated number makes the order unreadable. This
    // one moved because it is idempotent and depends on nothing after 048.
    name: '058_email_delivery_facts',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS delivery_json jsonb`.execute(db);
    },
  },
  {
    // ADR 0136. Defaults to 1: with a proxy in front of every fetch, the harms
    // ADR 0120 blocked for (IP, device, cross-sender correlation) are gone
    // whether or not the image loads, so the reasoning that produced
    // block-by-default now produces load-by-default.
    //
    // Turning it off restores ADR 0120 in full — the per-sender allow list is
    // untouched and still decides who loads.
    name: '059_email_images_auto',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_images_auto integer NOT NULL DEFAULT 1`.execute(db);
    },
  },
  {
    // ADR 0137 — `messages.is_proactive` answered "did Chord start this?", and
    // both publishers read it as "is this the daily briefing?". Six different
    // proactive messages share the flag, so an event echo at 9pm sent the
    // WhatsApp briefing template and pushed quiet-hours-exempt.
    //
    // Nullable with NO backfill on purpose: historical rows are never
    // re-published, and an honest null ("nobody recorded which kind") must read
    // as not-the-briefing rather than being guessed into one.
    name: '060_message_proactive_kind',
    up: async (db) => {
      await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS proactive_kind text`.execute(db);
    },
  },
  {
    // ADR 0138 — what a flight email said about itself. The sibling of 058:
    // identity (`iata`/`number`/`ident`/`airline`) is PARSED from the text and
    // is ground truth, while the times, route and status are READ off the same
    // magics reply that was already running.
    //
    // No URL is stored — it is rebuilt from ident + number at render, so a
    // FlightAware template that changes cannot strand old rows.
    //
    // No backfill: the facts come from a pass that has to re-read the mail
    // anyway, and a thread is mined once ever (ADR 0076).
    name: '061_email_flight_facts',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS flight_json jsonb`.execute(db);
    },
  },
  // ADR 0141 — Chord labels live in their own column because recomputeThread
  // owns gmail_label_ids and would wipe anything written there on the next
  // sync / mark-read / archive.
  {
    name: '062_email_chord_labels',
    up: async (db) => {
      await sql`
        ALTER TABLE email_threads
          ADD COLUMN IF NOT EXISTS chord_label_ids jsonb NOT NULL DEFAULT '[]'
      `.execute(db);
    },
  },
  // ADR 0142 — per-mailbox opt-in for one-way Chord label push. Distinct from
  // gmail_sync_labels_enabled (tile → Gmail). IMAP supported starts at 0 until
  // PERMANENTFLAGS is probed; Gmail/Outlook are marked supported on connect.
  {
    name: '063_chord_label_push',
    up: async (db) => {
      await sql`
        ALTER TABLE email_accounts
          ADD COLUMN IF NOT EXISTS label_push_supported integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS label_push_enabled integer NOT NULL DEFAULT 0
      `.execute(db);
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS chord_label_push_enabled integer NOT NULL DEFAULT 0
      `.execute(db);
      // Connected Gmail + Outlook accounts can push today; IMAP waits for probe.
      await sql`
        UPDATE email_accounts
           SET label_push_supported = 1
         WHERE provider IN ('gmail', 'outlook')
      `.execute(db);
    },
  },
  {
    // ADR 0145 — a user-chosen name for a mailbox.
    //
    // Its OWN column, not `display_name`: that one is provider-supplied and
    // is rewritten on every re-attach, so a nickname stored there would
    // vanish the next time a mailbox was reconnected — the ADR 0141 failure
    // (writing into a column the sync owns) in a different place.
    //
    // The primary Gmail has no `email_accounts` row (ADR 0080: account_id
    // NULL IS the primary), so its nickname lives on `users`, the same
    // asymmetry ADR 0142 already established for label-push opt-in.
    name: '064_mailbox_nickname',
    up: async (db) => {
      await sql`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS nickname text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_nickname text`.execute(db);
    },
  },
  {
    // ADR 0148 — proactively ask when the stored weather location looks stale.
    // `weather_ip_*` is the last IP-derived fix, stashed on every /me/timezone
    // call (the daily scan has no request IP of its own); `weather_prompt_*`
    // dedups the chat question — coordinates we last asked about, when, and
    // whether the user said "keep it" (so we don't re-ask until they move a
    // real distance from that spot).
    name: '065_weather_drift_signal',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_ip_place text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_ip_lat double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_ip_lon double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_ip_at text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_prompt_lat double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_prompt_lon double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_prompt_at text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_prompt_declined integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // Family-profile Phase 1 — `personas`, the roster for the per-group
    // "About this family" surface. Every account-member of a shared group is
    // backfilled a persona; managed non-users are added via the API.
    // (Numbered 066 to sidestep a concurrent 065 on another branch; a gap in
    // migration numbers is cosmetic — `_migrations` keys on name, not order.)
    name: '066_family_personas',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS personas (
        id                text PRIMARY KEY,
        group_id          text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_user_id    text NULL REFERENCES users(id) ON DELETE SET NULL,
        name              text NOT NULL,
        household_role    text NOT NULL DEFAULT 'other'
                            CHECK (household_role IN ('parent','child','grandparent','caregiver','other')),
        is_managed        integer NOT NULL DEFAULT 0,
        managed_by        text NULL REFERENCES users(id) ON DELETE SET NULL,
        birthdate         text NULL,
        linked_person_id  text NULL REFERENCES people(id) ON DELETE SET NULL,
        created_at        text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_group_member
        ON personas (group_id, member_user_id)
        WHERE member_user_id IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_personas_group ON personas (group_id)`.execute(db);
      await seedGroupPersonas(db);
    },
  },
  {
    // Family-profile Phase 1 — denormalised subject identity + a grouping
    // category + provenance on `memories`, so the per-group "About this
    // family" surface can render facts by member and by category and link
    // each back to where it came from. All nullable; `classifyLegacyMemories`
    // backfills from scope/persona_id/key.
    name: '067_memories_subject_facts',
    up: async (db) => {
      await sql`ALTER TABLE memories
        ADD COLUMN IF NOT EXISTS subject_type text
          CHECK (subject_type IN ('user','persona','household')),
        ADD COLUMN IF NOT EXISTS subject_id   text,
        ADD COLUMN IF NOT EXISTS category     text
          CHECK (category IN ('health','school','contact','sizes','prefs','logistics','dates','note')),
        ADD COLUMN IF NOT EXISTS provenance   text,
        ADD COLUMN IF NOT EXISTS dated_at     text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_memories_subject
        ON memories (group_id, subject_type, subject_id)`.execute(db);
      await classifyLegacyMemories(db);
    },
  },
  {
    // ADR 0156 — Sign in with Apple. `apple_sub` is the Apple identity (partial
    // unique, like google_sub); the sealed refresh token exists so account
    // deletion can revoke it at Apple, which Apple requires.
    name: '068_users_apple_sign_in',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS apple_sub                       text,
        ADD COLUMN IF NOT EXISTS apple_refresh_token_ciphertext  bytea,
        ADD COLUMN IF NOT EXISTS apple_refresh_token_iv          bytea,
        ADD COLUMN IF NOT EXISTS apple_refresh_token_tag         bytea`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub_unique
        ON users (apple_sub) WHERE apple_sub IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0158 — free-text `notes` on legs + stays (trip_reservations already
    // has it). Holds the booking-site itinerary/order number when it differs
    // from the carrier PNR, and flows into the flight leg's calendar event.
    name: '069_trip_leg_notes',
    up: async (db) => {
      await sql`ALTER TABLE travel_legs    ADD COLUMN IF NOT EXISTS notes text`.execute(db);
      await sql`ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS notes text`.execute(db);
    },
  },
  {
    // ADR 0160. Twin of 058/061 (delivery/flight facts): what a receipt email
    // said, mined by the magics pass and stored for a future Finance feature
    // to read — nothing here proposes anything.
    name: '070_email_receipt_facts',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS receipt_json jsonb`.execute(db);
    },
  },
  {
    // ADR 0161 — per-user rules for what should never surface in the daily
    // briefing's email section. Deliberately narrower than email_routing_rules
    // (031): no target — a hit just means "leave this out of digest.service.ts's
    // rendering", never touches classification/extraction.
    name: '071_email_briefing_rules',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_briefing_rules (
        id          text PRIMARY KEY,
        user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind        text NOT NULL CHECK (kind IN ('sender_domain', 'sender_email', 'category', 'subject_keyword')),
        pattern     text NOT NULL,
        created_at  text NOT NULL,
        UNIQUE (user_id, kind, pattern)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_briefing_rules_user
        ON email_briefing_rules (user_id)`.execute(db);
    },
  },
  {
    // ADR 0163 — a short, once-computed "why" for a meeting event, mined from
    // prior correspondence with its invitee(s) rather than the single message
    // that triggered create_event. Own column (not folded into `description`,
    // ADR 0158/0162) so it renders as a distinct fact, matching the
    // delivery_json/flight_json/receipt_json per-fact-column idiom.
    name: '072_event_meeting_context',
    up: async (db) => {
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS meeting_context text`.execute(db);
    },
  },
  {
    // ADR 0165 — before per-group turn serialisation + the resolve-or-create
    // advisory lock, a burst of messages in one group ("add oatmeal to the
    // trader joes list" / "add bananas" / …) raced `resolveOrCreateListByName`
    // and each turn INSERTed its own fork. Fold each group's same-key lists
    // into the oldest, moving over only the items the keeper lacks — the same
    // function 042/043 use, idempotent, a no-op wherever one list per key
    // already stands (so harmless on a fresh DB).
    name: '073_merge_forked_lists',
    up: mergeDuplicateLists,
  },
  {
    // Family-profile Phase 3b (ADR 0151) — a managed persona (a kid, a
    // grandparent) can be the assignee of a task or the subject of a calendar
    // item. A parallel FK-free-of-`users` column, mutually exclusive with
    // `assignee_id` (service-enforced, not a CHECK — the .ics/invite synthesis
    // paths are easier to reason about with a guard). No backfill.
    name: '074_persona_assignees',
    up: async (db) => {
      await sql`ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS assignee_persona_id text
          REFERENCES personas(id) ON DELETE SET NULL`.execute(db);
      await sql`ALTER TABLE events
        ADD COLUMN IF NOT EXISTS assignee_persona_id text
          REFERENCES personas(id) ON DELETE SET NULL`.execute(db);
    },
  },
  {
    // ADR 0168 — a cancellation email needs somewhere to record that a
    // booking is off. Nullable fire-once marker (like tasks.archived_at,
    // ADR 0092) on all three trip-child tables plus the trip itself, which
    // is derived (set when every leg/accommodation/reservation on it is
    // cancelled) rather than asked.
    name: '075_trip_cancellation',
    up: async (db) => {
      await sql`ALTER TABLE trips         ADD COLUMN IF NOT EXISTS cancelled_at text`.execute(db);
      await sql`ALTER TABLE travel_legs   ADD COLUMN IF NOT EXISTS cancelled_at text`.execute(db);
      await sql`ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS cancelled_at text`.execute(db);
    },
  },
  {
    // A trip is soft-deleted (never hard) so an accidental "x" tap on the
    // Trips tab is recoverable — the same fire-once-marker shape as
    // cancelled_at above, just for the user's own delete action instead of a
    // cancellation email. Legs/accommodations have no deleted_at of their
    // own: removing one is a real (hard) delete, and the trip itself only
    // soft-deletes when nothing is left on it (maybeDeleteEmptyTrip).
    name: '076_trip_deleted',
    up: async (db) => {
      await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS deleted_at text`.execute(db);
    },
  },
  {
    // ADR 0180 — opening a thread runs its own extraction pass, regardless of
    // whether the background sweep's gates (bulk/discretionary/stale-read) or
    // its once-ever `magic` mark would have skipped it. `read` is a THIRD,
    // independent extraction-mark kind (never cleared, same idempotence as
    // `magic`/`person`) so re-opening an already-passed thread re-serves the
    // stored result instead of re-asking the LLM. `read_advisory_json` holds
    // the new `advisory` suggestion kind — a caution worth showing when
    // nothing is actionable, never staged as a proposal (nothing to confirm
    // about a warning).
    name: '077_email_read_time_pass',
    up: async (db) => {
      await sql`ALTER TABLE email_extraction_marks DROP CONSTRAINT IF EXISTS email_extraction_marks_kind_check`.execute(db);
      await sql`ALTER TABLE email_extraction_marks ADD CONSTRAINT email_extraction_marks_kind_check CHECK (kind IN ('magic', 'person', 'read'))`.execute(db);
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS read_advisory_json jsonb`.execute(db);
    },
  },
  {
    // Performance audit — `expireStale()` runs on every `GET .../proposals`
    // poll (ADR 0105 refetches the To Do's hub often) with no `group_id` in
    // its WHERE clause, so the existing `idx_proposals_group_status`
    // (group_id, status) can't be used and every call sequential-scans the
    // whole table. This index leads with `status` — the ~always-small
    // `pending` slice — so the sweep becomes a cheap index scan regardless
    // of table size.
    name: '078_proposals_status_expires_index',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_proposals_status_expires
        ON proposals (status, expires_at)`.execute(db);
    },
  },
  {
    // Performance audit — `llm-classifier.ts`'s `selectBatch` now pushes its
    // need/stale/re-run-queue selection into SQL with a LIMIT instead of
    // loading every non-archived thread for the user; this index lets that
    // query narrow to the user's own mailbox by an index scan before the
    // WHERE/ORDER BY/LIMIT run over it, instead of a sequential scan of
    // `email_threads` across every user.
    name: '079_email_threads_user_archived_index',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_user_archived
        ON email_threads (user_id, is_archived)`.execute(db);
    },
  },
  {
    // Performance audit — `event-convergence.service.ts`'s
    // `findAdoptableEmailEventTwin` and `retractProposalsCoveredByExistingEvents`
    // now bound their event scans to a starts_at range instead of an owner's
    // whole event history; this index makes that range scan an index seek
    // instead of a filtered sequential scan over `idx_events_owner`.
    name: '080_events_owner_starts_at_index',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_events_owner_starts_at
        ON events (owner_user_id, starts_at)`.execute(db);
    },
  },
  {
    // Performance audit — supporting indexes for the LIMIT/range-bound
    // queries added across tasks/lists/saves/memories/events in this same
    // pass (createTaskWithDedup, addItem, findDuplicate, listTasks(ForUser),
    // listLists(ForUser), listSaves, listMemories(ForUser), findSimilarEvent,
    // listEvents(ForUser)). All order/filter by (group_id, created_at) or
    // (group_id, starts_at) — without these, a LIMIT still pays for a full
    // sequential scan to find the newest/soonest rows before cutting it off.
    name: '081_group_scoped_recency_indexes',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_group_created
        ON tasks (group_id, created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_lists_group_created
        ON lists (group_id, created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_list_items_list_created
        ON list_items (list_id, created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_saves_group_created
        ON saves (group_id, created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_memories_group_created
        ON memories (group_id, created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_events_group_starts
        ON events (group_id, starts_at)`.execute(db);
    },
  },
  {
    // Completes ADR 0016's never-shipped `relationships` table + widens the
    // family-profile subject model to a private `people` row (not just a
    // group persona/user/household) — see docs/notes/0189. `subject_type`'s
    // CHECK was added unnamed on migration 067's ALTER TABLE, so it carries
    // Postgres's default constraint name for that column.
    name: '082_people_graph_and_relationships',
    up: async (db) => {
      await sql`ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_subject_type_check`.execute(db);
      await sql`ALTER TABLE memories ADD CONSTRAINT memories_subject_type_check
        CHECK (subject_type IN ('user','persona','household','person'))`.execute(db);
      // Nullable decay column — see memory.service.ts's `decayMemories`. NULL
      // (the default for every existing row) means "manual confirm only",
      // preserving today's behavior for anything not explicitly opted in.
      await sql`ALTER TABLE memories
        ADD COLUMN IF NOT EXISTS auto_confirm_at text`.execute(db);

      await sql`CREATE TABLE IF NOT EXISTS person_relationships (
        id            text PRIMARY KEY,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_type  text NOT NULL CHECK (subject_type IN ('user','persona','person')),
        subject_id    text NOT NULL,
        related_type  text NOT NULL CHECK (related_type IN ('user','persona','person')),
        related_id    text NOT NULL,
        relation      text NOT NULL,
        confidence    real NOT NULL DEFAULT 0.6,
        status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed','confirmed')),
        source        text NOT NULL,
        provenance    text,
        created_at    text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_person_relationships_edge
        ON person_relationships (owner_user_id, subject_type, subject_id, related_type, related_id, relation)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_person_relationships_subject
        ON person_relationships (owner_user_id, subject_type, subject_id)`.execute(db);
    },
  },
  {
    // docs/notes/0191 — a person the user has not confirmed yet. It gets an id
    // so extracted facts and the relationship edge can attach immediately, but
    // lives in its own table so no existing `people` reader (bulk gate,
    // autocomplete, invite resolution, People screen) can ever see it. The id
    // becomes `people.id` on promote, so nothing attached needs re-pointing.
    name: '083_provisional_people',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS provisional_people (
        id            text PRIMARY KEY,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name  text NOT NULL,
        email         text,
        notes         text,
        proposal_id   text,
        created_at    text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_provisional_people_owner
        ON provisional_people (owner_user_id)`.execute(db);
    },
  },
  {
    // docs/notes/0193 — per-user token-usage visibility (not a billing
    // ledger, ADR 0063's credit_ledger stays the actual gate). Append-only,
    // no unique `ref` — a duplicate row costs an inflated display number,
    // not a double charge, so the idempotency machinery a real ledger needs
    // isn't worth it here. "Used this month" is a SUM over created_at, not a
    // materialized balance, so there's nothing to reset.
    name: '084_token_usage',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS token_usage (
        id                text PRIMARY KEY,
        user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source            text NOT NULL CHECK (source IN ('bot_turn','email_classify','email_magics','email_persons')),
        ref               text NOT NULL,
        model             text NOT NULL,
        prompt_tokens     integer NOT NULL,
        completion_tokens integer NOT NULL,
        total_tokens      integer NOT NULL,
        created_at        text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_token_usage_user_period
        ON token_usage (user_id, created_at)`.execute(db);
    },
  },
  {
    // docs/notes/0195 — Stripe subscriptions (system-key plan + BYOK base
    // plan), replacing ADR 0075's one-time bundle purchase. Nullable/additive,
    // per ADR 0194's reasoning against renaming existing columns. The
    // credit_ledger reason CHECK is widened for the new periodic-reset write
    // (`resetTokenAllowance`) — Postgres's default name for an unnamed
    // column-level CHECK is `<table>_<column>_check`, dropped and re-added
    // rather than left unconstrained.
    name: '085_stripe_subscriptions',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS stripe_customer_id text,
        ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
        ADD COLUMN IF NOT EXISTS subscription_plan text CHECK (subscription_plan IN ('system','byok_base')),
        ADD COLUMN IF NOT EXISTS subscription_current_period_end text`.execute(db);
      await sql`ALTER TABLE credit_ledger
        DROP CONSTRAINT IF EXISTS credit_ledger_reason_check`.execute(db);
      await sql`ALTER TABLE credit_ledger
        ADD CONSTRAINT credit_ledger_reason_check
        CHECK (reason IN ('purchase','turn_debit','grant','refund','subscription_reset'))`.execute(db);
    },
  },
  {
    // docs/notes/0196 — "usage is the ledger": remaining balance is now
    // computed as MONTHLY_TOKEN_ALLOWANCE minus SUM(token_usage) since this
    // timestamp, not a stored/debited number. credit_balance/credit_ledger
    // are vestigial as of this migration — nothing writes to them again.
    name: '086_subscription_period_start',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS subscription_period_started_at text`.execute(db);
    },
  },
  {
    // docs/notes/0197 — "compose a reply" is an AI surface like any other, so
    // its tokens count against the same allowance (ADR 0196). Widens the
    // source CHECK the same way 085 widened credit_ledger's.
    name: '087_token_usage_email_reply',
    up: async (db) => {
      await sql`ALTER TABLE token_usage
        DROP CONSTRAINT IF EXISTS token_usage_source_check`.execute(db);
      await sql`ALTER TABLE token_usage
        ADD CONSTRAINT token_usage_source_check
        CHECK (source IN ('bot_turn','email_classify','email_magics','email_persons','email_reply'))`.execute(db);
    },
  },
  {
    // docs/notes/0199 — a read/unread change the provider has not accepted yet.
    // One row per thread (the latest intent wins); sync re-applies it so the
    // mirror cannot flip back, and the sweep retries it with backoff.
    name: '088_email_read_writes',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_read_writes (
        thread_id        text PRIMARY KEY REFERENCES email_threads(id) ON DELETE CASCADE,
        user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        desired_unread   integer NOT NULL,
        attempts         integer NOT NULL DEFAULT 0,
        next_attempt_at  text NOT NULL,
        last_error       text,
        created_at       text NOT NULL,
        updated_at       text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_read_writes_due
        ON email_read_writes (next_attempt_at)`.execute(db);
    },
  },
  {
    // docs/notes/0200 — a Google event id is unique per calendar, not per
    // Chord user: every subscriber of a public calendar (US holidays) or a
    // shared family calendar sees the same (calendar, event) pair, and ADR
    // 0040 gives each of them their own row.
    name: '089_gcal_identity_per_owner',
    up: async (db) => {
      await scopeGcalIdentityPerOwner(db);
    },
  },
  {
    // ADR 0201 — one wrapped data key per owner (a user id for mail, a group id
    // for files). Only the wrapped form is stored. Destroying an owner's key is
    // how their sealed data is erased, hence `destroyed_at` instead of a delete:
    // a destroyed key must stay distinguishable from one that never existed.
    name: '090_content_keys',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS content_keys (
        owner        text PRIMARY KEY,
        wrapped_dek  bytea,
        provider     text NOT NULL,
        created_at   text NOT NULL,
        destroyed_at text
      )`.execute(db);
    },
  },
  {
    // ADR 0201 phase 3 — the blind search index. Plain tsvector columns the
    // application fills with keyed hashes; nothing here is generated from the
    // text, because the text is sealed. The old generated `search_tsv` columns
    // stay until `encrypt:finalize` drops them, so rows that predate the index
    // remain searchable through the backfill.
    name: '091_email_blind_index',
    up: async (db) => {
      for (const table of ['email_threads', 'email_messages']) {
        await sql`ALTER TABLE ${sql.table(table)}
          ADD COLUMN IF NOT EXISTS blind_words tsvector,
          ADD COLUMN IF NOT EXISTS blind_grams tsvector,
          ADD COLUMN IF NOT EXISTS blind_from tsvector`.execute(db);
      }
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_blind_words ON email_threads USING gin (blind_words)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_blind_grams ON email_threads USING gin (blind_grams)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_threads_blind_from ON email_threads USING gin (blind_from)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_blind_words ON email_messages USING gin (blind_words)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_blind_grams ON email_messages USING gin (blind_grams)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_blind_from ON email_messages USING gin (blind_from)`.execute(db);
    },
  },
  {
    // ADR 0201 phase 4 - the same blind index for attachment chunks. The
    // generated `body_tsv` stays until `encrypt:backfill --step finalize-derived`.
    name: '092_attachment_chunk_blind_index',
    up: async (db) => {
      await sql`ALTER TABLE attachment_chunks ADD COLUMN IF NOT EXISTS blind_words tsvector`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_attachment_chunks_blind_words ON attachment_chunks USING gin (blind_words)`.execute(db);
    },
  },
  {
    // `scheduled_for` is compared as text against a UTC "…Z" now, so a
    // task_remind row queued with the task's own offset ("…T07:00:00-04:00")
    // fired at 07:00Z - four hours early in New York. Writers now store UTC;
    // this rewrites the rows still waiting to fire. Floating values (no
    // offset) are left alone rather than guessed.
    name: '093_proactive_scheduled_for_utc',
    up: async (db) => {
      await normalizeProactiveScheduledFor(db);
    },
  },
  {
    // ADR 0212 - a person's phone number, set by `update_person` when the user
    // asks Chord to remember it. Free text as typed; nothing dials or matches it.
    name: '094_people_phone',
    up: async (db) => {
      await sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS phone text`.execute(db);
    },
  },
  {
    // ADR 0215 - what swiping an email row does: 'archive' (ADR 0128's
    // behaviour, kept as the default) or 'trash'.
    name: '095_email_swipe_action',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_swipe_action text NOT NULL DEFAULT 'archive'
        CHECK (email_swipe_action IN ('archive', 'trash'))`.execute(db);
    },
  },
  {
    // ADR 0217 — a repeating event: the rule lives here, its occurrences are
    // ordinary `events` rows pointing back with `series_id`. `series_uid` is
    // shared by every family member's copy of one logical series (the
    // `ical_uid` of ADR 0040, one level up).
    name: '096_event_series',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS event_series (
        id                   text PRIMARY KEY,
        series_uid           text NOT NULL,
        group_id             text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        group_ids            jsonb NOT NULL DEFAULT '[]'::jsonb,
        owner_user_id        text REFERENCES users(id) ON DELETE CASCADE,
        organizer_user_id    text REFERENCES users(id) ON DELETE SET NULL,
        role                 text NOT NULL DEFAULT 'organizer',
        created_by           text REFERENCES users(id) ON DELETE SET NULL,
        assignee_id          text REFERENCES users(id) ON DELETE SET NULL,
        assignee_persona_id  text REFERENCES personas(id) ON DELETE SET NULL,
        title                text NOT NULL,
        description          text,
        location             text,
        starts_at            text NOT NULL,
        ends_at              text,
        all_day              integer NOT NULL DEFAULT 0,
        transparency         text NOT NULL DEFAULT 'opaque',
        tz                   text NOT NULL,
        rrule                text NOT NULL,
        exdates              jsonb NOT NULL DEFAULT '[]'::jsonb,
        materialized_until   text,
        source_raw_context   text,
        google_calendar_id   text,
        gcal_event_id        text,
        etag                 text,
        chord_uid            text,
        local_dirty          integer NOT NULL DEFAULT 1,
        deleted_at           text,
        gcal_sync_status     text,
        gcal_last_error      text,
        created_at           text NOT NULL,
        updated_at           text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_series_owner ON event_series (owner_user_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_series_uid ON event_series (series_uid)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_series_gcal ON event_series (owner_user_id, gcal_event_id)`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS series_id text
        REFERENCES event_series(id) ON DELETE SET NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_events_series ON events (series_id)
        WHERE series_id IS NOT NULL`.execute(db);
      // Every Google series was pulled into ONE row (each instance matched the
      // previous one by the shared iCalUID). A delta never re-sends unchanged
      // instances, so only a full pull brings them back: drop the cursors once.
      await sql`UPDATE calendar_sources SET sync_token = NULL
        WHERE provider = 'google' AND sync_token IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0218 — where the reader goes after an email is archived or
    // trashed from it: the next email (default) or back to the list.
    name: '097_email_after_remove',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_after_remove text NOT NULL DEFAULT 'next'
        CHECK (email_after_remove IN ('next', 'list'))`.execute(db);
    },
  },
  {
    // ADR 0225 — remote email images fetched when the mail arrives, not when
    // it is opened. One row per (user, image address); the bytes live on disk.
    // `images_preloaded_at` marks a message the pass has been through, however
    // it went, so a message is fetched for once.
    name: '098_email_image_preload',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_image_cache (
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url_hash     text NOT NULL,
        content_type text NOT NULL,
        bytes        integer NOT NULL,
        fetched_at   text NOT NULL,
        PRIMARY KEY (user_id, url_hash)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_image_cache_fetched
        ON email_image_cache (fetched_at)`.execute(db);
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS images_preloaded_at text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_images_pending
        ON email_messages (user_id, internal_date DESC) WHERE images_preloaded_at IS NULL`.execute(db);
    },
  },
  {
    // ADR 0228 — Outlook calendars. Whether a mailbox's grant covers the
    // calendar, and which of its calendars is the default one.
    name: '099_outlook_calendar',
    up: async (db) => {
      await sql`ALTER TABLE email_accounts
        ADD COLUMN IF NOT EXISTS calendar_enabled integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE email_accounts
        ADD COLUMN IF NOT EXISTS calendar_default_id text`.execute(db);
    },
  },
  {
    // docs/notes/0231 — annual billing, the family plan, and a second seller
    // (the App Store, via RevenueCat). `subscription_plan` gains 'family';
    // interval/source say how it was bought. The roster is its own table
    // because a seat can be held by someone with no account yet. Two partial
    // unique indexes: a code finds exactly one invite, and a person can be
    // ACTIVE on only one family plan (profile/invited rows may repeat).
    name: '100_family_plan',
    up: async (db) => {
      await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_plan_check`.execute(db);
      await sql`ALTER TABLE users
        ADD CONSTRAINT users_subscription_plan_check
        CHECK (subscription_plan IN ('system','family','byok_base'))`.execute(db);
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS subscription_interval text CHECK (subscription_interval IN ('month','year')),
        ADD COLUMN IF NOT EXISTS subscription_source text CHECK (subscription_source IN ('stripe','apple'))`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS family_members (
        id             text PRIMARY KEY,
        owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id        text REFERENCES users(id) ON DELETE SET NULL,
        name           text NOT NULL,
        email          text,
        phone          text,
        relationship   text,
        status         text NOT NULL CHECK (status IN ('profile','invited','active')),
        chordinator    integer NOT NULL DEFAULT 0,
        invite_code    text,
        person_id      text REFERENCES people(id) ON DELETE SET NULL,
        created_at     text NOT NULL,
        invited_at     text,
        joined_at      text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_family_members_owner
        ON family_members (owner_user_id)`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_family_members_code
        ON family_members (invite_code) WHERE invite_code IS NOT NULL`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_family_members_active_user
        ON family_members (user_id) WHERE status = 'active' AND user_id IS NOT NULL`.execute(db);
    },
  },
  {
    // docs/notes/0231 — single-use promo codes ("a free month if you subscribe")
    // and a permanent grandfather flag. A code is burned when the subscription
    // it was attached to actually starts, not when it is typed in, so an
    // abandoned checkout doesn't cost a code. `grandfathered_at` is set by an
    // explicit script with a cutoff, never by this migration — what counts as
    // "existing" is the day billing goes live, which no migration can know.
    name: '101_promo_codes_and_grandfathering',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS promo_codes (
        code         text PRIMARY KEY,
        kind         text NOT NULL DEFAULT 'free_month' CHECK (kind IN ('free_month')),
        trial_days   integer NOT NULL DEFAULT 30,
        note         text,
        created_at   text NOT NULL,
        expires_at   text,
        redeemed_by  text REFERENCES users(id) ON DELETE SET NULL,
        redeemed_at  text
      )`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS grandfathered_at text`.execute(db);
    },
  },
  {
    // docs/notes/0234 — a family plan's shared chat. The group is an ordinary
    // `kind='group'` row; this column only says whose family it is, so the
    // roster code can find it again and the sharing offers can prefer it. One
    // per owner (partial unique index), never required: a plan with nobody
    // seated has no group yet.
    name: '102_family_group',
    up: async (db) => {
      await sql`ALTER TABLE groups
        ADD COLUMN IF NOT EXISTS family_owner_id text REFERENCES users(id) ON DELETE SET NULL`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_family_owner
        ON groups (family_owner_id) WHERE family_owner_id IS NOT NULL`.execute(db);
    },
  },
  {
    // docs/notes/0235 - an open "connect OpenRouter" attempt: the state the
    // callback arrives with, bound to the user who started it, and the PKCE
    // verifier for the code exchange. Short-lived rows, pruned on each start.
    name: '103_openrouter_connects',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS openrouter_connects (
        state         text PRIMARY KEY,
        user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_verifier text NOT NULL,
        model         text NOT NULL,
        platform      text NOT NULL CHECK (platform IN ('web', 'native')),
        created_at    text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_openrouter_connects_user
        ON openrouter_connects (user_id)`.execute(db);
    },
  },
  {
    // docs/notes/0242 - in a shared chat, deleting a message removes it from
    // one member's view only. `message_hides` holds the selected ones;
    // `group_members.cleared_at` is "clear chat", which covers a whole
    // history with one value instead of a row per message.
    name: '104_message_hides',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS message_hides (
        user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        group_id   text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        created_at text NOT NULL,
        PRIMARY KEY (user_id, message_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_message_hides_message
        ON message_hides (message_id)`.execute(db);
      await sql`ALTER TABLE group_members ADD COLUMN IF NOT EXISTS cleared_at text`.execute(db);
    },
  },
  {
    // docs/notes/0249 - a receipt outlives its email. Keyed by the provider's
    // thread id, not email_threads.id, because the thread row is deleted when
    // the mail is (ADR 0073/0224) and a copy keyed to it would go with it.
    // Values are copied as stored: a sealed value opens by its own context.
    name: '105_email_receipts',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_receipts (
        id              text PRIMARY KEY,
        user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gmail_thread_id text NOT NULL,
        receipt_json    jsonb NOT NULL,
        from_name       text,
        from_email      text,
        account_id      text,
        mailbox         text,
        email_at        text NOT NULL,
        created_at      text NOT NULL,
        UNIQUE (user_id, gmail_thread_id)
      )`.execute(db);
      await copyThreadReceipts(db);
    },
  },
  {
    // docs/notes/0252 - a bring-your-own-key user's key running out of credit
    // (or being rejected) is recorded where the Email tab and Settings can
    // read it, and nudged once per outage.
    name: '106_byok_key_health',
    up: async (db) => {
      await sql`ALTER TABLE users
        ADD COLUMN IF NOT EXISTS byok_key_issue text
          CHECK (byok_key_issue IN ('credit', 'auth')),
        ADD COLUMN IF NOT EXISTS byok_key_issue_at text,
        ADD COLUMN IF NOT EXISTS byok_key_nudged_at text`.execute(db);
    },
  },
  {
    // ADR 0255 — the mailbox new mail goes out from, set in chat. No FK: the
    // value is 'primary' or an account id, and a removed account is simply
    // ignored at send time.
    name: '107_default_send_mailbox',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS default_send_mailbox text`.execute(db);
    },
  },
  {
    // ADR 0255 addendum — later per-user defaults live here as key → value
    // instead of one column each. Written only via user-defaults.service.ts.
    name: '108_user_defaults',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS defaults jsonb NOT NULL DEFAULT '{}'::jsonb`.execute(db);
    },
  },
  {
    // docs/notes/0258 - the phone's own location, when the user has allowed it.
    // `weather_device_*` is the latest fix, kept even when an explicit Settings
    // choice outranks it so the "you seem to have moved" check (ADR 0148) has
    // something better than an IP address to compare against.
    name: '109_device_location',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_device_place text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_device_lat double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_device_lon double precision`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS weather_device_at text`.execute(db);
    },
  },
  {
    // docs/notes/0260 - a rich signature, stored already cleaned. `email_signature`
    // stays the plain-text form (derived from it when this is set).
    name: '110_email_signature_html',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature_html text`.execute(db);
    },
  },
  {
    // docs/notes/0261 - "Summarize" on an open email is an AI surface like
    // the reply composer, so it counts against the same allowance.
    name: '111_token_usage_email_summary',
    up: async (db) => {
      await sql`ALTER TABLE token_usage
        DROP CONSTRAINT IF EXISTS token_usage_source_check`.execute(db);
      await sql`ALTER TABLE token_usage
        ADD CONSTRAINT token_usage_source_check
        CHECK (source IN ('bot_turn','email_classify','email_magics','email_persons','email_reply','email_summary'))`.execute(db);
    },
  },
  {
    // docs/notes/0269 - session tokens are stored as `h_<sha256>` of the token
    // the client holds. Rewrites existing rows so nobody is signed out; skips
    // rows already hashed, so it is safe to re-run (web.ts also runs it at boot).
    name: '112_hash_session_tokens',
    up: hashSessionTokens,
  },
  {
    // ADR 0270 — "mail from Bill" filters every message of the user's mail by
    // exact sender address.
    name: '113_mail_search_people',
    up: async (db) => {
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_user_from
        ON email_messages (user_id, lower(from_email))`.execute(db);
    },
  },
  {
    // ADR 0276 — search vectors, one per email thread and one per file, sealed
    // under the same owner as the content. `model` says which embedding model
    // made the vector; only vectors of one model are compared.
    name: '114_search_embeddings',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS email_thread_embeddings (
        thread_id text PRIMARY KEY REFERENCES email_threads(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        model text NOT NULL,
        content_hash text NOT NULL,
        vec bytea NOT NULL,
        embedded_at text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_thread_embeddings_user
        ON email_thread_embeddings (user_id, model)`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS attachment_embeddings (
        attachment_id text PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
        owner text NOT NULL,
        model text NOT NULL,
        content_hash text NOT NULL,
        vec bytea NOT NULL,
        embedded_at text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_attachment_embeddings_owner
        ON attachment_embeddings (owner, model)`.execute(db);
      await sql`ALTER TABLE token_usage
        DROP CONSTRAINT IF EXISTS token_usage_source_check`.execute(db);
      await sql`ALTER TABLE token_usage
        ADD CONSTRAINT token_usage_source_check
        CHECK (source IN ('bot_turn','email_classify','email_magics','email_persons','email_reply','email_summary','embedding'))`.execute(db);
    },
  },
  {
    // ADR 0278 — a calendar color the user picked in Chord. Separate from
    // `color`, which every provider sync rewrites.
    name: '115_calendar_color_choice',
    up: async (db) => {
      await sql`ALTER TABLE calendar_sources ADD COLUMN IF NOT EXISTS color_choice text`.execute(db);
    },
  },
  {
    // ADR 0280 — state that has to be shared once a role runs as several
    // copies. A ticket orders one group's bot turns across processes; a
    // pending-state row is what the bot is still waiting on an answer to.
    name: '116_multi_instance_state',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS bot_turn_tickets (
        seq           bigserial PRIMARY KEY,
        group_id      text NOT NULL,
        message_id    text,
        heartbeat_at  timestamptz NOT NULL DEFAULT now()
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS bot_turn_tickets_group
        ON bot_turn_tickets (group_id, seq)`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS bot_pending_state (
        kind        text NOT NULL,
        scope_key   text NOT NULL,
        value       jsonb NOT NULL,
        expires_at  timestamptz NOT NULL,
        PRIMARY KEY (kind, scope_key)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS bot_pending_state_expires
        ON bot_pending_state (expires_at)`.execute(db);
    },
  },
  {
    // ADR 0281 — a learned fact's chat card, and when a chat's facts were last
    // reviewed for duplicates. No FK to memories: a forgotten fact's row is
    // deleted and its card must still be found to say so.
    name: '117_memory_notices',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS memory_notices (
        memory_id  text PRIMARY KEY,
        message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        created_at text NOT NULL
      )`.execute(db);
      await sql`ALTER TABLE groups ADD COLUMN IF NOT EXISTS memories_reviewed_at text`.execute(db);
      await sql`ALTER TABLE token_usage
        DROP CONSTRAINT IF EXISTS token_usage_source_check`.execute(db);
      await sql`ALTER TABLE token_usage
        ADD CONSTRAINT token_usage_source_check
        CHECK (source IN ('bot_turn','email_classify','email_magics','email_persons','email_reply','email_summary','embedding','memory_cleanup'))`.execute(db);
    },
  },
  {
    // ADR 0284 — a fact's search vector, one per embedding model (only vectors
    // of one model compare). Made when a search needs it; goes with the fact.
    name: '118_memory_embeddings',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id    text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model        text NOT NULL,
        content_hash text NOT NULL,
        vec          bytea NOT NULL,
        embedded_at  text NOT NULL,
        PRIMARY KEY (memory_id, model)
      )`.execute(db);
    },
  },
  {
    // ADR 0285 — why a to-do was archived, so the briefing can say which ones
    // Chord retired. Not backfilled: an older row's reason was never recorded.
    name: '119_task_archived_reason',
    up: async (db) => {
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_reason text`.execute(db);
    },
  },
  {
    // ADR 0293 — Sign in with Microsoft. `<tid>:<oid>`; unique where set.
    name: '120_microsoft_sub',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_sub text`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_microsoft_sub_unique
        ON users (microsoft_sub) WHERE microsoft_sub IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0294 — what the sender checks need from the headers. Not
    // backfilled: an older message simply reads as "not checked".
    name: '121_email_sender_auth',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS reply_to text`.execute(db);
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS auth_results jsonb`.execute(db);
    },
  },
  {
    // ADR 0289 addendum 2026-10-24 — which trip a calendar entry is part of.
    // `trip_link`: NULL = not decided yet, 'auto' = the matcher found it,
    // 'user' = the user said so (`trip_id` NULL then means "not travel").
    // Not backfilled: the matcher fills it in as entries are read.
    name: '122_event_trip_link',
    up: async (db) => {
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS trip_id text REFERENCES trips(id) ON DELETE SET NULL`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS trip_link text`.execute(db);
    },
  },
  {
    // When a calendar's pull last listed its whole window from scratch. A
    // Google delta never moves the window, so the pull re-lists once a day to
    // bring in occurrences that have come inside it. NULL = re-list next pass.
    name: '123_calendar_full_synced_at',
    up: async (db) => {
      await sql`ALTER TABLE calendar_sources ADD COLUMN IF NOT EXISTS full_synced_at text`.execute(db);
    },
  },
  {
    // ADR 0299 — where a user is in a chat skill (onboarding, plan my day).
    // One row per user and skill: starting again resumes or resets it. Holds
    // step ids only, never answers — those go to the tools that save them.
    name: '124_skill_runs',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS skill_runs (
        id          text PRIMARY KEY,
        user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id    text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        skill_id    text NOT NULL,
        status      text NOT NULL CHECK (status IN ('active', 'paused', 'done', 'stopped')),
        step_id     text,
        answered    jsonb NOT NULL DEFAULT '[]'::jsonb,
        skipped     jsonb NOT NULL DEFAULT '[]'::jsonb,
        started_at  text NOT NULL,
        updated_at  text NOT NULL,
        UNIQUE (user_id, skill_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS skill_runs_group_active
        ON skill_runs (group_id, user_id) WHERE status = 'active'`.execute(db);
    },
  },
  {
    // ADR 0300 — skills stored as data, picked up without a deploy. One row
    // per skill (the current definition), and every saved version beside it
    // so a bad edit can be rolled back.
    name: '125_skill_definitions',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS skill_definitions (
        id          text PRIMARY KEY,
        definition  jsonb NOT NULL,
        enabled     integer NOT NULL DEFAULT 1,
        version     integer NOT NULL,
        updated_at  text NOT NULL,
        updated_by  text
      )`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS skill_definition_versions (
        skill_id    text NOT NULL,
        version     integer NOT NULL,
        definition  jsonb NOT NULL,
        created_at  text NOT NULL,
        created_by  text,
        PRIMARY KEY (skill_id, version)
      )`.execute(db);
    },
  },
  {
    // When the background mail and calendar sweeps last took this user,
    // whatever came of it. The sweeps ordered by the last SUCCESSFUL sync,
    // which never moves for a failing user or one without the mailbox or
    // scope, so those came first on every tick, ahead of everyone else.
    name: '126_users_swept_at',
    up: async (db) => {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS mail_swept_at text`.execute(db);
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_swept_at text`.execute(db);
    },
  },
  {
    // Indexes for queries that ran as sequential scans on every sync/tick.
    name: '127_hot_path_indexes',
    up: async (db) => {
      // recomputeThread reads a thread's messages by (user, provider thread id).
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_user_gthread
        ON email_messages (user_id, gmail_thread_id)`.execute(db);
      // Email provenance lookups: equality, IN, and the `LIKE 'gmail:%'`
      // prefix. text_pattern_ops lets a prefix LIKE use the index under a
      // non-C collation and still serves equality.
      await sql`CREATE INDEX IF NOT EXISTS idx_proposals_user_provenance
        ON proposals (proposed_by_user_id, provenance text_pattern_ops)
        WHERE provenance IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_source_raw_context
        ON tasks (source_raw_context, created_by)
        WHERE source_raw_context IS NOT NULL`.execute(db);
      // Not partial: the briefing dedup reads fired rows too.
      await sql`CREATE INDEX IF NOT EXISTS idx_proactive_messages_kind_persona
        ON proactive_messages (kind, persona_id)`.execute(db);
      // The body backfill's real predicate (body_excerpt, not body_html);
      // the old index matched nothing that queried it.
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_body_excerpt_missing
        ON email_messages (user_id, internal_date DESC)
        WHERE body_text IS NULL AND body_excerpt IS NULL`.execute(db);
      await sql`DROP INDEX IF EXISTS idx_email_messages_body_missing`.execute(db);
    },
  },
  {
    // A body showing `cid:` images whose stored parts carry no Content-ID is
    // re-read on open, once (ADR 0198's upgrade for older rows). Nothing
    // recorded that it had been done, so a part list that has no Content-ID
    // even after the re-read was read again on every open, and Gmail gave its
    // attachments new ids each time - downloads by the reader's ids 404'd.
    name: '128_email_messages_cid_parts_checked',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS cid_parts_checked integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // Whether a message has a downloadable file, in the clear beside the
    // sealed part list, so the email list can show a paperclip. NULL until
    // known; existing rows are filled by fillAttachmentFlags after a sync.
    name: '129_email_messages_has_attachments',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS has_attachments integer`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_messages_attachment_flag_missing
        ON email_messages (user_id) WHERE has_attachments IS NULL AND attachments_json IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0301 — a reported message in a shared chat. The text and file name
    // are copied as they were, so the report still says what was reported
    // after the message is deleted. One report per person per message.
    name: '130_content_reports',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS content_reports (
        id                 text PRIMARY KEY,
        reporter_user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id   text REFERENCES users(id) ON DELETE SET NULL,
        group_id           text REFERENCES groups(id) ON DELETE SET NULL,
        message_id         text NOT NULL,
        message_body       text NOT NULL,
        attachment_name    text,
        reason             text,
        created_at         text NOT NULL,
        emailed_at         text,
        email_attempts     integer NOT NULL DEFAULT 0,
        last_attempt_at    text,
        last_error         text,
        UNIQUE (reporter_user_id, message_id)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS content_reports_unsent
        ON content_reports (created_at) WHERE emailed_at IS NULL`.execute(db);
    },
  },
  {
    // ADR 0303 - a draft's copy in the mailbox's own Drafts folder. `provider_ref`
    // is the provider's handle for that copy (Gmail draft id, Graph message id,
    // IMAP `<folder>\n<uidvalidity>\n<uid>`), `provider_mailbox` the mailbox it
    // lives in ('primary' or an account id) so a From change moves it. A copy
    // whose Chord draft is gone waits in `email_provider_draft_removals` until
    // the provider has deleted it too.
    name: '131_email_provider_drafts',
    up: async (db) => {
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_ref text`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_mailbox text`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_synced_at text`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_attempts integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_retry_at text`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_error text`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS email_provider_draft_removals (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_mailbox text NOT NULL,
        provider_ref text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        retry_at text NOT NULL,
        created_at text NOT NULL
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_email_provider_draft_removals_due
        ON email_provider_draft_removals (retry_at)`.execute(db);
    },
  },
  {
    // ADR 0112 addendum: a forward draft remembers WHICH message it passes on
    // (the one selected in the reader, or pinned on a chat card). NULL = the
    // thread's newest, which is what every existing forward draft meant.
    // 130 is held by an open PR (#164).
    name: '132_email_drafts_forward_message',
    up: async (db) => {
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS forward_message_id text`.execute(db);
    },
  },
  {
    // ADR 0312: a person made from a mailbox's mail is removed when that
    // mailbox is disconnected, so it records the email it came from. NULL =
    // typed, chatted, or made before this (no backfill: nothing says which).
    name: '133_people_provenance',
    up: async (db) => {
      await sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS provenance text`.execute(db);
    },
  },
  {
    // ADR 0314: an email to-do that is a reply to the sender is done once the
    // user replies.
    name: '134_tasks_closes_on_reply',
    up: async (db) => {
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS closes_on_reply integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // Repeating-event occurrences stored with the offset the old one-pass
    // conversion gave around a clock change (PR 220). Data only, idempotent.
    name: '135_series_clock_change_offsets',
    up: async (db) => {
      await repairSeriesOffsets(db);
    },
  },
  {
    // ADR 0311 addendum: a write the app may send twice (a queued send retried
    // after the first answer was lost) carries an id; the first answer is kept
    // here and returned to the repeat instead of doing it again.
    name: '136_client_requests',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS client_requests (
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key text NOT NULL,
        status integer,
        body text,
        created_at text NOT NULL,
        PRIMARY KEY (user_id, key)
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS client_requests_created_at ON client_requests (created_at)`.execute(db);
    },
  },
  {
    // Audit fixes: a proactive row whose render fails backs off instead of
    // retrying every tick, plus indexes for reads that scanned. Additive only;
    // plain (not CONCURRENTLY) like every other migration here, since a failed
    // concurrent build leaves an INVALID index that IF NOT EXISTS then skips.
    name: '137_audit_indexes',
    up: async (db) => {
      await sql`ALTER TABLE proactive_messages ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE proactive_messages ADD COLUMN IF NOT EXISTS retry_after text`.execute(db);
      // listProposalsForGroup/ForUser: newest first per group, LIMIT 200;
      // (group_id, status) still sorted every row of the group.
      await sql`CREATE INDEX IF NOT EXISTS idx_proposals_group_created
        ON proposals (group_id, created_at)`.execute(db);
      // listMessages attaches each visible message's hidden bot reply by
      // reply_to_id IN (...): it scanned the whole group's history.
      await sql`CREATE INDEX IF NOT EXISTS idx_messages_reply_to
        ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL`.execute(db);
      // The incidental-attachment expiry sweep, every proactive tick.
      await sql`CREATE INDEX IF NOT EXISTS idx_attachments_incidental_created
        ON attachments (created_at)
        WHERE origin_email_thread_id IS NOT NULL AND pinned = 0`.execute(db);
      // ON DELETE SET NULL foreign keys with no index: every email-thread
      // delete scanned attachments, every attachment delete scanned legs and
      // stays. The legs/stays ones also feed the itinerary expiry sweep.
      await sql`CREATE INDEX IF NOT EXISTS idx_attachments_origin_thread
        ON attachments (origin_email_thread_id) WHERE origin_email_thread_id IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_travel_legs_source_doc
        ON travel_legs (source_doc_id) WHERE source_doc_id IS NOT NULL`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_accommodations_source_doc
        ON accommodations (source_doc_id) WHERE source_doc_id IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0314: an automatic reply the user's mailbox sent (Chord's vacation
    // responder, or any message carrying Auto-Submitted) is not the user
    // answering, so it must not close a "reply to ..." to-do.
    name: '138_email_messages_auto_reply',
    up: async (db) => {
      await sql`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS auto_reply integer NOT NULL DEFAULT 0`.execute(db);
    },
  },
  {
    // ADR 0318 - inviting someone to a chat by their email address. `group_id`
    // NULL = a direct chat with someone already on Chord, made on accept.
    // `direct` = 1 marks a two-person chat (made up front for an emailed
    // invite so its join link exists; it becomes the pair chat on join).
    name: '139_chat_invites',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS chat_invites (
        id text PRIMARY KEY,
        inviter_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email text NOT NULL,
        invitee_user_id text REFERENCES users(id) ON DELETE CASCADE,
        group_id text REFERENCES groups(id) ON DELETE CASCADE,
        direct integer NOT NULL DEFAULT 0,
        message text,
        message_posted integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
        created_at text NOT NULL,
        responded_at text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_chat_invites_invitee
        ON chat_invites (invitee_user_id) WHERE status = 'pending'`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_chat_invites_email
        ON chat_invites (lower(email)) WHERE status = 'pending'`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_chat_invites_pair
        ON chat_invites (inviter_id, invitee_user_id) WHERE status = 'accepted'`.execute(db);
    },
  },
  {
    // ADR 0324 — every model call made on Chord's key for a user records its
    // tokens, so the allowance (ADR 0196) counts the briefing, nudges, memory
    // extraction, attachment reading, upload classifiers, form filling,
    // meeting context and WhatsApp import, not only chat and email.
    name: '140_token_usage_all_sources',
    up: async (db) => {
      await sql`ALTER TABLE token_usage
        DROP CONSTRAINT IF EXISTS token_usage_source_check`.execute(db);
      await sql`ALTER TABLE token_usage
        ADD CONSTRAINT token_usage_source_check
        CHECK (source IN ('bot_turn','email_classify','email_magics','email_persons','email_reply','email_summary','embedding','memory_cleanup','briefing','nudge','memory_extract','attachment_read','content_classify','trip_classify','form_fill','meeting_context','whatsapp_import'))`.execute(db);
    },
  },
  {
    // ADR 0326 - a picture in a pasted signature is kept by Chord and served
    // from a public, unguessable link, so every recipient can load it. Not
    // sealed: it goes out in mail to anyone the user writes to.
    name: '141_signature_images',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS signature_images (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mime text NOT NULL,
        bytes bytea NOT NULL,
        sha256 text NOT NULL,
        created_at text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_images_user_sha
        ON signature_images (user_id, sha256)`.execute(db);
    },
  },
  {
    // AI work held back for consent or allowance, re-run once both are met.
    name: '142_ai_backlog',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS ai_backlog (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('attachment', 'whatsapp_import', 'meeting_context', 'memory_message')),
        ref text NOT NULL,
        payload text,
        checked_at text,
        created_at text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_backlog_work
        ON ai_backlog (user_id, kind, ref)`.execute(db);
    },
  },
  {
    // ADR 0328 — a member's row for a group event they were INVITED to (not
    // given a copy of): the address invited, how (organizer's calendar or a
    // mailed iTIP request), and the UID the invitation arrives under, which
    // their calendar pull matches. `guest_notice_due` = the next push of
    // this row should notify its guests (a time/place change).
    name: '143_family_event_invites',
    up: async (db) => {
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS invite_email text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS invite_via text
        CHECK (invite_via IN ('calendar', 'mail'))`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS invite_uid text`.execute(db);
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS guest_notice_due integer NOT NULL DEFAULT 0`.execute(db);
      // On the organizer's row: everyone on the event and their answer, as
      // the calendar (or a mailed reply) last reported it. JSON array of
      // { email, response }.
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS guest_answers text`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_events_owner_invite_uid
        ON events (owner_user_id, invite_uid) WHERE invite_uid IS NOT NULL`.execute(db);
    },
  },
  {
    // ADR 0303 addendum - when the provider copy of a draft was last checked
    // for having been deleted in another mail app.
    name: '144_email_drafts_provider_checked',
    up: async (db) => {
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS provider_checked_at text`.execute(db);
    },
  },
  {
    // ADR 0223 addendum - the guests (and organizer) the calendar lists for a
    // pulled event, lowercased. Read-only copy for "same time, same people =
    // one meeting"; never sent back, the provider keeps the list (ADR 0295).
    name: '145_event_guest_emails',
    up: async (db) => {
      await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS guest_emails jsonb`.execute(db);
    },
  },
  {
    // ADR 0332 - the dollars each model call cost (OpenRouter reports it) and
    // how many prompt tokens were read from cache. Older rows stay null.
    name: '146_token_usage_cost',
    up: async (db) => {
      await sql`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS cached_tokens integer`.execute(db);
      await sql`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS cost_usd double precision`.execute(db);
    },
  },
  {
    // ADR 0289 addendum - a family member on a trip who has no Chord account
    // (a managed persona). `trip_participants` holds user ids only, and a trip
    // with no tickets had nowhere else to say who is going.
    name: '147_trip_named_travelers',
    up: async (db) => {
      // Anyone said to be on a trip who has no account in its group - a
      // family member (persona_id set) or a friend (a name only).
      await sql`CREATE TABLE IF NOT EXISTS trip_named_travelers (
        trip_id     text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        name_key    text NOT NULL,
        name        text NOT NULL,
        persona_id  text REFERENCES personas(id) ON DELETE SET NULL,
        PRIMARY KEY (trip_id, name_key)
      )`.execute(db);
    },
  },
  {
    // ADR 0335 - Chord as an OAuth 2.1 authorization server for its MCP
    // connector (Claude, ChatGPT). Every secret (client secret, auth code,
    // access and refresh token) is stored as `h_<sha256>`, never itself
    // (ADR 0269's rule for sessions).
    name: '148_connector_oauth',
    up: async (db) => {
      // A client that registered itself (RFC 7591). `secret_hash` null = a
      // public client that proves itself with PKCE alone.
      await sql`CREATE TABLE IF NOT EXISTS oauth_clients (
        id                  text PRIMARY KEY,
        secret_hash         text,
        name                text NOT NULL,
        client_uri          text,
        redirect_uris       jsonb NOT NULL,
        created_at          text NOT NULL
      )`.execute(db);
      // One authorization attempt: made at /authorize, answered on the
      // consent page, then a code that is spent once at /token.
      await sql`CREATE TABLE IF NOT EXISTS oauth_requests (
        id                  text PRIMARY KEY,
        client_id           text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
        redirect_uri        text NOT NULL,
        code_challenge      text NOT NULL,
        state               text,
        scope               text NOT NULL,
        resource            text,
        created_at          text NOT NULL,
        expires_at          text NOT NULL,
        user_id             text REFERENCES users(id) ON DELETE CASCADE,
        code_hash           text UNIQUE,
        code_expires_at     text,
        used_at             text
      )`.execute(db);
      // What a user allowed one client to do. Revoking it ends every token.
      await sql`CREATE TABLE IF NOT EXISTS oauth_grants (
        id                  text PRIMARY KEY,
        user_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id           text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
        scope               text NOT NULL,
        created_at          text NOT NULL,
        last_used_at        text,
        revoked_at          text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants (user_id)`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash          text PRIMARY KEY,
        grant_id            text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
        kind                text NOT NULL CHECK (kind IN ('access', 'refresh')),
        created_at          text NOT NULL,
        expires_at          text NOT NULL,
        rotated_at          text
      )`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id)`.execute(db);
    },
  },
  {
    // ADR 0339 - how a draft was written. NULL format = a draft from before the
    // Plain / Rich switch; body_html (sealed like body) only for 'rich'.
    name: '149_email_drafts_format',
    up: async (db) => {
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS body_format text`.execute(db);
      await sql`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS body_html text`.execute(db);
    },
  },
  {
    // ADR 0342 — one-way fingerprints of a deleted account's sign-in
    // identities, so an account made again with any of them starts with no
    // free tokens. No FK: the account they came from is gone.
    name: '150_spent_free_allowances',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS spent_free_allowances (
        fingerprint text PRIMARY KEY,
        created_at text NOT NULL
      )`.execute(db);
    },
  },
  {
    // ADR 0346 - the scheduling block the email suggestion pass reads.
    name: '151_email_scheduling_json',
    up: async (db) => {
      await sql`ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS scheduling_json jsonb`.execute(db);
    },
  },
  {
    // ADR 0346 phase 3 - one meeting followed across its scheduling thread.
    // Addresses, state and instants are plaintext (recipients are readable by
    // design, ADR 0201); what the email said (title, quoted times, place) is
    // sealed in facts_json.
    name: '152_meetings',
    up: async (db) => {
      await sql`CREATE TABLE IF NOT EXISTS meetings (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_key text NOT NULL,
        state text NOT NULL CHECK (state IN ('offered','proposed','agreed','invited','answered','cancelled')),
        core_people jsonb NOT NULL DEFAULT '[]',
        not_core jsonb NOT NULL DEFAULT '[]',
        invite_by text NOT NULL DEFAULT 'unknown' CHECK (invite_by IN ('them','me','unknown')),
        agreed_start text,
        agreed_end text,
        invite_uid text,
        event_id text,
        facts_json jsonb,
        read_through text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_user_thread ON meetings (user_id, thread_key)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS ix_meetings_user_state ON meetings (user_id, state)`.execute(db);
    },
  },
  {
    // ADR 0346 phase 4 - the user stopped holding this meeting's slot.
    name: '153_meetings_hold_dropped',
    up: async (db) => {
      await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS hold_dropped_at text`.execute(db);
    },
  },
];

/**
 * ADR 0249 — copy every receipt already on a thread into `email_receipts`.
 * `account_id` is not a foreign key: the receipt outlives a removed mailbox
 * too, and keeps the address it arrived at. Idempotent.
 */
export async function copyThreadReceipts(db: ReturnType<typeof openDb>): Promise<void> {
  await sql`INSERT INTO email_receipts
      (id, user_id, gmail_thread_id, receipt_json, from_name, from_email,
       account_id, mailbox, email_at, created_at)
    SELECT 'rcpt_' || t.id, t.user_id, t.gmail_thread_id, t.receipt_json, t.from_name, t.from_email,
           t.account_id, COALESCE(a.email_address, u.email), t.last_message_at, t.last_message_at
    FROM email_threads t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN email_accounts a ON a.id = t.account_id
    WHERE t.receipt_json IS NOT NULL
    ON CONFLICT (user_id, gmail_thread_id) DO NOTHING`.execute(db);
}

export async function normalizeProactiveScheduledFor(
  db: ReturnType<typeof openDb>,
): Promise<void> {
  await sql`
    UPDATE proactive_messages
    SET scheduled_for = to_char(
      scheduled_for::timestamptz AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
    WHERE fired_at IS NULL
      AND scheduled_for ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}.*[+-]\\d{2}:?\\d{2}$'
  `.execute(db);
}

/**
 * ADR 0200 — re-key the Google-link unique index by owner, then drop the sync
 * cursor on every calendar more than one user subscribes to: a pull under the
 * global index lost those users' items to a collision and still saved its
 * cursor, so later deltas never re-sent them. A cleared cursor makes the next
 * pull a full window sync, which is idempotent against rows that did land.
 */
export async function scopeGcalIdentityPerOwner(
  db: ReturnType<typeof openDb>,
): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_events_gcal_event`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_events_owner_gcal_event
      ON events (owner_user_id, google_calendar_id, gcal_event_id)
      WHERE google_calendar_id IS NOT NULL AND gcal_event_id IS NOT NULL
  `.execute(db);
  await sql`
    UPDATE calendar_sources SET sync_token = NULL
    WHERE provider = 'google'
      AND sync_token IS NOT NULL
      AND google_calendar_id IN (
        SELECT google_calendar_id FROM calendar_sources
        WHERE provider = 'google'
        GROUP BY google_calendar_id
        HAVING count(DISTINCT user_id) > 1
      )
  `.execute(db);
}


/**
 * ADR 0040 contract phase (safe subset), extracted + idempotent for testing.
 * Re-backfills any null identity, dedups rows that already collide on the
 * Google link, then enforces it with a partial unique index.
 */
export async function hardenCalendarIdentity(
  db: ReturnType<typeof openDb>,
): Promise<void> {
  // Safety re-backfill: catches any row inserted with a null identity between
  // 005 and now (005 already did this for the rows present then).
  await sql`UPDATE events SET ical_uid = COALESCE(external_uid, id) WHERE ical_uid IS NULL`.execute(db);
  await sql`UPDATE events SET owner_user_id = created_by
              WHERE owner_user_id IS NULL AND created_by IS NOT NULL`.execute(db);

  // The same Google event on the same calendar must be a single row. Older
  // create→push→pull round-trips could leave a duplicate (the reason
  // findEventByGcalId exists); drop the extras (keep the newest ctid) before
  // the unique index, or its creation would fail on legacy data.
  await sql`
    DELETE FROM events a USING events b
    WHERE a.google_calendar_id IS NOT NULL
      AND a.gcal_event_id IS NOT NULL
      AND a.google_calendar_id = b.google_calendar_id
      AND a.gcal_event_id = b.gcal_event_id
      AND a.ctid < b.ctid
  `.execute(db);

  // Partial: the many rows with no Google link yet (Chord-native, not-yet-pushed)
  // stay unconstrained — only a real (calendar, event-id) pair is enforced.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_events_gcal_event
      ON events (google_calendar_id, gcal_event_id)
      WHERE google_calendar_id IS NOT NULL AND gcal_event_id IS NOT NULL
  `.execute(db);
}

/**
 * ADR 0040 §7 — backfill: for every legacy single-copy **group** event, create
 * one visibility copy per other current group member. Extracted + idempotent so
 * it can be unit-tested against seeded rows.
 *
 * Scope guards: only fan out from the authoritative `organizer` copy, only
 * unassigned shared events (a delegated `assignee_id` event stays single-owner,
 * per the fan-out trigger), and only non-personal groups (a personal group /
 * pulled Google event is never fanned out). The copies are in-app visibility
 * rows only — `local_dirty=0`, `gcal_sync_status='synced'`, no `chord_uid`,
 * no `google_calendar_id` — so the migration never writes to anyone's Google;
 * new events created after this migration fan out with a real per-owner push.
 */
export async function backfillCalendarFanout(
  db: ReturnType<typeof openDb>,
): Promise<void> {
  await sql`
    INSERT INTO events (
      id, group_id, title, location, starts_at, ends_at, created_by, created_at,
      source_raw_context, external_uid, assignee_id, transparency,
      owner_user_id, organizer_user_id, role, ical_uid, chord_uid, group_ids,
      google_calendar_id, description, start_tz, end_tz, all_day, status,
      sequence, updated_at, local_dirty, gcal_sync_status
    )
    SELECT
      'e_bf_' || e.id || '_' || gm.user_id,
      e.group_id, e.title, e.location, e.starts_at, e.ends_at, e.created_by, e.created_at,
      e.source_raw_context, NULL, NULL, e.transparency,
      gm.user_id, e.organizer_user_id, 'attendee', e.ical_uid, NULL, e.group_ids,
      NULL, e.description, e.start_tz, e.end_tz, e.all_day, e.status,
      e.sequence, e.updated_at, 0, 'synced'
    FROM events e
    JOIN groups g ON g.id = e.group_id AND g.kind <> 'personal'
    JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id <> e.owner_user_id
    WHERE e.role = 'organizer'
      AND e.assignee_id IS NULL
      AND e.deleted_at IS NULL
      AND e.status <> 'cancelled'
      AND e.owner_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events x
        WHERE x.ical_uid = e.ical_uid AND x.owner_user_id = gm.user_id
      )
  `.execute(db);
}

/**
 * ADR 0040 expand-phase backfill, extracted from migration 005 so it can be
 * unit-tested against seeded legacy rows. Every statement is idempotent and
 * guarded (so re-running is a no-op, and it correctly processes legacy-shaped
 * rows inserted after the migration). The migration calls it once at the end
 * of its DDL; the test calls it on hand-seeded events + rsvps.
 */
export async function backfillCalendarTwoWaySync(
  db: ReturnType<typeof openDb>,
): Promise<void> {
  // group_ids ← the single group_id (append-only visibility set going forward).
  await sql`UPDATE events SET group_ids = jsonb_build_array(group_id)
              WHERE group_ids = '[]'::jsonb`.execute(db);
  // ical_uid ← external_uid when present (ICS UID / gcal id), else the row id
  // (Chord-native events had no external id).
  await sql`UPDATE events SET ical_uid = COALESCE(external_uid, id) WHERE ical_uid IS NULL`.execute(db);
  // chord_uid only for events we authored (no external provenance).
  await sql`UPDATE events SET chord_uid = id WHERE chord_uid IS NULL AND external_uid IS NULL`.execute(db);
  // owner / organizer ← creator (creator is the organizer of their own copy).
  await sql`UPDATE events SET owner_user_id = created_by WHERE owner_user_id IS NULL`.execute(db);
  await sql`UPDATE events SET organizer_user_id = created_by WHERE organizer_user_id IS NULL`.execute(db);
  // updated_at ← created_at (best available signal for the LWW tiebreak).
  await sql`UPDATE events SET updated_at = created_at WHERE updated_at IS NULL`.execute(db);
  // all_day ← the floating-midnight convention the read pipeline writes for
  // all-day events (`YYYY-MM-DDT00:00:00`, no Z/offset).
  // [0-9] not \d: a JS template literal would swallow the backslash in `\d`.
  await sql`UPDATE events SET all_day = 1
              WHERE all_day = 0 AND starts_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00$'`.execute(db);

  // Attendees from rsvps. The new row id reuses the rsvp id (already unique)
  // with an `ea_` prefix. RSVP status maps onto the RFC5545 response
  // vocabulary; the attendee is the organizer when their user matches the
  // event creator.
  await sql`INSERT INTO event_attendees
              (id, ical_uid, user_id, email, display_name, role,
               response_status, is_organizer, solo, dish, notes, updated_at)
            SELECT 'ea_' || r.id, e.ical_uid, r.user_id, u.email, r.display_name,
                   'editor',
                   CASE r.status
                     WHEN 'yes'   THEN 'accepted'
                     WHEN 'no'    THEN 'declined'
                     WHEN 'maybe' THEN 'tentative'
                     ELSE 'needsAction'
                   END,
                   CASE WHEN r.user_id IS NOT NULL AND r.user_id = e.created_by THEN 1 ELSE 0 END,
                   r.solo, r.dish, r.notes, r.updated_at
            FROM rsvps r
            JOIN events e ON e.id = r.event_id
            LEFT JOIN users u ON u.id = r.user_id
            WHERE e.ical_uid IS NOT NULL
            ON CONFLICT DO NOTHING`.execute(db);
}

/**
 * Apply pending migrations against an externally-owned db handle. Used by
 * `runMigrations()` (production boot) and by integration tests against a
 * per-suite Postgres schema — neither opens nor closes the db, that's
 * the caller's job.
 */
export async function applyMigrations(
  db: ReturnType<typeof openDb>,
): Promise<void> {
  // ADR 0172 — the web and worker roles are separate processes that both
  // call this at boot, so two callers can race: both read `done` as empty
  // and both try to apply the same migration, the second insert losing to
  // the `_migrations.name` unique constraint. A session-scoped advisory
  // lock (not `_xact_` — this run spans many independent statements, not
  // one transaction) serializes the two rather than letting either crash.
  await sql`SELECT pg_advisory_lock(hashtext('chord_migrations'), 0)`.execute(db);
  try {
    // `integer` (not bigint) keeps the generated `_pk` returning as a JS
    // number through node-pg's default type parsers; schema.ts types it as
    // `Generated<number>` and we never expect billions of migrations.
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      _pk         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name        text NOT NULL UNIQUE,
      applied_at  text NOT NULL
    )`.execute(db);

    const done = new Set(
      (await db.selectFrom('_migrations').select('name').execute()).map((r) => r.name),
    );

    for (const m of migrations) {
      if (done.has(m.name)) continue;
      logger.info(`applying migration ${m.name}`);
      await m.up(db);
      await db
        .insertInto('_migrations')
        .values({ name: m.name, applied_at: new Date().toISOString() })
        .execute();
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('chord_migrations'), 0)`.execute(db);
  }
}

export async function runMigrations(): Promise<void> {
  const db = openDb();
  try {
    await applyMigrations(db);
    logger.info('migrations up to date');
  } finally {
    await db.destroy();
  }
}

// `npm run migrate` (tsx src/db/migrate.ts) executes this file directly. Compare
// via pathToFileURL so the guard matches on Windows too — a raw
// `file://${process.argv[1]}` yields `file://C:\…` (backslashes) which never
// equals import.meta.url's `file:///C:/…`, so migrations silently no-op'd there.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
