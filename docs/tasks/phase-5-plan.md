# Phase 5 — From demo to multi-developer app

**Status**: in planning
**Owner**: John
**Started**: 2026-05-03

Chord's demo phases (0–4) optimised for a single-machine narrative
demo. Phase 5 turns it into something multiple developers can work on
and real users can sign into. The product thesis tightens: **the bot
plans family life around what's actually on the user's calendar, what
it knows about the family, and a small set of editable prompts.**

This doc is the sequencing plan. The non-obvious "why this and not the
alternatives" decisions live in:

- [ADR 0014 — Google-only auth](../notes/0014-google-only-auth.md)
- [ADR 0015 — Server-side Google Calendar write (`Chord` calendar)](../notes/0015-server-side-google-calendar.md)
- [ADR 0016 — Family graph in SQLite](../notes/0016-family-graph-in-sqlite.md)

ADR 0015 partially supersedes [0012](../notes/0012-proactive-event-scanning.md):
the device-calendar-sync section is replaced. Nudge mechanics are
unchanged.

## Phases

### A — Multi-developer foundation (do first)

Cheap to do now, painful to retrofit.

- [ ] **Per-developer secrets**. `.env` is committed-defaults only;
      real secrets in per-dev `.env.local` (gitignored, already in
      `.gitignore`). Document a shared 1Password / vault entry for
      Google OAuth client + LLM keys. Add a "where do I get these?"
      section in `README.md`.
- [ ] **Migrations as forward-only numbered files**. The current
      `npm run migrate` is fine; tighten the convention so two devs
      adding migrations on parallel branches don't collide. Add a
      `migrations/README.md` if missing.
- [ ] **Decide auth model**. Resolved by ADR 0014: Google-only for
      real users, demo-session retained behind `LLM_PROVIDER=mock` for
      tests + CI.
- [ ] **CI baseline**. `npm run verify` already exists. Wire a GitHub
      Actions job that runs it on PR. No deploy yet.

### B — Google auth + calendar

Reads + writes against the user's Google account.

- [ ] **OAuth flow** (ADR 0014). `expo-auth-session` PKCE on mobile;
      server-side token exchange and refresh. Encrypted at-rest token
      storage on the user row (AES-GCM with a `MASTER_KEY` env var).
- [ ] **Scopes**. `openid email profile` at sign-in. Calendar scopes
      (`calendar.calendarlist.readonly`, `calendar.events`) requested
      separately, behind the "Import calendar" / "Connect calendar"
      button. Don't bundle them into login.
- [ ] **Import calendar button**. Reads the user's primary calendar
      events for the next 90 days, materialises them into Chord's
      `events` table (or a new `external_events` shadow), tagged with
      `source='gcal'` and the original event id.
- [ ] **`Chord` calendar creation**. On first server-side write,
      `calendars.insert({ summary: 'Chord' })` and persist the
      returned id on the user. All Chord-generated events / trips /
      reminders write here, not the primary calendar.
- [ ] **Bot tools to write to GCal**. `create_event`, `create_trip`,
      `create_reminder` gain a side-effect that posts to GCal after
      the SQLite row is committed. Failures don't roll back the row;
      a `gcal_sync_status` column tracks state and a small retry
      worker drains failures.
- [ ] **One-way sync only** (ADR 0015). Chord → Google. No webhook
      channels, no conflict resolution. If the user edits/deletes in
      Google, Chord is not the source of truth and doesn't try to
      reconcile.

### C — Centralised prompt + nudge subsystem

Today prompts live inline in `bot.service.ts` and `context.ts`.

- [ ] **`server/src/prompts/`**. Templated `.md` files loaded at
      startup, hot-reloadable in dev. Layout:
      ```
      server/src/prompts/
        system/
          chat.md
          nudge.md
        nudges/
          daily.md
          birthday.md
          event-created.md
        partials/
          family-context.md
          calendar-context.md
          holidays.md
      ```
- [ ] **Templating**. Mustache or plain `${var}` interpolation.
      Resist anything Turing-complete — prompt files must read top-to-
      bottom by a non-engineer.
- [ ] **Holiday awareness**. `date-holidays` library (or a
      hand-curated `holidays.json` per locale) materialised into the
      `holidays.md` partial. The LLM is *fed* the relevant holidays
      for the next N days, not asked to know them.
- [ ] **Daily nudge job uses templates**. ADR 0012's
      `daily_morning_scan` proactive kind keeps its mechanics; only
      the prompt assembly moves into the new subsystem. Body template
      = `nudges/daily.md` + `partials/family-context.md` +
      `partials/calendar-context.md` + `partials/holidays.md`.

### D — Memory: profile + family graph

Two layers, deliberately separate.

- [ ] **User/family profile JSON** (per user). A flat doc on the user
      row holding contact details, addresses, preferences. Bot tools:
      `read_profile`, `update_profile`. Source of truth for the user's
      *own* settings only — not for facts about other people.
- [ ] **Family graph** (relational, ADR 0016). Tables:
      - `people(id, owner_user_id, display_name, ...)`
      - `relationships(from_person_id, to_person_id, kind)` — kind ∈
        `parent | child | spouse | sibling | grandparent | ...`
      - `important_dates(person_id, kind, date, recurs)` — kind ∈
        `birthday | anniversary | death | other`
      - `addresses(person_id, label, address_text)`
      - `contact_methods(person_id, kind, value)` — kind ∈
        `email | phone | other`
- [ ] **Graph queries**. SQLite recursive CTEs. Don't reach for a
      graph DB at family scale.
- [ ] **Source-of-truth rule** (ADR 0016): graph is canonical for any
      person other than the user. Profile JSON is canonical for the
      user's own preferences and account-shaped data. Addresses for
      *people* live in the graph; the user's own address lives in the
      profile.

### E — Wire family graph into nudges

Pulls C and D together.

- [ ] **`family-context.md` partial**. Renders "people within 2 hops
      with a birthday in the next 14 days, plus their addresses if a
      card is plausible". Implemented as a SQL view or a service
      function returning a typed struct; the partial just iterates.
- [ ] **Tunable depth + window**. The two-hop limit and the 14-day
      window are constants in the service, not in the template — so
      the prompt remains declarative.
- [ ] **Provenance**. Each nudge line carries the person id(s) it
      came from, surfaced in a future "why did Chord nudge me about
      this?" drill-down (analogue of Phase A's `source_raw_context`).

## Open questions

- **Q1 — Calendar import scope**. Read all calendars the user has
  access to (including shared/family) or just primary? Lean primary
  for now; add multi-calendar in a follow-up.
- **Q2 — Profile vs. graph overlap**. We've ruled the user's own
  address into the profile. What about the user's own birthday? Lean:
  also profile, not graph. The graph is for *other* people.
- **Q3 — Token revocation**. If the user revokes Google access in
  their Google account settings, our refresh token starts failing.
  Surface this in the UI as a re-connect prompt; don't silently retry
  forever.
- **Q4 — Multi-user families**. Two members of the same family both
  signed into Chord — do they share one family graph? Lean no for
  now: each user has their own graph, even if it overlaps. Merge
  later via explicit "shared family" invite.

## Sequencing rationale

A is a prerequisite for B (auth model has to be settled before OAuth
ships). B before C because the calendar-context partial needs real
calendar data to be worth templating. D can run in parallel with C —
they touch different files. E is the integration step and lands last.

Pick up [`demo-tasks.md`](./demo-tasks.md) is the prior focus; this
plan is what comes after the investor demo lands.
