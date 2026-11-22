# Legacy SQLite migrations (frozen)

> **Status:** historical reference. See [ADR 0038](./0038-sqlite-to-postgres.md).
> The 46-entry migration list that took us from `001_init` through
> `045_user_nudge_schedule` on SQLite was squashed into the single
> `001_pg_init` migration in `server/src/db/migrate.ts` at the Postgres
> cutover. This file exists so future readers can see what each step
> contributed without spelunking through `git log`.

The actual TypeScript array is preserved verbatim in git — read it at:

```
git show deb0bd0c:server/src/db/migrate.ts
```

(SHA `deb0bd0c` is the file just before the squash. The commit that
introduces this archive lands ADR 0038's commit 1.)

## Migration list (for grep-ability)

```
001_init                                — core tables: users, sessions, groups, group_members,
                                          messages, attachments, lists, list_items, events, rsvps,
                                          places, contacts, media_items, memories, document_permissions,
                                          tasks, proactive_messages
002_memories                            — memories.status (proposed/confirmed), memories indexes
003_document_permissions                — granular document_permissions table (already in 001? no — added here)
004_proactive_and_task_status           — rebuild tasks with new statuses; proactive indexes
005_trips                               — trips, trip_participants, travel_legs, accommodations
006_identity_tier                       — group_members.tier
007_whatsapp_import                     — messages.source / external_message_id
008_trip_reservations                   — trip_reservations table
009_memory_proposal_status              — memories.status default 'confirmed'
010_proposals_table                     — proposals (ADR 0009)
011_connectors                          — external_identities, group_external_channels
012_connector_pairings                  — pending_connector_pairings
013_travel_leg_passenger_name           — travel_legs.passenger_name
013_connector_alias                     — group_external_channels.alias (note: duplicate "013" prefix
                                          was a real ordering bug we left in for history)
014_bridge_mirror_policy                — groups.mirror_inbound, messages.chord_visible/mentions_others
015_auto_mirror_flag                    — messages.auto_mirror
016_message_cards                       — message_cards (ADR 0019)
017_events_external_uid                 — events.external_uid + unique partial index
018_google_identity                     — users.google_sub + email + refresh_token_*
019_attachment_image_meta               — attachments.image_meta
020_google_calendar_synced_at           — users.google_calendar_id / google_calendar_synced_at
021_user_settings                       — users.listening_mode, about_me, model_* fields
022_people_and_important_dates          — people, important_dates (ADR 0016)
023_cross_group_personal_context        — users.cross_group_personal_context (default 1 here, flipped in 043)
024_attachment_fts5                     — attachment_chunks FTS5 virtual table + attachment_chunk_meta;
                                          also backfilled via indexAttachmentChunks (now obsolete)
025_catchup_folders                     — catchup_folders, catchup_assignments (ADR 0024)
026_events_ends_at                      — events.ends_at
027_group_member_last_read_at           — group_members.last_read_at
028_saves_kind_contact                  — saves table (CHECK extended in 028 to add 'contact')
029_forms                               — forms table (ADR 0025)
030_connector_byo_tokens                — group_external_channels.bot_*; pending_pairings.bot_*
031_user_model_base_url                 — users.model_base_url
032_events_gcal_sync                    — events.gcal_* sync columns
033_trust_and_assignment                — trusted_senders, permission_requests, events.assignee_id (ADR 0026)
034_bot_personas                        — bot_personas (ADR 0027); group_members.tier already there
035_user_last_tz                        — users.last_tz
036_connector_dm_greeted                — connector_dm_greeted (per-platform DM greet log)
037_signup_intents_and_dm_state         — signup_intents; connector_dm_greeted.state
038_outbound_connector_messages         — outbound_connector_messages (ADR 0029)
039_waitlist                            — waitlist table
040_signup_intents_email_nullable       — signup_intents.email nullable (ADR 0031)
041_messages_is_proactive               — messages.is_proactive (ADR 0032)
042_calendar_sources_and_event_transp   — events.transparency; calendar_sources (ADR 0033)
043_cross_group_default_off             — flip cross_group_personal_context default 1 → 0
044_user_name_fields                    — users.first_name / last_name / preferred_name
045_user_nudge_schedule                 — users.nudge_hour / nudge_minute / nudge_enabled (ADR 0034)
```

If you need to recreate a specific schema-version SQLite database for a
data-migration replay or a bug bisect, check out the commit at or before
the migration's introduction and run `npm run migrate` against an empty
file. After commit-1b lands, this file can be deleted.
