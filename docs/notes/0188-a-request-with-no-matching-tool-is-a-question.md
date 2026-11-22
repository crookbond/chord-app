# 0188 — A request with no matching tool is a question, not a guess

**Status**: accepted
**Date**: 2026-09-17

## Context

The bot's tool-firing prompt (`NATIVE_TOOL_PROMPT`/`TEXT_FENCE_TOOL_PROMPT` in
`tools.ts`) is a long list of per-phrasing rules mapping specific wording
onto a fixed, closed catalog of things Chord tracks: tasks, lists, saves,
events, trips, contacts, receipts. Nowhere did it say what to do when a
request doesn't match any of them — "add this to a spreadsheet with columns
for X/Y/Z", "build me a tracker for calories with a running total". Two
mechanisms compounded the gap:

1. "Tool-firing is the default" tells the model any imperative verb
   ("add…", "track…", "save…") MUST produce a tool call — never prose alone.
2. `bot.service.ts`'s imperative-verb retry (`shouldRetryImperative`) forces
   a second pass with a STRICT MODE system message whenever an imperative
   opened the message and the first pass fired no tool, explicitly saying
   "do not reply with prose only — the user expects you to act."

So a genuinely unbounded ask had exactly two outcomes, both bad: silently
answered in prose with nothing recorded (if the model didn't try a tool on
the first pass and the retry logic didn't trigger), or forced into whichever
existing tool loosely resembled it — a spreadsheet request crammed into one
`add_list_item` call, reported back as if it had done what was asked. The
second case is the ADR 0102 confabulation failure ("a failed tool does not
get to explain itself") recurring one layer up: this time there's no failed
tool call to catch, because the tool "succeeded" — it just wrote the wrong
shape of thing and said so with confidence.

Separately, `context.ts`'s system-prompt opening was just "You are Chord, an
AI assistant embedded directly in a group chat" — no stated scope. A user
asking "what can you do" got the model improvising an answer with no
canonical description to draw from, and the model itself had nothing to
anchor "does this actually fit one of my tools" against.

## Decision

Two prompt-only changes, no schema/migration, following the same
tell-the-model-at-the-choke-point pattern as ADR 0100/0102/0132:

1. **`context.ts`** — the system-prompt opening states what Chord does and
   doesn't do in two short paragraphs: connects to email/calendar/reminders
   and helps manage them; learns the family over time and helps track
   people, dates, trips, groceries/lists, saved places, receipts/bills owed;
   cannot make bookings or purchases (link out, never transact — consistent
   with ADR 0107/0135/0138/0153's "we render the link, we never fetch/book"
   posture); cannot build a freeform spreadsheet or custom tracker with
   arbitrary columns — it works through the fixed set of things above. This
   gives the model (and a user who asks "what can you do") a single honest
   answer instead of an improvised one.

2. **`tools.ts` + `bot.service.ts`** — a narrow, explicit exception to
   "tool-firing is the default": when none of the existing primitives
   (task/list/event/save/trip) can represent what's being asked, the model
   does not force a mismatched write into the nearest tool, and does not
   stay silent either. It names the closest existing primitive in one
   sentence and asks before acting ("I can't build a custom spreadsheet, but
   I could track that as a list — want me to?"), firing the tool only once
   the user confirms the substitute. The same exception text is added to
   `NATIVE_TOOL_PROMPT`, `TEXT_FENCE_TOOL_PROMPT`, and the STRICT MODE
   imperative-retry message in `bot.service.ts` (all three places that
   currently say "you must fire a tool"), each paired with an explicit
   "this is narrow — don't use it to dodge a tool call that does fit."

## Alternatives considered

- **A generic schemaless tracker** (a `trackers` table with user-defined
  columns, a bot tool that writes arbitrary JSON rows) — rejected. Every
  other primitive in this system earns real behavior from being a closed,
  typed vocabulary: dedup (ADR 0092/0095), archiving, search, briefing
  lines. A schemaless entity gets none of that for free, and turns the
  model into an ungoverned schema designer per request — the "second
  product" trap ADR 0149 named for email surface creep, here for the core
  data model instead.
- **Always force the nearest tool, no exception** (today's behavior) —
  rejected as the thing being fixed: it produces a real write in the wrong
  shape, reported as success. Worse than a failed tool call, because
  nothing flags it as wrong.
- **Leave it silent** (no imperative retry at all for the unmatched case) —
  rejected: the user has no idea nothing happened, which is worse than
  being asked a clarifying question.

## Consequences

Purely a prompt change — no new tool, no schema, no migration. It can't be
perfectly enforced: a model could still invoke the exception to dodge a
real tool call that does fit, which is why the instruction is written
narrowly and paired with an explicit anti-abuse clause, matching the known
limit every instruction-only fix in this codebase (ADR 0100, ADR 0102)
already accepts — prompt-level guardrails bound behavior, they don't prove
it. No automated test can verify model judgment here; the existing
prompt-content regression suites (`auto-ingest-prompt.test.ts`,
`save-link-vs-list-prompt.test.ts`, `where-is-prompt.test.ts`, all passing
unchanged) only pin that the surrounding instructions are still present.

If a real, repeated pattern of legitimate cross-cutting tracking needs
emerges — the same signal that justified giving trips (ADR 0132) and
receipts (ADR 0160) their own typed primitive — that's the trigger for a
new tool, not a reason to build the generic tracker rejected above.
