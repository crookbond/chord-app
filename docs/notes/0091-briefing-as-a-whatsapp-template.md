# ADR 0091 — The out-of-window nudge carries the briefing

- **Status:** Accepted
- **Location addendum:** superseded in part by ADR 0258 - Chord now asks for the phone's location and uses it when given; the IP and time-zone tiers remain as the fallback.
- **Date:** 2026-08-21
- **Amends:** ADR 0089 (session-window briefing), ADR 0079 (gated teaser)
- **Extends:** ADR 0090 (WhatsApp Cloud API), ADR 0048 (native deep links)

## Context

ADR 0089 solved a real problem: WhatsApp only delivers free-form text within 24
hours of the *user's* last message, so the 07:00 briefing is undeliverable for
anyone who did not write yesterday. Its answer was to send an approved
quick-reply template asking **"Good morning! Want your daily briefing?"** and
park the real briefing until the user taps Yes.

That message carries **zero information**. The user gets a question at exactly
the moment we could have given them their day, and if they never tap, they never
learn what they missed — while we still paid for a business-initiated
conversation. ADR 0089 itself considered and rejected sending the briefing as a
template:

> **Send the briefing as a template every day.** Templates cost per conversation
> and must be pre-approved with fixed variable slots — a briefing is free-form
> prose of unbounded length and shape, so it cannot be a template without being
> gutted into a stub. Rejected.

Every clause of that is still true. The conclusion is what was wrong: **being
gutted into a stub is fine, as long as the stub is true and has a way in.** A
few real lines plus links beats a bare question, and costs the same one
conversation.

Now that we talk to Meta directly (ADR 0090) the template is ours to shape,
which makes this cheap to revisit.

## Two constraints that determine the design

1. **A Meta template body variable cannot contain a newline, a tab, or 4+
   consecutive spaces, and cannot be empty.** A multi-line briefing therefore
   cannot be stuffed into one `{{1}}`. The section headers and blank lines have
   to be part of the *approved body*, with one variable per line.

2. **There is no structured representation of the briefing.** The
   Conflicts / This week / Heads-up sections are not emitted by code at all —
   they are instructions inside `SCAN_SYSTEM_PROMPT`, and the model honours them
   only approximately ("omit section if none"). Only the Email and
   Waiting-on-your-OK sections are deterministic.

## Decision

**Fill the out-of-window template with the day's actual facts, built
deterministically from the same rows the briefing reads — not parsed out of the
briefing's prose.**

### 1. `BriefingFacts` is a sibling of the briefing, not a summary of it

`services/briefing/facts.ts` produces six single-line-or-null values (weather,
today, this week, heads-up, tasks, email) from plain SQL and no LLM call. It
does **not** read the rendered briefing.

Regex-scraping emoji headers out of free-form LLM prose would work in
development and rot silently in production the first time the model varied its
formatting — and the failure mode is an undelivered briefing, which nobody
notices. This is the same relationship `summarize_email` has to the email digest
under ADR 0072: same underlying data, separate deterministic path, different
output shape.

### 2. One facts source, two renderers

`renderTeaser` produces ADR 0079's gated text; `templateParams` produces the
five template slots. `buildGatedBriefingTeaser` now delegates to the former, so
the two abbreviated surfaces cannot drift apart — previously the teaser
duplicated its own event/proposal/unread counts.

Absent facts are handled differently on purpose: the teaser **omits** the line
(plain text can just be shorter), the template **floors** it ("Nothing today"),
because Meta rejects an empty parameter. `sanitizeParam` enforces the newline
and length rules at the boundary rather than trusting the facts builder.

### 3. Ask-once semantics are untouched

`gateProactiveSend` is unchanged. Silence still means stop until the user writes
first — every template send is a billed business-initiated conversation and a
daily unanswered prompt is what Meta's quality rating punishes. Only the
*content* of that one send changed, so this is a strictly better message for the
same cost and the same risk.

### 4. The links are literal, the facts are variables

