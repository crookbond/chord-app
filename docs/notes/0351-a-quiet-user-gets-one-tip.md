# 0351 — A quiet user gets one tip, about something they have not tried

Status: accepted, 2026-11-23. On by default (`REENGAGE_ENABLED`, needs `PUSH_ENABLED`):
someone with notifications off gets nothing anyway.

## Context

People sign up, use one thing, and stop opening the app. Nothing reminded
them that Chord does more. The ask: someone who has not opened the app for
2-3 days gets a push naming a feature they have not used ("hey - do x").

## Decision

`services/reengage/` runs from the proactive tick, worker leader only, at most
every `REENGAGE_SWEEP_MINUTES` (30).

- **Activity = the newest app session's `last_seen_at`** (refreshed by
  `loadSession` at most every 5 minutes). Idle = at least `REENGAGE_IDLE_DAYS`
  (2) and at most `REENGAGE_MAX_IDLE_DAYS` (21). Shadows and people with no
  session (WhatsApp only) are never nudged to open an app they do not use.
- **Usage is read, not tracked.** Each feature in `features.ts` has a `used()`
  check over data Chord already keeps: a mailbox connected, a message typed to
  Chord, a list made, a tldr or drafted reply (`token_usage` source), `/plan`
  run (`skill_runs`), an unsubscribe, a trip, a shared chat with someone else.
  Nothing new is written on the hot paths, and a feature used before this
  shipped already counts. Features are offered in list order; `needs` keeps
  the mail tips behind connecting a mailbox.
- **One per absence, never repeated.** Sent tips are logged in
  `users.defaults.reengage_sent`. Nothing goes out if a tip was sent after the
  user was last seen, or less than `REENGAGE_MIN_GAP_DAYS` (7) ago, and a
  feature is never sent twice. When everything is used or sent, nothing more.
- **Daytime only**: between `REENGAGE_START_HOUR` and `REENGAGE_END_HOUR`
  (10-19) in the user's `last_tz` (else `BRIEFING_DEFAULT_TZ`).
- **The user's switches apply**: it is a `bot`-category push through
  `eligibleTokens` (bot toggle + quiet hours); `users.defaults.reengage_tips_off`
  turns just these off. No device = skipped and not recorded.
- Recorded before sending (ADR 0115's rule): a failure costs one tip, never two.
- The push carries `data.url` (an in-app path); the app's tap handler now opens
  it (`mobile/src/push.ts`, same code on iPhone and Android). Older builds just
  open the app.
- **Stopping is said in the tip**: every body ends `Reply "stop sending me
  tips" in chat to stop.`, and that reply calls the personal-only
  `set_feature_tips { enabled? }` (omit = read). No Settings switch (owner:
  not needed).

## Rejected

- An event log of every feature use: a write on every route for a question the
  existing rows already answer.
- A chat message instead of a push: it is only seen by someone who opens the
  app, which is the person we are not reaching.
- A tip every few days for as long as they stay away: that is how an app gets
  its notifications turned off.
- A model-written message: fixed copy is cheaper, testable and cannot claim a
  feature that does not exist.
