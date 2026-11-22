# 0043 — Account deletion

**Status**: accepted
**Date**: 2026-06-04
**Relates to**: [ADR 0014 — Google-only auth](./0014-google-only-auth.md), [ADR 0016 — Family graph](./0016-family-graph-in-sqlite.md), [ADR 0037 — File management + delete](./0037-file-management-and-delete.md), [ADR 0038 — SQLite → Postgres](./0038-sqlite-to-postgres.md)

## Context

Settings let a user disconnect their Google Calendar and sign out, but there
was no way to **delete their account** — remove the user and the data tied to
them, and revoke Chord's Google access. This is table stakes for a real signup
flow (and required by app-store / privacy policy).

The data model makes this non-trivial. A user is referenced from ~30 columns
across the schema, with three different `ON DELETE` behaviors:

- **`CASCADE`** — sessions, group_members, calendar_sources, external_identities,
  catchup_*, document_permissions(user_id), pending_connector_pairings,
  trip_participants. A `DELETE FROM users` cleans these automatically.
- **`SET NULL`** — memories.persona_id, proactive_messages.persona_id,
  travel_legs.persona_id.
- **bare `REFERENCES users(id)`** (delete-blocking) — `groups.created_by`,
  `attachments.uploaded_by`, `people.owner_user_id` (all `NOT NULL`), plus the
  nullable provenance columns `created_by` / `assignee_id` / `sender_id` /
  `owner_user_id` on tasks, lists, saves, events, places, contacts, media,
  trips, proposals, forms, rsvps, event_attendees.

So a single `DELETE FROM users` is rejected by the FK layer; deletion has to be
an ordered teardown. Two product questions also had to be settled:

1. **Shared groups.** A user is often in a Family group with others. Deleting
   their account must not destroy that group's shared data.
2. **Google.** "Clear Google authentication" should mean the grant disappears
   from the user's Google account, not just from our DB.

## Decision

A single transactional service, `deleteAccount(db, userId)`
(`server/src/services/account.service.ts`), behind
`DELETE /api/v1/me` (`requireSession`). It tears down in dependency order:

1. **Reassign shared groups.** For each group the user belongs to that has
   other members, hand `groups.created_by` (and, if the user was an owner, the
   `group_members.role`) to the earliest-joined remaining member. The group
   survives.
2. **Reassign shared files.** `attachments.uploaded_by` is `NOT NULL`, so files
   the user uploaded into a kept group are reassigned to that group's new owner
   rather than deleted — other members may rely on them.
3. **Delete solo-owned groups.** Groups where the user is the only member
   (always includes their personal group). `group_id … ON DELETE CASCADE`
   sweeps all content (messages, tasks, lists, events, memories, trips, …).
4. **Delete solo-owned attachments.** Attachment scope is polymorphic (no group
   FK cascade), so personal (`scope_kind='user'`) files and any files left in
   the deleted groups are removed via the path-aware `deleteAttachment` helper
   (ADR 0037 — drops FTS chunks, unlinks disk only when unshared).
5. **Anonymize the rest.** In the *kept* (shared) groups, `NULL` out the
   nullable provenance columns pointing at the user. Rows in deleted groups are
   already gone, so this only touches shared-group rows.
6. **Delete `people`** owned by the user (cascades `important_dates`).
7. **Delete trust/permission rows** (they reference the user without a DB FK).
8. **`DELETE FROM users`** — the `CASCADE` / `SET NULL` columns finish up.

**Google revocation** runs best-effort *before* the transaction
(`revokeGoogleTokens` POSTs the stored refresh token to Google's `/revoke`
endpoint). Failure is swallowed and logged — the token is wiped with the user
row regardless, so a network blip must never strand a half-deleted account.

**Shared-group policy: keep + anonymize.** We never delete another member's
data. The departing user's authorship is removed (nulled), and ownership of
anything `NOT NULL` (the group itself, its files) is handed to a remaining
member. This was chosen over (a) deleting the user's items from shared groups
— removes content others depend on — and (b) deleting groups the user created
— destroys all members' data.

**UI: type-to-confirm.** The Settings danger zone requires typing `DELETE`
before the button enables (stronger than the two-tap native dialog used for
calendar disconnect), because the action is irreversible and wide-reaching.

## Consequences

- Past chat messages by a deleted user in a kept group render with no sender
  ("Unknown"); `messages.sender_id` is nulled. Acceptable cost of keeping group
  history intact while honoring deletion.
- The teardown enumerates the nullable provenance columns explicitly
  (`ANONYMIZE` in the service). A new user-referencing column added later must
  be added there (or given `ON DELETE CASCADE`/`SET NULL`), or the final
  `DELETE FROM users` will start failing — covered by the integration test,
  which is the regression guard.
- No tombstone/audit row is kept (no "deleted account" sentinel user). If we
  later need attribution continuity for shared groups, reassign-to-sentinel is
  the natural extension.
- Revocation depends on Google reachability; the in-DB state is always
  consistent regardless of the revoke outcome.