Five variables (`{{1}}`..`{{5}}`) and three fixed `chordapp.ai` URLs baked into
the approved body. The URLs are identical for every user, so making them dynamic
would buy nothing and would show Meta's reviewer a template capable of sending
an arbitrary link. The per-user link is the **`Full briefing` button** instead:
tapping it reopens the window, and ADR 0089's existing `n+` path delivers the
parked full briefing for free.

### 5. Twilio deliberately keeps the old one-slot prompt

Twilio's Content API interleaves body and button variables in a single numbering
scheme (`{{1}}` body, `{{2}}`/`{{3}}` and `{{4}}`/`{{5}}` button payload/label),
so body slots 2..N would collide with its button slots and force a re-approval.
Production is Meta; Twilio is the local sandbox path. Setting `body` to the
generic prompt *and* `templateParams` to the facts means each provider takes
what it can use, with no branch at the call site.

### 6. Weather, without asking for location

The briefing had no weather. Adding it needs a location, and Chord deliberately
does not ask for GPS. Three tiers, best available wins:

1. **IP** — GeoLite2 City as a local `.mmdb`. Metro-accurate, and because the
   lookup is a local file read **the address never leaves the server**. Better
   privacy than any IP-lookup API, which would ship the user's IP to a third
   party on every resolution.
2. **Timezone** — the city inside the IANA name (`America/Argentina/Buenos_Aires`
   → "Buenos Aires"). A last resort: `America/New_York` spans Boston to Miami.
3. **Settings** — explicit, authoritative, and **never** overwritten by either
   automatic tier. An explicit answer has to survive travel, which is exactly
   when both automatic signals move.

**We store the derived city, never the IP.** There is no `users.last_ip` column
and nothing to leak in a dump — the same posture ADR 0065 takes with phone
hashes. Resolution runs on `PUT /me/tz`, which the client already calls on
launch and foreground, so it costs no extra round trip and no per-request query.

`trust proxy` is set to **1, not `true`**: nginx is the only hop, and trusting
every hop would let a client forge `X-Forwarded-For` to choose its own location
(and its own rate-limit bucket).

Weather sits behind a `WEATHER_PROVIDER` seam (`open-meteo` | `mock` | empty)
mirroring `GMAIL_PROVIDER`, so tests never touch the network and swapping
providers is one file.

**Addendum 2026-08-22 — the line says something useful.** It shipped as
`☀️ Clear · 72°/58°F`, which is a readout, not advice. It now reads
`⛅ Partly cloudy today, low 58° and high 72°F · ⛈️ 60% chance of thunderstorms
around 3 PM — carry an umbrella`. Everything needed comes back in the **same
single request** (`precipitation_probability_max` on `daily`;
`precipitation_probability` + `weather_code` on `hourly`), so the added value
costs no extra call and no key.

Three judgements are baked into `renderWeatherLine`:

- **The timing is scoped to the rest of the day**, not the whole of it. A
  briefing read at 6 PM must not promise an umbrella for the shower that
  soaked the morning. Late in the day this legitimately yields a low number
  and the clause is dropped — silence is the right answer there. (The first
  cut had a whole-day fallback for "nothing left"; it was unreachable, since
  the current hour always matches itself, and its comment claimed behaviour
  the code did not have. Removed rather than fixed.)
- **Ties break on severity.** Long runs of hours share a probability, so ties
  are the common case, not an edge; without the tie-break a day of showers
  gets announced as whichever drizzle happened to come first.
- **A high number is never paired with a dry code.** "60% chance of clear" is
  a rounding artefact that reads as a bug, so the clause requires a wet code
  at the chosen hour. Advice appears only at ≥50%, and snow says "bundle up"
  rather than reaching for an umbrella.

The clause is omitted entirely below 25% — every forecast has a 10%, and a line
that always warns about something trains the reader to skip it. The result is
still one line with no tabs or doubled spaces, because it is still slot `{{1}}`.

### 7. Settings closes two open gaps

- **Weather location**, showing the *resolved* place rather than the raw input —
  that is what makes a wrong automatic guess visible and correctable.
