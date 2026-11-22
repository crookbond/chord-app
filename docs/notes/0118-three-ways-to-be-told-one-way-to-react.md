# 0118 — Three ways to be told, one way to react

**Status**: accepted (mechanism unverified end-to-end — see Consequences)
**Date**: 2026-08-25
**Relation**: completes Wave 5 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md)
on top of [ADR 0117](./0117-new-mail-can-reach-the-phone.md); revisits the
connection posture of [ADR 0080](./0080-multi-account-email-providers.md);
reuses the challenge-echo shape of [ADR 0090](./0090-whatsapp-cloud-api-direct.md).

## Context

ADR 0117 made new mail notify. This makes it notify *soon*: mail arrives, and
Chord finds out at the next poll rather than at the next second.

Each provider offers something different, and the differences are real:

| | mechanism | expiry | how it authenticates |
|---|---|---|---|
| Gmail | `users.watch` → Pub/Sub → our URL | 7 days | nothing in the payload |
| Graph | subscription on the inbox | ~3 days | `clientState` it echoes back |
| IMAP | `IDLE` on a held-open connection | none | the connection is the auth |

Two are inbound webhooks with a registration to keep alive; one is an outbound
socket that is simply held. That asymmetry is the whole design problem.

## Decision

**They converge before anything provider-specific happens.**

```
Pub/Sub notification ┐
Graph callback       ├──▶ wakeMailbox(userId, accountId) ──▶ the sync the poll already runs
IDLE `exists` event  ┘         (coalesced, 2s)
```

Each mechanism's only job is to say *which mailbox*. None of them gets to
decide what "sync" means, and none carries mail — Gmail's notification has no
content at all, Graph's is a change token, IDLE's is a message count. **Every
one is a hint, and we re-read the mailbox ourselves regardless.** That is what
makes a forged notification boring: the worst it buys is an early sync.

### Push pre-empts polling; it never replaces it

The load-bearing rule. Both registrations expire on a timer measured in days,
so sooner or later one lapses unnoticed — a renewal that 500s, a rotated
credential, a topic someone deleted. Because the poll still runs, that is a
**latency regression rather than an outage**, and it is the only reason it is
defensible to ship a mechanism that cannot be verified end-to-end here.

It also means every failure path is a log line and a shrug: `armMailbox`
records the error and returns false, connect flows do not fail when a Pub/Sub
topic is misconfigured, and a dead IDLE socket just retries with backoff.

### Coalescing is not an optimisation

Gmail publishes per history change, so five messages arriving together is five
notifications for one sync's worth of work. Without the 2s window, a busy
mailbox would start a sync per message against the same cursor. A nudge that
lands mid-sync **re-arms** rather than running concurrently, so the change that
arrived during a sync is not lost to a cursor that had already moved.

### One subscription table, because they are the same object

Gmail's watch and Graph's subscription are both *an external registration with
an id and a deadline*. `mail_subscriptions` holds either, keyed by mailbox
(`account_id NULL` = the primary Gmail, ADR 0080's convention), which is what
lets one renewal loop serve both without knowing which is which. `clientState`
is **per subscription, not per deploy**: a leaked one is worth exactly one
mailbox's early sync. It is deliberately **reused across renewals**, because
notifications already in flight carry the old one.

### The two webhooks authenticate differently, on purpose

Graph sends `clientState` back, so we compare it. Gmail's Pub/Sub payload
carries no secret of its own, so the *URL* does. That token is not protecting a
secret — the notification has no content — it stops the endpoint being a free
way to make the server do work.

Graph also validates the URL before it will create anything, by POSTing a
`validationToken` it wants back as **plain text**. Same handshake shape as ADR
0090's Meta challenge, and the same trap: JSON would quote it and fail.

Both routes answer **before** doing the work. Pub/Sub retries on any non-2xx
and Graph drops a subscription that keeps failing, so a slow handler turns one
late sync into a dead registration.

### IMAP IDLE, and why it does not contradict ADR 0080

ADR 0080 explicitly refused a cross-tick connection pool. IDLE holds one
connection open indefinitely, which looks like the opposite — so, precisely:

- That ADR's concern was **login rate**. Yahoo throttles on it, and a
  per-message login inside a loop is what caused the outage it fixed. IDLE is
  *one* login held open versus one per sync tick forever: it **reduces** the
  metric ADR 0080 was protecting.
- What it costs instead is a long-lived resource, so it is capped
  (`IMAP_IDLE_MAX_ACCOUNTS`), reconnects with doubling backoff, and resets that
  backoff only on a successful connect — otherwise one bad night leaves a
  healthy mailbox on a fifteen-minute retry forever.
- It is separately switchable from the webhook half, because it is a different
  kind of risk.

## Consequences

- **The mechanism is unverified end-to-end, and ships off** (`MAIL_PUSH_ENABLED`
  defaults false). There is no public URL, no Pub/Sub topic and no Azure app
  registration in this environment, so Gmail cannot publish to us and Graph
  cannot validate a callback. What *is* tested is everything up to the wire:
  envelope parsing, `clientState` rejection, renewal windows, coalescing, and a
  sync that throws. The first real deploy is the first real proof, and the
  fallback for it going wrong is polling.
- Latency drops from a poll interval to seconds where it works, per provider,
  independently. A mailbox whose push is broken is slower, not broken.
- `mail-push.ts` takes its sync function by **injection**. Importing the
  provider services would close the cycle `attachment-fetch.ts` and
  `body-backfill.ts` already sit above.
- The route mounts **before** the connector router, which owns
  `/webhooks/:platform` as a catch-all and would otherwise swallow `mail` as an
  unknown platform. Same ordering care ADR 0075 needed for Stripe.

## Alternatives rejected

**Polling faster.** The obvious cheaper answer, and it scales the wrong way:
cost is linear in mailboxes × frequency, and it is exactly the login-rate
pressure ADR 0080 was written about.

**One shared `clientState` for the deploy.** Simpler, and a single leak would
let anyone nudge every mailbox.

**Trusting the notification's contents.** Gmail's `historyId` is right there
and syncing straight from it would save a round trip — while making a forged
notification able to steer our cursor. Re-reading costs one call.

**Letting push replace polling once it is proven.** Tempting later, and it
converts every expiry bug into silence. The poll is the thing that makes push
safe to get wrong.

**Deferring IMAP to keep the release small.** Would leave one provider slower
for no reason but effort, which is the asymmetry ADR 0116 just finished
removing.
