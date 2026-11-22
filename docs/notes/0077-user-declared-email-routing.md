# 0077 — User-declared email routing: "school email → family group"

**Status**: accepted
**Date**: 2026-07-19

## Context

The magics group-router (ADR 0063) decides which of the owner's groups an
email-derived suggestion targets with one LLM call over the group *names* +
subject/preview. That works when groups are meaningfully named and fails
quietly otherwise — and even when it works, the user has no way to *state*
the routing they want. Owner asks (2026-07-19): let the user declare rules
("email from school → family group"), and when the bot needs a group name,
**go back and forth until the name is exactly clear — never fuzzy-match**.

## Decision

### Deterministic rules before the LLM

`email_routing_rules` (migration 031): per-user rows of
`kind ('sender_domain' | 'category') + pattern → target_group_id`, unique on
(user, kind, pattern), FK-cascaded on both user and group.
`matchRoutingRule` runs **first** in the magics routing step; only unruled
email falls through to the LLM matcher. Matching is intentionally simple:

- `sender_domain`: the sender's domain or any subdomain
  (`lcps.org` matches `teacher@mail.lcps.org`).
- `category`: case-insensitive **substring** of the classifier category
  title (`school` matches "School notes") — users say "school", not the
  exact taxonomy label. (The rule *pattern* is forgiving; the *group* never
  is — see below.)

Scope: a rule can only target a group the user belongs to — enforced when
the rule is written and **re-checked at match time**, so a rule whose group
the user left silently stops firing (ADR 0032 can't leak via stale rules).

### Chat-first rule management, exact-name-or-ask

New personal-only bot tools (PERSONAL_ONLY_TOOL_NAMES — a shared group has
no business seeing where a user's mail routes):

- `set_email_route { pattern, groupName, remove? }` — kind inferred
  (`inferRuleKind`: dotted no-space pattern → domain, else category).
  **Group resolution is exact case-insensitive, or the tool refuses**: zero
  or multiple matches return `{ ok:false, candidates:[names…] }` and the
  tool description instructs the model to list the candidates verbatim, ask
  the user, and call again with the exact name — the ADR 0051 follow-up
  window carries that back-and-forth without re-mentions. Same
  never-guesses contract as `update_event`/`delete_event`.
- `list_email_routes` — read-only listing.

### Matcher grounding + visible destination

- The LLM matcher (fallback path) now receives the user's **confirmed
  persona memories** ("kid_school: Lincoln Elementary") — a school email
  finds the family group by fact, not group-name luck. Proposed memories
  are never included.
- `EmailMagicSuggestion.targetGroupName` (batch-joined in
  `pendingSuggestionsForThreads/ForUser`) renders as a "→ Doe Family"
  chip on the suggestion card and in the briefing line — the user sees
  where a confirm will land *before* tapping, and a mis-route is visible
  enough to prompt "no — send school stuff to X", which mints a rule.

## Rejected alternatives

- Fuzzy group-name matching in the tool — rejected by owner: routing writes
  into a shared group; a wrong guess is a trust break. Ask until exact.
- Learning rules implicitly from confirm/reject behavior — deferred; the
  explicit chat-declared rule is predictable and auditable.
- A settings-screen rule editor — chat-first per the repo's pattern
  (cf. the Workstream K allowlist design); can be added later over the same
  service.

## Consequences

- First rule match wins in creation order; overlapping rules are possible
  but benign (both target groups the user chose). Revisit ordering only if
  real users hit it.
- Category rules depend on the classifier being enabled; sender-domain
  rules work regardless.
- The matcher prompt now carries confirmed memories — same privacy posture
  as the bot prompt itself (owner's own facts, owner's own extraction).

Tests: `routing-rules.integration.test.ts` — kind inference, domain +
substring matching, membership gating on match, deterministic routing with
the LLM matcher asserted NOT to run, and the tool's exact-or-candidates
contract (vague name creates nothing).