- **Per-channel briefing mute.** ADR 0089 noted "opt-out is invisible in the
  app" and shipped `n-` with no way back short of re-binding the channel. The
  toggle sits next to the briefing switch, which is where the confusion it
  causes actually appears. Un-muting also clears `nudge_prompt_sent_at`,
  otherwise a channel muted after being asked would come back permanently
  silent.

## Consequences

**The template is a hard external dependency, again.** Nothing delivers until
Meta approves a *new* five-variable template; the old `morning_nudge` will not
work. The send path already degrades to a logged skip when unset, so shipping
ahead of approval is safe. The exact body to submit is in `example.env`.

**The abbreviated briefing can disagree with the full one.** The facts are
deterministic; the LLM briefing is not. A user who taps `Full briefing` may see
items ordered or judged differently from the five lines that prompted them. That
is the cost of not parsing prose, and it is the right trade — the alternative
fails silently rather than differing visibly.

**A fixed template shows headers on quiet days.** "Nothing today" under
"This week" is slightly awkward, but Meta rejects empty variables and a template
body cannot be conditional. Only the out-of-window path is affected.

**Weather adds an outbound dependency to the briefing.** Bounded: fixed hosts, a
6s timeout, and every failure path returns null. A missing forecast is a missing
line, never a missing briefing.

**Open-Meteo's free tier is non-commercial.** Fine for now; a paid plan or a
provider swap is needed once Chord bills. The seam is there for it.

**Android still opens links in the browser.** `/calendar`, `/catchup/*` and
`/email/*` are now claimed in the AASA and the intent filters, but Android
verification remains blocked on the release SHA-256 in `assetlinks.json` (ADR
0081's tracked prerequisite). iOS opens them in-app today.

## Alternatives considered

**Parse the rendered briefing into slots.** Cheapest — no new query path — and
guaranteed consistent with the full text. Rejected: the sections come from a
prompt, not from code, so any change to model or prompt breaks the parse, and
the failure is an undelivered message nobody sees.

**Make the section links template variables too.** Costs nothing at runtime and
would let links vary per user. Rejected: no user-varying part exists, and it
shows Meta's reviewer a body that can carry any URL.

**Send the content template daily, dropping ask-once.** More reach, and
defensible now the message carries value. Rejected for now: each out-of-window
day is a billed conversation and an unanswered daily template is the pattern
Meta's quality rating punishes. Revisit with delivery data.

**Ask the user for their city at signup.** Honest and exact. Rejected as the
*default*: it is another onboarding step for a line most users would accept a
guess on. It exists as the Settings override, which is where someone who cares
will look.

**Device GPS for weather.** Most accurate by far. Rejected: a location
permission prompt is a real cost for one line of a briefing, and IP plus a
correctable Settings field gets close enough.

**An IP-geolocation API instead of a local database.** No signup, no 60MB file,
no weekly refresh. Rejected: every lookup would send a user's IP address to a
third party, which is a materially worse privacy posture than a file read for
no functional gain.

## Addendum 2026-09-06 — the GeoLite2 DB was never deployed

Dogfooding the weather line turned up that the `ip` tier has **never run in
production**. `deploy.sh` sources `scripts/deploy/deploy.env`, but
`MAXMIND_LICENSE_KEY` was only ever set in `.env.prod` (the server env file),
so `geoip_sync` printed "MAXMIND_LICENSE_KEY unset, skipping" on every deploy
and `/srv/chord/data/geolite2-city.mmdb` never existed — while `.env.prod`
still shipped `GEOIP_DB_PATH` pointing at it. Prod logs `geoip: database not
found, IP location disabled` on every restart back to the feature's launch.
Every user without an explicit Settings override has been on the coarse
timezone-city tier.

Fix is one line: `MAXMIND_LICENSE_KEY` belongs in `deploy.env` (its home per
`deploy.env.example` and the `geoip_sync` comment), not `.env.prod`. A
redeploy then downloads and rsyncs the database.

The related gap — that a wrong or stale stored location had no way to get
noticed or corrected from chat — is [ADR 0148](./0148-a-stale-weather-location-should-ask.md):
a `set_weather_location` tool plus a proactive "you seem to have moved" line
in the briefing.
