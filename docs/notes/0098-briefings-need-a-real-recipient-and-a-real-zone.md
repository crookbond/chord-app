# 0098 — A briefing needs a real recipient and a real timezone

**Status**: accepted
**Date**: 2026-08-22
**Relation**: bounds who [0034](./0034-configurable-nudge-time.md)'s daily
briefing is scheduled for, and what its timezone fallback means; the recipients
it excludes are [0053](./0053-whatsapp-twilio-connector.md)'s taster shadows,
whose merge path in [0064](./0064-phone-as-attribute-identity.md) is deliberately
left alone. Each excluded send is also one of [0089](./0089-whatsapp-session-window-briefing.md)'s
billed conversations.

## Context

A user reported his WhatsApp briefing arriving at **midnight Pacific**. His
timezone was set correctly. Production:

| id | username | shadow | `last_tz` | briefing fires |
|---|---|---|---|---|
| `u_UTZ17j-vnkJg` | `adriankane` | 0 | `America/Los_Angeles` | 14:00Z = 07:00 Pacific ✓ |
| `u_DOoRmGlmhWUe` | `whatsapp_whatsapp:+1646…` | 1 | *(null)* | 07:00Z = 00:00 Pacific ✗ |

He has two user rows. The second is a taster shadow
([0053](./0053-whatsapp-twilio-connector.md)), minted when he first messaged the
WhatsApp bot three months after signing up. `maybeTasterServe` calls
`ensurePersonalGroup` so the bot's reply has somewhere to land, and binds the
WhatsApp channel to that group — so the shadow's briefing is the one that
reaches his phone, while his correct 07:00 briefing goes only to the app.

Three failures compose:

1. **`seedDailyScan` joins `groups → users` with no `shadow` filter.** Owning a
   personal group is the only qualification, and the taster path hands every
   WhatsApp stranger one.
2. **A shadow's `last_tz` is structurally NULL.** It is set by
   `recordUserTimezone` from a client that reports its zone; a shadow never
   opens a client, so the column can never be filled.
3. **`nextScanDate`'s null-tz fallback was server-local** — `setHours` on the
   VM's clock. Production Postgres reports `Etc/UTC`, so a 07:00 briefing was
   queued for 07:00Z, which in August is midnight in Los Angeles.

The third was already known to be a bad outcome. `isValidTz` carries the
comment *"a bad zone would silently fall the scheduler back to server-local for
good"* — the fallback was understood as damage to be avoided, never as a
behaviour anyone chose.

The briefing is also hollow. The shadow's group holds 5 messages, 0 tasks and
0 events, against 94 messages and 719 events on his real one.

Two other production rows are affected: a second taster shadow beside its own
real account, and a real non-shadow user who has simply never posted a
timezone — mistimed by (3) alone.

## Decision

### 1. A scheduled briefing is only ever queued for a real user

The filter goes in `enqueueDailyScanForUser`, the choke point both the nightly
`seedDailyScan` and `rescheduleDailyScanForUser` pass through. Putting it in
`seedDailyScan` alone would let a reschedule put the row back.

`enqueueDailyScanForUserNow` is deliberately **not** gated. That path is the
user asking for a briefing right now, and after a merge its caller is a real
account anyway — gating it would break "brief me" for no benefit.

A shadow is the wrong recipient for three independent reasons, any one of which
is sufficient:

- **It never asked.** A taster shadow exists because a stranger sent one
  WhatsApp message. A daily unprompted message back is not part of that bargain,
  and each one is a billed business-initiated conversation
  ([0089](./0089-whatsapp-session-window-briefing.md)).
- **It cannot be timed.** No client, so no `last_tz`, so no correct hour exists
  to send it at.
- **It has nothing to say.** The shadow's group holds a handful of taster
  messages and no facts.

`seedDailyScan` also **deletes pending unfired scans belonging to shadows**, so
the existing queued rows drain themselves on the first tick after deploy rather
than needing to be hand-deleted in production. This is what makes the rule
self-healing for any taster already in flight.

### 2. The null-tz fallback is a configured zone, not the server's

`BRIEFING_DEFAULT_TZ` (default `America/New_York`) replaces the `setHours`
server-local branch in `nextScanDate`.

The defect was never that the fallback was wrong for one user — it is that the
hour was derived from a value with no relationship to any user at all. The VM's
zone is an operational detail; moving the box would silently re-time everyone's
briefing. An explicit zone is a choice someone can review, and it is wrong by at
most three hours instead of by seven.

### 3. No new auto-merge — the claim path already exists, and stays gated on proof

`linkWhatsappIdentityForPhone` already folds a taster shadow into a real account
when a phone verifies, and `mergeOrLinkExternalIdentity` already collapses the
resulting duplicate briefing through `rescheduleDailyScanForUser`. The machinery
is complete and correct.

This user has two rows only because he signed up in May and tasted in August:
no signup intent left to consume, and no verified number. Nothing will ever fire
his merge until he verifies.

Closing that by matching the shadow's display name to a real account's would be
an identity claim with no evidence behind it — precisely what
[0064](./0064-phone-as-attribute-identity.md)'s addendum refused when it ruled
that identity rows are not fresh proof. The way back is the connect prompt
[0053](./0053-whatsapp-twilio-connector.md) already rides on the taster's own
replies, or verifying the number in Settings. Decisions 1 and 2 make the
un-merged state quiet instead of noisy, which is the part that was actually
broken.

## Consequences

- A taster who never verifies gets no briefing. Intended: they never asked for
  one, and it would be billed.
- On merge, the owner's own scan is re-queued by existing code. Nothing is lost
  by having withheld one from the shadow.
- A real user with no `last_tz` still gets a possibly-wrong hour, now bounded to
  the configured zone. Their first client open calls `recordUserTimezone`, which
  reschedules. Mistimed-but-plausible beats absent — which is why deferring was
  rejected below.
- `BRIEFING_DEFAULT_TZ` is one deploy-wide guess. A genuinely multi-region
  deploy would want per-user inference; that is not built, and the knob is
  honest about being a default.
- In production this stops two shadow briefings and moves one real user from
  00:00 Pacific to 07:00 Eastern.

## Rejected alternatives

**Defer the briefing until a timezone is known.** Clean for shadows, wrong for
real users: production has a signed-up, non-shadow user who has never posted a
zone, and deferring would silence him permanently rather than mistime him. Decision 1
already removes the shadows, so the deferral would only ever hurt the case it
does not fix.

**Derive the zone from the bound channel's phone number.** A `+1` country code
spans six US zones and cannot distinguish New York from Los Angeles — the exact
distinction this bug is about. It would dress a guess as a fact and make the
next mistiming harder to see than the current one.

**Filter shadows in `seedDailyScan` only.** `rescheduleDailyScanForUser` would
re-queue the row on the next nudge-settings change, so the bug would return
through a second door.

**Give the shadow a briefing but suppress delivery at the WhatsApp boundary.**
Moves the decision to the wrong layer: the scan would still run an LLM turn over
an empty group every night, and [0089](./0089-whatsapp-session-window-briefing.md)'s
gating already assumes the message is one someone wanted.

**Auto-merge a shadow into a real account on a display-name match.** Would have
fixed this user's symptom completely, and is unsafe for exactly the reason
[0064](./0064-phone-as-attribute-identity.md) already settled: a name is not
proof of a phone number, and the merge hands over an entire personal group's
history.
