# ADR 0349 — The README, the site and the repository say one thing

**Status:** Accepted, 2026-11-20
**Extends:** ADR 0336 (the website is written for people and bots)

## Context

Chord is being open-sourced (AGPL-3.0-only, `docs/ops/open-sourcing.md`). The
README becomes a second front door next to chordapp.ai: GitHub search and AI
search engines read it, and it should send readers to sign up. The owner's
goal is for the README, the site and the repository to stay in sync and
current, for every use case Chord ships.

Three copies of the same claims drift: the site already had one source
(`scripts/site/content.mjs`, ADR 0336), a hand-written README would be a
second, and the GitHub description and topics a third. And none of them
noticed when a feature shipped without being told anywhere.

The owner also decided the website's source, its pages and the legal texts
stay out of the public repository.

## Decision

1. **The README is generated** by `scripts/site/build.mjs` from
   `scripts/site/README.template.md` (the hand-written parts: intro,
   self-host, architecture, agents, license) and `content.mjs` (features,
   audiences, what you can ask, promises, pricing, FAQ, store links). One
   section and one FAQ entry per feature and audience, phrased the way people
   search. `npm run site:build` writes it; `site:check` fails CI when it is
   stale or was edited by hand.
2. **Repository metadata lives in `content.mjs`** (`REPO`: headline,
   description, topics, README-only FAQ). `scripts/site/repo.mjs` compares the
   live GitHub repository with it (`npm run repo:check`, in CI) and applies it
   (`npm run repo:sync`). Both do nothing until `REPO.slug` is set.
3. **Every new decision record is told or skipped on purpose.** From ADR 0337
   on, each ADR must be in a feature's `basis` (with the claim it supports) or
   in `NOT_ON_SITE` with a reason; the site check fails otherwise. This is
   what keeps the site and README *current*, not just consistent.
4. **The README links only to public files.** `REPO.privatePaths` lists what
   stays private (site source and pages, legal screens, marketing); the check
   fails on a README link into one of them. Screenshots load from chordapp.ai.
   When `REPO.slug` is set the site footer and `llms.txt` link the source.

## Consequences

- A user-visible change now touches `content.mjs` in the same change, as
  CLAUDE.md already asked for the site; CI enforces it through the ADR check.
- Every ADR author decides "is this on the site?" — a small cost, paid by
  whoever writes the ADR, including other sessions and colleagues.
- The public copy (not built yet) is this repository minus `privatePaths`,
  with the privacy, terms and delete-account screens replaced by stubs that
  open the chordapp.ai pages.

## Rejected

- **A hand-written README with a "keep in sync" note** — the note is how the
  three copies drifted to begin with.
- **Generating the site from the README** — the site has pages, structured
  data and Markdown copies the README cannot express.
- **Checking ADRs before 0337** — 330 old records would each need a ruling;
  the rule starts where the site already matched the product.
