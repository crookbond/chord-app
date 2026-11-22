# 0083 — Email Stage 1 shell: decisions on tiles

**Status**: accepted
**Date**: 2026-07-31

## Context

[`docs/tasks/chord_email.md`](../tasks/chord_email.md) reframes the Email AI
tab as a **decision queue**, not an unread map. ADR 0068 made tile area
proportional to `attention` (unread ∪ pending-magic) and opened a category
**thread list** on tap. That still teaches "clear unread" and hides pending
proposals whose source thread is unclassified or archived (`loadAttention`
skipped `category_id IS NULL` and archived rows), so a decision could vanish
from Email and live only in To Do's — breaking the trust rule that nothing is
silently filed.

Stage 1 must ship as a **shell** (query + render) with no new extraction,
autonomy tiers, or SMTP ingest. Structural gaps (T0/T1/T3, provenance FK,
signals, Opportunity) stay in later stages.

## Decision

1. **`GET /me/email/decisions`** returns every pending `gmail:`-provenance
   proposal for the owner, left-joined to the local thread: `categoryId` /
   `categoryTitle` / `threadRowId` / `dueAt` / `archivedSource`, plus
   `coverage: { handledToday, unreadable }`. Unclassified, archived, or
   missing threads yield `categoryId: null` (Unsorted) — never dropped.
2. **Tile tap opens decisions** for that category's subtree (batched by kind:
   events together; list items by list name), with **Add all** / **Review** and
   a **sources** footer back to the thread list.
3. **Badge and map area follow open decision counts**, not `attention`. Floor
   weight is scaled by the existing usefulness boost/damp so family-first /
   promotions-last order survives a zero-decision day. `attention` stays on
   the wire; the AI map stops reading it. **Amends ADR 0068's weighting.**
4. **Urgent strip** above the map: event decisions with `dueAt` within 7 days,
   soonest first, cap 3. Confirm uses the normal proposal route; **Not now**
   is client-local (AsyncStorage until ~72h) and must never call reject.
5. **Coverage footer** + Unsorted row keep honesty visible. Junk moves into an
   Email-tab long-press folder sheet. Forward-to-Chord is a thin hatch (show /
   copy personal `ingestEmail`); SMTP receive stays a follow-up.

## Alternatives considered

- **Enrich `GET /me/proposals`** — shared DTO across chat/trip/person flows;
  would force every consumer to ignore email join fields and still need a
  client N+1 for category. Rejected for a scoped email endpoint.
- **Keep attention weighting, change only the badge** — unread would still
  dominate the map and fight §3.2. Rejected.
- **Reject on Not now** — would poison Stage 4 telemetry (Not now ≠ Never).
  Rejected.
- **Full SMTP Forward-to-Chord in Stage 1** — ops-heavy (MX, DMARC, port 25);
  cut from F&F as Workstream K. Deferred.

## Consequences

- Clients that assumed tile tap → threads must use the sources footer (or
  Traditional) for browsing.
- ADR 0068's "area ∝ attention" half is superseded for the AI map; nested map
  + bottom sheet shape remains.
- Miss-rate instrumentation still needs inbound SMTP. **Addendum 2026-08-21:
  the hatch is REMOVED from Settings.** An inert address is not a neutral
  placeholder — `groups.ingest_email` is minted at `@chord.app`
  (`groups.service.ts`, hardcoded), a domain this project does not own or use
  anywhere else (everything real is `chordapp.ai`), so a tester who took the
  caption as merely "not yet" and forwarded family mail would send it to a
  third party's MX. A caption is not a control. The column, the kernel
  `Group.ingestEmail` field and the route projection all stay, so restoring the
  card is a paste-back once Workstream K ships and mints the address at a
  domain we control.
- Stages 2–5 of `chord_email.md` are unchanged: archetypes, reconcile/tiers,
  signals, Opportunity.

## Addendum 2026-10-20 — the strip's ✕ dismisses, and an email can be put away

- The urgent strip ("Needs your attention") ✕ was a local **Not now** that
  never rejected, so the same suggestion stayed in Feed, Cards and Action
  Items after the user had dismissed it. It now **rejects** the suggestion,
  the same as ✕ everywhere else; one action means one thing in every view.
  Not-now hides already stored on a device still apply until they lapse.
- Beside the ✓/✕ in Action Items, the strip, and Feed/Cards/Sections cards,
  an icon **archives or trashes the source email** (the swipe setting, ADR
  0215, picks which) and dismisses that suggestion. Trash also withdraws the
  email's other pending suggestions (ADR 0073/0215); archive leaves them. Not
  shown inside the email itself, which has its own Trash/Archive.
- Chat: `trash_email` already exists; there is still no `archive_email` bot
  tool (archive was already app-only via the swipe).
