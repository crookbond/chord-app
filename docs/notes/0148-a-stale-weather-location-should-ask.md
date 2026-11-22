# 0148 — A stale weather location should ask, not guess

**Status**: accepted
**Date**: 2026-09-07

## Context

ADR 0091 resolves the briefing's weather location in three tiers — IP-derived
city (`ip`), the city inside the device timezone (`tz`), and an explicit
Settings choice (`user`, authoritative). Once a value is stored, nothing ever
re-examines it:

- `seedLocationFromIp` deliberately early-returns once an `ip` fix exists
  ("don't re-resolve on every request"), so an IP location is frozen after the
  first foreground — a traveller keeps yesterday's city.
- A `user` override is never touched by the automatic tiers by design, so
  someone who typed "Seville" once, or set it correctly and then moved, is
  stuck there with no signal that it is wrong.
- There was no chat path to it at all. "Set my weather to Madrid" in the 1:1
  did nothing, because the bot had no matching tool — worst case the model
  claims success (ADR 0102).

Prod bore this out: a real user's row read `weather_place = Seville`,
`weather_place_source = user`, `last_tz = Europe/Madrid`, with five
`PUT /me/weather-location` calls over two days that never moved the value —
someone trying and failing to fix it. (Separately, the GeoLite2 database had
never been deployed, so the `ip` tier was dead for everyone — see the ADR 0091
addendum. That fix and this one are independent: this ADR is about noticing a
stale value, whatever tier produced it.)

There is no GPS to check the stored location against — ADR 0091 rejected the
permission prompt and this ADR does not revisit that. The only signals
available are the same two automatic tiers: a fresh IP-derived city, or the
timezone city.

## Decision

**Never change the location silently. When it looks stale, ask in chat.**

1. **`set_weather_location` bot tool** (personal-only, same rule as
   `set_my_name` / `set_nudge_time`). Delegates to the same
   `setUserWeatherLocation` / `clearUserWeatherLocation` the Settings route
   uses: a place that geocodes is stored `source = 'user'`; an empty `place`
   clears the override; `keepCurrent: true` answers a drift question with "no".
   When geocoding fails or no `WEATHER_PROVIDER` is configured it returns
   `ok: false` and writes nothing, and the description forbids the model from
   reporting success.

2. **Drift detection.** `detectWeatherDrift` compares the stored coordinates
   against a fresh fix — the IP-derived city stashed on the user row if it is
   less than 3 days old, else the timezone city geocoded. If they are more
   than `WEATHER_DRIFT_KM` (default 100) apart, that is drift.

   The daily scan has no request IP, so `PUT /me/timezone` (launch + every
   foreground, the one place with an IP) stashes the last IP city on the user
   row via `stashIpObservation` — unconditionally, independent of whether a
   location is already set.

3. **The question.** When the morning briefing renders, `weatherDriftQuestion`
   appends one line — *"Your weather is set to X, but you seem to be near Y
   now. Want me to switch it? Reply yes, tell me the right city, or keep it."*
   — and records that it asked. The user answers in the 1:1; the normal bot
   turn reads its own question in history and calls `set_weather_location`
   (`{place: Y}` for yes, `{place: Z}` for a different city, `{keepCurrent:
   true}` for no).

4. **Not nagging.** `weather_prompt_{lat,lon,at,declined}` on the user row:
   don't re-ask about a spot within `WEATHER_DRIFT_KM` of the last one for
   `WEATHER_DRIFT_REASK_DAYS` (default 7) if unanswered, or indefinitely if
   the user said "keep it" — until a fresh fix lands a real distance away, a
   genuinely new place. Any explicit set/clear resolves the episode (the
   prompt columns are cleared in `persist`).

Applies to **all** sources, not just `user` overrides (the alternative was to
let `ip`/`tz` silently re-follow travel and only ask about `user` values). One
rule — Chord never moves your weather without asking — is easier to reason
about than a per-source split, and it also un-freezes the `ip` tier that
`seedLocationFromIp` had pinned after first resolution.

## Alternatives considered

- **Silently update automatic (`ip`/`tz`) locations, only ask about `user`
  overrides.** Matches ADR 0091's "the automatic tiers follow you" framing and
  is less chat noise for people who never touched the setting. Rejected: a
  location changing on its own is exactly the surprise this ADR exists to
  avoid, and "we ask before changing your weather" is a simpler promise than
  "we ask sometimes."
- **A tappable card with [Switch] / [Keep] buttons** (ADR 0042's reconnect-
  nudge shape). Deterministic, no LLM turn to parse the answer. Rejected for
  now: the plain-message path needs zero new answering machinery — the bot
  already has `set_weather_location` and already sees its own question in
  history — and a wrong guess is cheap because the question invites a free-text
  correction ("actually I'm in Barcelona").
- **Ask at signup for the city.** Honest and exact (ADR 0091 already lists and
  rejects this as the *default* — it stays the Settings override). A drift
  prompt is strictly better: it only fires when the guess looks wrong.
- **Re-geocode and update on every foreground.** Cheap-looking, but it is the
  silent change again, and `PUT /me/timezone` fires many times a day — a
  network geocode on each is wasteful. Stashing the (local, no-network) IP
  city and deciding once a day in the scan keeps the cost off the hot path.
- **A dedicated `proactive_kind` message instead of a briefing line.** Visually
  distinct, but it is another message insert + SSE broadcast + dedup surface,
  where a best-effort briefing section already has the once-a-day cadence and
  the same failure contract as the weather / email / proposals sections beside
  it.

## Consequences

- **The `tz` arm is coarse.** `cityFromTimezone('Europe/Madrid')` is "Madrid",
  so a user correctly set to Barcelona (same timezone) can get one "you seem
  to be near Madrid?" prompt per `WEATHER_DRIFT_REASK_DAYS` until the `ip` arm
  (which *can* tell Madrid from Barcelona) takes over. Mitigated by: IP
  preferred, the decline flag, the weekly cap, and a question phrased so "no"
  is one tap. If it proves noisy, a follow-up can gate the `tz` arm on
  `last_tz` having actually changed since the location was set — at the cost
  of no longer catching an intra-timezone move like the prod case that
  prompted this (Seville → Madrid).
- **Needs `WEATHER_PROVIDER` set to do anything** — no weather line, no reason
  to ask about its location. The IP arm additionally needs `GEOIP_DB_PATH`
  (the ADR 0091 addendum deploy fix); without it the check runs on the `tz`
  arm alone.
- **The answer relies on an LLM turn** reading the briefing question from
  history. In a personal 1:1 the bot always responds, and the detected city is
  named in the question text, so "yes" resolves. If the user engages days
  later and the briefing has aged out of the ADR 0035 context window, the next
  briefing re-appends the question (still drifted, past the re-ask window).
- **Migration 065** adds eight nullable columns to `users`
  (`weather_ip_*`, `weather_prompt_*`). No backfill — every existing row
  starts with no stash and no prompt history, which reads correctly as "never
  asked."
- Two new env keys: `WEATHER_DRIFT_KM`, `WEATHER_DRIFT_REASK_DAYS`.
