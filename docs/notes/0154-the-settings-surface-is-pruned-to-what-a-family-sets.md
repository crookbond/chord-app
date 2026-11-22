# 0154 — The settings surface is pruned to what a family sets

**Status**: accepted
**Date**: 2026-09-09
**Relation**: extends [0078](./0078-settings-redesign-five-sections.md) (settings
redesign). The Telegram half surfaces the `mirror_inbound` flag from
[0055](./0055-bot-only-connector-visibility-follows-mirror.md); it changes no
connector behaviour.

## Context

Three pieces of settings cruft, cleaned in one pass.

**1. "About me"** — a free-text bio box whose derived facts and raw text fed
the bot. Flagged as a leak vector. The extraction leak was already closed:
`extractMemoriesFromAboutMe` hard-forced every fact to the author's **private
personal group** (`subject_type='user'`, ignoring whatever the LLM emitted),
and relation facts staged `add_person` proposals only onto the author's own
People screen. What remained was **redundancy** — the field now overlaps
entirely with "About this family" (shared household/persona facts, per group),
the People screen (private people + learned facts), and simply telling the bot
facts in the 1:1. One residual gap: the raw `about_me` text was injected into
the system prompt for the triggering user in **any** group, not just their 1:1.

**2. Slack / Discord bridges** — never shipping. Still offered in the Settings
"Connected apps" card and each group's bridge picker.

**3. Telegram mirroring** — `groups.mirror_inbound` (per Chord group: 0 =
relay-only, only `@Chord` messages come through; 1 = every bridged message
mirrors in). Set to 1 automatically when the bot is added to a Telegram group,
left at 0 when a Chord group is bridged after the fact — and **frozen there**,
because `PATCH /groups/:id { mirrorInbound }` existed and nothing ever sent it.
No user control, per-group or global.

## Decision

### 1. Delete the "About me" field

Remove the Settings disclosure, the To Do's "About you" memory card,
`PUT /me/about-me`, `extractMemoriesFromAboutMe` + its prompt +
`ABOUT_ME_RELATION_KEYS`, the raw-text system-prompt block, and the kernel
surface (`SetAboutMeRequest`, `API.meAboutMe`, `MeSettings.aboutMe`).

**Keep `users.about_me` dormant.** Dropping it needs a migration and orphans
any text a real user typed; a nullable column nobody reads is inert. A
follow-up may null it or migrate the text into persona memories.

### 2. Drop Slack / Discord from the connector UI

The Settings card and each group's bridge picker offer **Telegram only**. Copy
rewritten. `platformList` in group settings = `telegram` plus any platform that
already has a binding, so a legacy Slack/Discord bridge still renders a card and
can be disconnected — it just can't be added.

The **deploy-wide env wiring is removed**: `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, `DISCORD_BOT_TOKEN` are gone from `config/env.ts` and
`example.env`, and `registerEnabledConnectors` no longer registers a
`SlackConnector` / `DiscordConnector` from env. The connector **classes**,
their tests, the webhook routes, the `StartPairingRequest` enum, the
inbound-pipeline branches, and `makeConnector`'s BYO `DiscordConnector` path
(ADR 0025) are **left in place** — a legacy BYO Discord token in the DB still
loads. Fuller code removal is its own change. The two `docs/ops/connectors-*`
runbooks carry a deprecation banner.

### 3. A per-group "Mirror all messages" switch

In the group settings Messaging section, shown when the group has ≥ 1 bridge
binding. Toggles `mirror_inbound` via the existing `PATCH /groups/:id`
(membership-gated). Optimistic, reverts on error — the same pattern as the
group mute switch beside it. **No global default** — a 2–3-person household
sets this once per bridged group; a user-level default column is plumbing for a
knob nobody re-tunes.

## Alternatives considered

- **Keep "About me", just gate its context block to personal turns.** Fixes the
  one residual exposure but leaves a field that duplicates two other surfaces.
- **Drop the `about_me` column now.** Destroys real users' typed text with no
  sign-off; dormant, the column costs nothing.
- **Full Slack/Discord server removal in this change.** Large, risky, and
  orthogonal to a settings-UI cleanup.
- **A global "mirror Telegram by default" setting.** A new `users` column for a
  preference a small household sets per-group anyway.
- **A mirror-mode slider (per-group vs blanket).** An unusual control; a plain
  per-group switch matches every other toggle on that screen.

## Consequences

- `users.about_me` is write-never, read-never. Any prod text sits inert. A
  client still calling `PUT /me/about-me` gets a 404.
- `stagePersonProposal`'s "(from About Me)" label is gone; only email
  (`gmail:` provenance) reaches it now, always "(from email)".
- The `mirror_inbound` behaviour (ADR 0055) is unchanged — only made reachable.
- Tests: the per-group mirror toggle round-trips for a member and 403s for a
  non-member.
