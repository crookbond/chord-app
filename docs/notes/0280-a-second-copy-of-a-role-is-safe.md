# ADR 0280 — A second copy of a role is safe

**Status:** Accepted, 2026-10-20
**Extends:** ADR 0170 (SSE over Redis), 0172 (web/worker split), 0178 (bot turns on BullMQ)
**Supersedes in part:** ADR 0155's in-memory per-group tail; the "in-memory" posture of ADR 0051, 0093, 0166, 0212, 0232

## Context

ADR 0170 made a broadcast reach a phone connected to any process, and ADR 0172
split the server into a web role and a worker role. Neither made it safe to run
**two copies of the same role**, which is the only way to add capacity beyond
one bigger machine. A capacity question (2026-10-20) listed what would break:

1. **Every `onBroadcast` listener runs on every process.** The Redis replay in
   `SseHub.deliverLocal` fires listeners for remote broadcasts too (that is how
   the web role hears a briefing the worker posted). So two web copies would
   each forward a bot reply to WhatsApp/Telegram (`outbound-publisher`) and
   each post "your suggestion was approved" (`proposal-resolution-notifier`);
   two worker copies would each send every push (`push-publisher`) and mirror
   every To Do's change (`todos-mirror`).
2. **Long-lived inbound connections.** Telegram's long poll (`getUpdates`) and a
   BYO Discord gateway would run in every web copy (Telegram answers a second
   concurrent poll with 409; Discord would dispatch every message twice). IMAP
   IDLE and the mail-push subscription renewer would run in every worker copy,
   doubling logins against exactly the rate ADR 0080 protects.
3. **Bot-turn order is in memory.** ADR 0155's per-group tail lives in the
   process that received the message, so two web copies would run two turns in
   one group at once and fork the shopping list again.
4. **"What the bot just asked" is in memory.** The follow-up window (0051), the
   numbered task list (0093), the event waiting on a guest's email (0166) and
   the pending share offer (0232/0233) live in the process that ran the turn;
   the next message can land on the other copy, which has forgotten.
5. **The phone's contact answer (0212) must reach the waiting process.** The
   turn waits in memory; the phone's POST can arrive at any web copy.

## Decision

### One owner per singleton duty: a Postgres session advisory lock

`services/cluster/leadership.ts` holds **one dedicated Postgres connection per
process** (not from the app pool) and takes `pg_try_advisory_lock` on a named
key for each duty that process competes for, retrying every 5 s. Postgres
releases a session lock when the connection drops, so a dead process loses its
duties without anyone cleaning up; a health check (`SELECT 1` every 15 s) and
the client's `error`/`end` events make the holder notice a lost connection and
stop. Two duties:

- **`im`** (web role): forwarding replies out, the approval notifier, the
  Telegram poll loop, and handling Discord gateway messages. Every web copy
  keeps its connectors for *sending* (a bot turn on any copy can reply); only
  the holder receives and forwards. A non-holder's Telegram loop sleeps instead
  of polling; every copy keeps its Discord gateway session open (Discord
  delivers to each) and only the holder handles a message.
- **`worker`** (worker role): the push sender, the To Do's mirror, IMAP IDLE and
  the push-subscription renewer.

`isLeader(name)` is a synchronous check; duties that hold a connection open
start on acquire and stop on loss. **Leadership never started means every
duty is held** — the single-process behaviour, so tests and `npm run dev` see
no change. Already safe without this, and left alone: the proactive scheduler
(ADR 0174 lock), mail-sync queueing (0176), the outbox (claims rows),
migrations (locked).

### Bot-turn order: a ticket per turn in Postgres

`bot_turn_tickets` (migration `116`). `reactToMessage` inserts a ticket
(`bigserial` seq, per group), waits until its ticket is the lowest live one for
the group, runs (inline or through the ADR 0178 queue), and deletes it. Each
waiting or running ticket's owner refreshes `heartbeat_at` every 15 s; a ticket
not refreshed for 60 s belongs to a dead process and is ignored and removed, so
a crash cannot wedge a group. Within one process ticket inserts for a group are
chained, so seq follows arrival order exactly as the old tail did. Uncontended
cost: three statements per turn. The wait happens before the queue, as the tail
did, so a waiting turn holds no worker slot and no database connection.

### Conversation state: Postgres, not Redis

`bot_pending_state (kind, scope_key, value jsonb, expires_at)` holds the
follow-up window, the numbered list, pending invitees and the pending share
offer, with each module's TTL as `expires_at` and expired rows removed on read
and by the daily retention pass (ADR 0226). The per-*turn* allowances in
`enumeration.ts` (`claimLooseTaskMutation`, `claimOncePerTurn`) stay in memory:
one turn runs in one process.

**Why Postgres and not Redis:** Redis is optional — dev, CI and `npm run sim`
run without it — so Redis-backed state would need a second in-memory
implementation behind it, and the two would drift. Postgres is always there,
the volume is a few rows per bot turn, and the state survives a deploy (a
restart no longer forgets which event is waiting for Karl's email). Redis wins
for high-rate ephemeral traffic; this is neither.

### The contact answer: Redis pub/sub, never stored

ADR 0212 promises nothing is stored, so the phone's answer does not go into a
table. The waiting turn stays in memory; a POST that lands on a process with no
such request publishes the answer on the SSE hub's Redis connection, and the
process holding the request resolves it. The route can no longer tell a
forwarded answer from a stale one, so it answers 204 whenever the body is valid
and the answer was delivered or forwarded (404 only when there is no Redis and
no local request).

## Consequences

- Running two web or two worker copies no longer duplicates messages, pushes or
  mailbox connections, and no longer reorders a group's bot turns or forgets a
  pending question. **Multi-copy still requires `REDIS_URL`** (broadcast
  fan-out, the contact hand-off, BullMQ).
- When a duty's holder dies, another copy takes it within ~5 s; broadcasts in
  that gap are not forwarded or pushed (SSE never replays, ADR 0002) — the same
  loss as a restart today.
- A holder whose network silently dies keeps acting until its health check
  fails (≤ 15 s) while Postgres may already have handed the lock on: a short
  window where both copies forward. Accepted; the alternative is a fencing token
  on every send.
- Each process holds one extra Postgres connection.
- Not covered and still per-process (waste, not wrong results): the read-time
  and preprocessing de-duplication in `magics.service.ts`, the image preload
  guard, the mail-sync coalescers (ingest has its own lock, ADR 0137) and the
  per-process caches (Google tokens, thread summaries).

## Rejected

- **Each listener acts only on broadcasts that originated in its process.** The
  worker has no connector registry, so a worker-originated briefing would never
  reach WhatsApp.
- **A leases table with expiry instead of advisory locks.** Needs its own
  renewal and expiry rules; a session lock is released by Postgres itself.
- **A blocking per-group advisory lock around each bot turn.** Pins a pool
  connection for the whole turn, plus one per waiting turn — the pool runs out
  in exactly the burst ADR 0155 was about.
- **Try-lock and re-enqueue with a delay (ADR 0178's suggestion).** Loses
  arrival order: a later message can win the race after the first turn ends.
- **Redis for the conversation state.** See above.
- **Storing the contact answer in Postgres for the waiter to poll.** Breaks ADR
  0212's "nothing is stored".
