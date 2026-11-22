# Groups

## Kinds

- **`group`** — multi-person. Invite-code joinable. Bot replies only when `@Chord` is mentioned.
- **`personal`** — exactly one human member. Bot replies on every user message. Auto-created for each user on first sign-in as `{username} · My Chord`.

`kind` is fixed at creation; no conversion path.

## Invite by email (ADR 0318)

The way people are meant to add someone: type their email in "Message someone"
(Messages screen) or a group's settings. Already connected = added at once; on
Chord but not connected = an invite to accept; not on Chord = an email from the
inviter's mailbox with the join link below, and following it accepts. See
`services/chat-invites.service.ts` and [ADR 0318](../notes/0318-a-chat-invite-is-an-email-address.md).

## Invite codes

- 6 characters, uppercase, `nanoid` with alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (confusing chars removed: I/L/O/0/1).
- Stored `UNIQUE` in `groups.invite_code`.
- Submitted via `POST /groups/join { inviteCode }`. The route uppercases before matching, so user typing is forgiving.
- Personal groups have an invite code too, but `joinGroupByCode` rejects attempts to join them (`kind==='personal'`).
- **Not regenerable** yet — if a code leaks, the only mitigation is to create a new group. Add a regenerate endpoint if this matters.

## Ingest email

Deterministic: `{slug(name)}-{idFragment}@chord.app`, e.g. `doe-family-gDxChV@chord.app`. Stored for presentation only; actual SMTP ingestion is not implemented. Planned as a background worker that converts an inbound email → attachment upload under the matching group.

## Membership

Stored in `group_members` (composite PK `group_id, user_id`). `role` is `owner` (creator) or `member`. Gate for every per-group endpoint: `middleware/require-member.ts` responds 403 if the session user is not a member.

## Creator auto-membership

`createGroup` inserts the creator as `role=owner` in the same flow. Atomicity: not a transaction — if the member insert fails, we leave an orphan group. Acceptable for demo; wrap in `db.transaction()` if this ever ships.

## Personal group auto-create

Triggered in `routes/session.ts` when a brand-new user is inserted. Calls `ensurePersonalGroup(db, userId, displayName)` which is idempotent — safe if ever invoked again.

## Things we don't have yet

- **Role changes** — no API to promote / demote members.
- **Kick / ban** — no endpoint.
- **Cross-group context** — a group can't (yet) reference another. The demo flows want this: Chord pulled John's home address from the Doe family group when the Friends group needed it. See [tasks/](../tasks/) design questions.
