# References

Inputs from outside the project: requirements docs, brainstorms, feature requests, discussion transcripts, research notes, user interviews, competitive teardowns.

## How to treat what's in here

> **These are references, not contracts.** Satisfy the *spirit* of each document. Don't translate every bullet point into a ticket.

When you read a reference doc:
- Look for the **underlying intent** — what problem, what feeling, what workflow.
- Spot the **signal vs. noise** — one-liners someone tossed in that won't survive a week vs. the themes that keep recurring across documents.
- Cross-check against what already exists in [`../features.md`](../features.md) and the [ADRs](../notes/) before proposing new work.
- When a reference drives a real decision, **write an ADR** in `docs/notes/` so the decision outlives the reference.
- When a reference drives a real feature, **add it to `docs/tasks/`** with a link back here.

Don't:
- Copy requirement text directly into code comments or commit messages.
- Treat a brainstorm as a commitment.
- Implement every detail a reference mentions — that's how demos become bloated.

## What to put here

| ✓ Goes here | ✗ Belongs elsewhere |
|---|---|
| A colleague's feature brief | → read here, then capture decisions in `docs/notes/` |
| Slack discussion transcripts | → same |
| User interview notes | → same |
| Competitive teardowns | → same |
| Screenshots of another product's UI | → same |
| A PRD or spec someone emailed | → same |
| Our own design notes for work in progress | → `docs/plans/` |
| Completed decisions | → `docs/notes/` (ADR) |
| Concrete TODOs | → `docs/tasks/` |

## Filename conventions

- `descriptive-slug.md` — e.g. `potluck-flow-brief.md`, `john-feature-requests.md`
- Prefix with `YYYY-MM-DD-` if the doc is time-sensitive or there will be follow-ups (e.g. `2026-04-20-design-review.md`)
- Markdown is strongly preferred. If a colleague sends a `.docx` / `.pptx` / `.xlsx`, **rewrite it to `.md` before committing** — `*.docx`/`*.pptx`/`*.xlsx` are `.gitignore`d at the repo root. Preserve the source content as faithfully as possible; drop a note at the top of the rewrite linking back to the original filename.
- HTML is acceptable when the original carries visual layout that markdown can't reproduce (e.g. phone-screen mockups). PDFs are OK too.
- Keep filenames short; the index below is where longer context lives.

## Index

Add a one-liner here when you drop a new doc in, so future readers know what's relevant.

| File | What it is | Date added |
|---|---|---|
| [`chord_demo_flows.html`](./chord_demo_flows.html) | Original demo-flow brainstorm — five annotated phone-screen flows (Miami trip, Costco list, John personal chat, potluck RSVP, potluck status). Single source of intent for the product vibe; map it against `../features.md` before implementing anything from it. | 2026-04-17 |
| [`chord-spec-v4.md`](./chord-spec-v4.md) | Product Spec v4.0 — WhatsApp-first, app-complete, account-owned. Three-layer architecture, intent types, tasks/trips/memory/saves models, full backend schema. The master reference; other three docs are addenda. | 2026-04-17 |
| [`chord-companion.md`](./chord-companion.md) | Companion-app addendum — auth paths (email admin vs. WhatsApp OTP member), the personal 1:1 AI chat, context-scope rules (my things / shared / never), proactive-message policy. | 2026-04-17 |
| [`chord-docperms.md`](./chord-docperms.md) | Document permissions addendum — Private vs. Group, always-shown picker, index-time vs. query-time enforcement, cross-group fallback search. | 2026-04-17 |
| [`chord-identity.md`](./chord-identity.md) | WhatsApp identity resolution addendum — three trust tiers (Verified / Admin-assigned / Unknown), resolution flow, access matrix. | 2026-04-17 |
