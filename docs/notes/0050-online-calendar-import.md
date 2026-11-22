# 0050 — Import a calendar from an online feed (and stop confabulating it)

**Status**: accepted
**Date**: 2026-06-10
**Related**: [ADR 0013 — .ics ingest pipeline](./0013-ics-calendar-ingest.md),
[ADR 0040 — User-owned two-way calendar](./0040-user-owned-two-way-calendar.md),
[ADR 0005 — Iterative tool use](./0005-iterative-tool-use.md),
[ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md)

## Context

A user asked Chord, in a group chat, to *"upload school calendars"* / *"upload
from online resources."* Chord replied **"Importing the school calendars —
events should appear in your calendar shortly"** — but made **no tool call**,
had no URL, no county, no school, and imported nothing. A pure confabulation.

Two root causes:

1. **The prompt told it to lie.** The bot's `.ics` auto-ingest guidance
   (`tools.ts`) carried that exact sentence as the "Right shape" reply. The
   block is meant for *uploaded* `.ics` files (the server auto-classifies those
   on upload — ADR 0013) but the example phrase had **no guard**, so the model
   pattern-matched the words "upload" + "calendar" and parroted the success line
   with nothing attached.
2. **There was no capability.** The bot had no tool to import a calendar from a
   URL or an online lookup, and the server made no user-directed outbound HTTP
   calls at all (only hardcoded Google endpoints). So even the honest answer —
   *"give me the link / county and I'll import"* — pointed at something that
   didn't exist.

## Decision

Build the capability **and** make the bot honest when it can't act.

### 1. New bot tool `import_calendar { url?, district? }`

A write tool (ADR 0005 native + ADR 0003 text-fence) for importing a calendar
from an **online feed** — distinct from an uploaded `.ics` file, which still
auto-ingests server-side with no tool.

- `url` — a public ICS / webcal link the user pasted. Preferred when present.
- `district` — a county / district / school **name**, resolved against a
  **curated registry** (`district-registry.ts`).
- The executor (`executor.ts`) resolves a target, fetches it, and feeds the
  bytes through the **existing** `importIcs` pipeline (ADR 0013) with
  `uploaderId = actorUserId`, so events are **owned by the triggering user**
  (ADR 0040) and group-scoped exactly like an uploaded file. `parseIcsBuffer`,
  `externalUid` dedup, and per-event SSE are all reused unchanged.
- Returns `{ ok, reason?, eventsCreated, eventsDeduped, label }`. The bot
  confirms only on `ok: true` and relays the honest `reason` otherwise.
- `importIcs` gained a `postSummary` flag (default `true`); the tool passes
  `false` so the bot's own turn reply is the single confirmation instead of a
  duplicate 📅 message.

### 2. Curated registry, not web search

Resolving a bare *"Fairfax County"* to a feed URL is done with a small,
hand-maintained name→URL map — **not** a web search. Rationale: a search-backed
lookup is a new external dependency with real reliability risk (wrong/stale
feed URLs imported silently into someone's calendar). The registry is honest
about its limits: unknown names resolve to `null` and the bot asks the user for
the URL or county. Coverage grows by adding entries. *(Product decision,
2026-06-10 — web-search lookup explicitly deferred.)*

### 3. SSRF guard on the outbound fetch

This is the server's first user-directed outbound fetch, so `fetch-ics.ts` is
defensive:

- **https only** (`webcal://` is rewritten to `https://`; `http://` refused).
- Every resolved address is **range-checked before connecting** — private,
  loopback, link-local, ULA, CGNAT, and cloud-metadata (`169.254.169.254`)
  ranges are refused. Redirects are followed **manually**, re-screening each
  hop, so a public host can't 30x-redirect into the internal network.
- Hard caps: ~10 s timeout, ~5 MB body, ≤3 redirects.
- Content sniff: accept `text/calendar` **or** a body starting with
  `BEGIN:VCALENDAR` (many district hosts serve ICS as `text/plain`).
- Typed `CalendarFetchError` (`not_https` | `blocked_host` | `unreachable` |
  `http_error` | `too_large` | `timeout` | `bad_content`) → the bot gives a
  specific, honest failure message.

**Residual risk:** we resolve-and-screen the hostname, then let `fetch` connect
by name, leaving a small DNS-rebinding TOCTOU window. Screening *all* resolved
addresses and re-screening each redirect closes the common cases; full
connect-time IP pinning is future hardening if this surface grows.

### 4. Honesty gating in the prompt

The `.ics` guidance (both `NATIVE_TOOL_PROMPT` and `TEXT_FENCE_TOOL_PROMPT`)
now splits **uploaded file** vs. **online feed**:

- The "Importing the calendar — events should appear shortly" phrasing is gated
  on a calendar file **actually attached this turn**.
- An **anti-confabulation** clause (mirroring the `suggest_external_action`
  one): never imply an import happened unless a file is attached **or**
  `import_calendar` returned `ok: true`. With neither a URL nor a recognized
  district, ask — don't pretend.
- `import` / `subscribe` / `upload` were added to `DEFAULT_IMPERATIVE_VERBS`
  (`kernel/bot-persona.ts`) so a prose-only non-answer to *"@chord import the
  school calendar"* trips the existing strict-mode retry as a backstop.

## Alternatives considered

1. **Prompt-only honesty fix (no capability).** Cheapest — stop the lie, ask for
   a URL. Rejected as insufficient: the user explicitly wants the import to
   actually work, and "tell me the county and I'll import" must be true.
2. **Web-search the district's feed.** Most powerful "name → calendar" UX, but a
   new external dependency and a silent-wrong-import hazard. Deferred to backlog.
3. **Host allowlist instead of an SSRF guard.** Safest, but rejects unknown
   school-district websites — most real feeds wouldn't import. Chose the
   public-fetch-with-guard posture so arbitrary public ICS URLs work.

## Consequences

- The server now makes user-directed outbound HTTP. The SSRF guard is the
  security boundary; any future "fetch a user URL" feature should reuse
  `fetch-ics.ts`'s IP-screening helpers rather than calling `fetch` directly.
- Registry coverage is small and manual — expected, and surfaced honestly to the
  user when a name misses.
- Uploaded-file auto-ingest behavior is unchanged; only the prompt's framing of
  it (and the false success phrase) changed.
