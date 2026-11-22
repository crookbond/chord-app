# ADR 0350 — The open-source repository is built from this one

**Status:** Accepted, 2026-11-20 (live: github.com/crookbond/chord-app, published weekly)
**Extends:** ADR 0349 (one source for the README, the site and the repository)

## Context

The owner wants two repositories: this private one, where all work happens,
and a fully open-source one (AGPL-3.0-only), updated weekly. Making this
repository public would publish its whole history, and with it every real
email address, phone number and name that the bug-test rule puts in tests
and ADRs ("use the real values from the prod incident"). That rule keeps
adding new ones every week, so a one-time scrub cannot keep the public copy
clean.

The owner also decided the website's source and pages and the legal texts
stay private, and that the public copy should still build and run.

## Decision

1. **One direction, private to public.** `scripts/public/export.mjs` builds
   the public tree from the files git tracks here, and
   `scripts/public/publish.mjs` commits it to the public repository as one
   `Release <date>` commit. No private history leaves.
2. **What stays private** is `REPO.privatePaths` plus the website's generated
   pages (its manifest). The privacy, terms and delete-account screens become
   stubs that open chordapp.ai (`REPO.stubbed`). Scripts and CI steps that
   need the private parts are taken out of the public `package.json` and
   `ci.yml`, and the public `CLAUDE.md` says what is missing.
3. **Personal data is swapped, then scanned.** `scripts/public/scrub-map.json`
   (private) maps each real value to a placeholder, applied in every file and
   file name, in any case, and URL-encoded. A placeholder keeps the real
   domain, because tests read it (log masking keeps `***@gmail.com`), and
   keeps the length where a test checks it. Then real people's **names** (the
   owner's family, colleagues, contacts from prod incidents, the children's
   school) are swapped for made-up ones (`names`) as whole words: never
   inside a longer word, but inside an id (`u_<name>`), an address, a
   camelCase name and after an escape (`\n<Name>`). Names are kept as names, not removed, so
   the incident write-ups and tests read the same. `keep` phrases (the
   copyright line) are never changed. After the swap, a scanner refuses the
   export if any address at a personal mail domain (or a watched company
   domain), any non-fictional North American number (with or without +1),
   or anything secret-shaped is left that the map does not mark as a made-up
   fixture.
4. **The public copy must work on its own.** The weekly workflow
   (`.github/workflows/publish-public.yml`, Mondays) installs the exported
   tree, lints, typechecks, builds and runs the whole test suite in it before
   publishing. A swap that breaks a test stops the release, not the public
   repository.
5. **Contributions come back by hand.** Pull requests are accepted on the
   public repository (CLA required), brought into this one, and go out again
   with the next release. `publish.mjs` refuses to publish over a commit it
   did not make, so nothing merged there is silently undone; an empty
   `[imported]` commit there marks such a change as brought over.

Until `REPO.slug` is set the workflow is a dry run: it builds and tests the
public copy every week and pushes nothing.

## Consequences

- A new real value in a test or ADR makes the next weekly export refuse,
  naming the file and line. The fix is a line in `scrub-map.json` (`replace`
  for a real value, `allow` for a made-up one), never an edit in the public
  repository.
- First dry run (2026-11-20): 2,210 files exported, 121 left out, 246 values
  swapped (31 distinct). The 63 test files whose data changed pass in the
  public copy (707 tests). Three failed on the first attempt and shaped the
  rules in point 3: a domain change, a URL-encoded address, and a length
  check.
- Names cannot be scanned for the way addresses can: a new real name in a
  test or ADR stays in the public copy until it is added to `names`. Add it
  in the same change (CLAUDE.md says so). Made-up fixture names (Priya,
  Ananya, Ruth Chen) are left alone.
- Same day, with names: 5,731 values swapped (101 distinct); a bare
  phone number in a test (`860-555-0135`) and real work addresses (Deloitte,
  BCG, RudderStack, the school) were found by the wider search and swapped
  too. All 285 test files the swap changed pass in the public copy. A made-up
  name has to behave like the real one where a test leans on it, which is
  what broke on the first runs: a test types a prefix of the name, sorts the
  children by name, or checks a name's length, so the made-up name keeps
  that prefix, that order or that length; and the swap must reach camelCase
  identifiers and text after an escape. Stopwords, nicknames and names the
  list stemmer shortens ("Will", "Zack", "Zane") do not work.

## Rejected

- **Making this repository public** — publishes every past version of every
  file.
- **A one-time scrub of a fresh copy** — the next week's tests bring new
  real values.
- **Changing the bug-test rule to placeholders** — the real values are what
  make a reproduction trustworthy; the swap happens on the way out instead.
- **Placeholders on `.example` domains** — broke tests that keep the domain.
- **Publishing without running the tests** — a swap can break a test, and the
  public repository should never be the place that finds out.
