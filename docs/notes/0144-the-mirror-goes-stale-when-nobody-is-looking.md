# ADR 0144 — The mirror goes stale when nobody is looking

**Status:** Accepted (2026-09-01)
**Related:** [0117](./0117-new-mail-can-reach-the-phone.md),
[0118](./0118-three-ways-to-be-told-one-way-to-react.md),
[0079](./0079-thirty-day-trial-then-gate.md),
[0137](./0137-a-proactive-message-is-not-always-the-briefing.md)

## Context

Reported: *"emails already read on like gmail, should show up as read on chord
too."*

The obvious reading is a convergence bug, and it is wrong. Every provider path
already converges read state correctly, which is worth recording so nobody
re-investigates it:

| path | mechanism | verdict |
|---|---|---|
| Gmail primary | backfill upserts `is_unread` from the UNREAD label; History applies `labelsRemoved`; an expired `historyId` falls back to a full backfill | correct |
| Gmail attached | same, including the expiry fallback | correct |
| Outlook | `isUnread: m.isRead === false` off the delta | correct |
| IMAP | `fetchFlags` converges `\Seen` — but only for the newest `IMAP_FLAG_REFRESH` (200) UIDs per tick | bounded |
| aggregation | `aggregateThread` is `some(m => m.isUnread)`, matching Gmail's own thread semantics | correct |

The defect is not *how* Chord learns. It is **when**. Mail synced in exactly
two places:

1. The Email tab, which force-syncs on focus and on pull-to-refresh.
2. Once a day, inside the morning briefing.

That is all. The two `maybeSyncGmail` calls in `proactive.service.ts` both sit
inside the daily-scan path; there was no periodic mail sync anywhere, and ADR
0118's push ships OFF and unverified. So every surface except the one screen
that force-syncs rendered whatever was true the last time that screen was open
— tiles and their attention weighting, unread counts, the decisions queue, the
To Do's hub.

The sharpest consequence is one nobody had noticed: **ADR 0117's new-mail
notification could effectively only fire while the user was already looking at
their mail.** A notification is triggered from `afterSync`, `afterSync` runs
from a sync, and a sync ran from the Email tab — so the feature was structurally
near-dead, telling people about mail on the screen in front of them.

## Decision

A background sweep in the proactive tick, running at **`mirror` depth**.

### The depth seam already existed

`runAfterSyncPasses` was already written in two tiers, because ADR 0079 had to
decide which passes an unentitled user still gets:

- **Above the gate** — body excerpts, the new-mail notification, the vacation
  responder. Provider fetches, no LLM calls.
- **Below the gate** — classification, category labels, attachment import,
  magics, person extraction. The paid layer.

A background sweep wants exactly the same line drawn, for a different reason:
it must refresh the copy without buying an AI bill proportional to how often it
runs. So `MailSyncDepth` reuses that boundary rather than inventing a second
one — `mirror` returns at the gate, `full` continues past it.

Keeping the notification and the vacation responder **above** the line is not
incidental. Both are time-sensitive, both are free, and the sweep is the first
thing that ever made either of them work when the app is closed.

### Depth deepens, never shallows

A nested round may upgrade `mirror` to `full` and never the reverse. Rounds are
keyed per user, so a route-triggered sync arriving while the sweep holds that
user's round *joins* it — and must not be silently downgraded to a pass set it
did not ask for.

The mirror image of that rule bit immediately: the sweep's own call to
`maybeSyncAccounts` opened a `full` round by default and deepened the sweep
straight back into the AI passes. Fixed by threading `depth` through that
function rather than weakening the deepen rule, which is protecting a real
case. A test pins both directions.

### Bounded, throttled, and unable to starve anyone

`MAIL_SWEEP_BATCH` (20) users per tick, ordered **stalest-first** so the sweep
round-robins: with more users than the batch allows, everyone still comes up,
just less often. `MAIL_SWEEP_MINUTES` (5) is the staleness threshold, and
`maybeSync*` already self-throttle on their own stored timestamps, so a user
swept moments ago by any other path costs a row read.

Shadow users are excluded for ADR 0098's reason: a shadow never opens a client,
so there is nobody for a fresh mirror to be fresh *for*.

Never throws. This runs inside the tick that also fires proactive messages and
archives stale tasks, and one throttling mailbox — ADR 0080's Yahoo case
reaches here as an ordinary rejection — must not stop the rest.

### The Email tab painted its cache during the sync

Separately, `load()` on that screen ran status → **sync** → refresh. A full sync
takes seconds, and until it returned the list showed the AsyncStorage cache
from whenever the tab was last open — so mail read elsewhere kept its unread
styling for the whole wait, on the one screen that does force-sync. It now
refreshes from the mirror *before* the sync as well: the server copy is already
fresher than that cache and is one local read away.

## Consequences

- Read state, deletes and new arrivals converge within `MAIL_SWEEP_MINUTES`
  everywhere, not just on the Email tab.
- ADR 0117's notification starts working as designed.
- Provider call volume rises: one `listHistory` per user per sweep for Gmail,
  a delta for Outlook, a login for IMAP. LLM spend does **not** rise, which is
  the whole point of the depth split.
- IMAP is the one to watch — ADR 0080's incident was login *rate*. The batch
  bound plus the existing throttle keep it to roughly one login per user per
  `MAIL_SWEEP_MINUTES`, but `MAIL_SWEEP_BATCH` is the dial if it bites.
- Mail arriving via the sweep is mirrored but **not classified** until the user
  opens the mail surface or the briefing runs. That is the deliberate trade:
  the mirror is what was stale, and the AI layer stays on the surfaces someone
  actually asked for.

## Rejected alternatives

- **Full-depth background sync.** Freshest everything, and it multiplies the
  per-user AI cost by the sweep frequency — the spend ADR 0137 had just
  finished bounding.
- **Turning on ADR 0118's push instead.** The right long-run answer and much
  cheaper at scale, but it ships off and unverified, and needs a public webhook
  URL, a Pub/Sub topic and an Azure app before it can be trusted. Polling is
  also what that ADR says push must never replace: push pre-empts the poll, so
  the poll has to exist first.
- **Only widening IMAP's 200-UID flag bound.** Would fix one provider's tail
  case and nothing about the cadence, which is what every affected surface
  actually depends on. Still worth doing on its own merits; not this change.
- **Shortening the Email tab's cache TTL or dropping the cache.** Treats a
  missing background sync as a rendering problem, and costs the fast cold-start
  paint the cache exists for.
