# 0336 — The website is written for people and for bots

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

chordapp.ai was the Expo web app's root route (`mobile/app/index.tsx`), with
`"output": "single"` in `mobile/app.json`. A visitor's browser ran the bundle
and drew a landing page; anything that does not run JavaScript received
`mobile/public/index.html`: an empty `<div id="root">` and "You need to enable
JavaScript to run this app." ChatGPT, Claude, Perplexity and most AI search
fetchers do not run JavaScript, so to them Chord had no website. The landing
copy had also gone stale ("First 30 days, free", retired by ADR 0325), and
nothing on the site showed the product or linked the app stores.

The owner's goal: show what the email reader does, with screenshots, and make
it easy for AI assistants to recommend Chord as the action-oriented email
reader.

## Decision

1. **The marketing site is static HTML, generated.** `scripts/site/content.mjs`
   holds every claim (features, examples, audiences, comparisons, FAQ, prices,
   changelog); `scripts/site/build.mjs` renders it into `mobile/public/`, which
   `expo export` copies into the web build. Pages: home, `/email-reader`,
   `/features` + one page per feature, `/for/{parents,families,professionals}`,
   `/compare` + one page per competitor, `/pricing`, `/security`, `/faq`,
   `/how-to`, `/changelog`, `/download`. Paths are chosen to never collide with
   an app route (a test reads `mobile/app` and fails on a collision).
2. **Every page is written twice**: HTML for people, Markdown for AI tools
   (`/pricing.md`), from the same sections so they cannot disagree. Plus
   `llms.txt` (a fact card with links to every Markdown page), `llms-full.txt`
   (all of them), `robots.txt` that names the AI crawlers and allows them,
   `sitemap.xml`, and schema.org JSON-LD on each page (Organization,
   SoftwareApplication with offers and feature list, FAQPage, HowTo,
   BreadcrumbList). No ratings or reviews are marked up - there are none to
   cite, and invented ones are what search engines penalise.
3. **`/` is the static home page unless the visitor is using the app.** nginx
   (`templates/nginx-chord-website{,-map}.conf`, installed every deploy) serves
   `home.html` at `/` when the request has no `chord.sid` cookie (ADR 0316) and
   no query string; otherwise the app. Two cases still belong in the app and
   cannot be seen by nginx: Apple's web sign-in returns to `/` with its answer
   in the fragment, and a web user the app remembers in `localStorage` (ADR
   0311) may arrive without a readable cookie. `site/handoff.js`, the only
   script on the site, sends both to `/?app=1`. The site's Sign in links go to
   `/?signin=1`, which scrolls the app's landing page to the sign-in card.
4. **Claims are things Chord does today, and comparisons are fair.** Each
   feature lists the ADRs it rests on (`basis`). Comparison pages say what the
   other product does better, carry the date they were checked, and invite
   corrections. Meaning search (ADR 0276, off by default) is not claimed.
   The comparison pages are written for AI tools, not for people browsing
   (owner, 2026-11-12): no page outside `/compare` links to them, while the
   sitemap and llms.txt still list them. A test keeps it that way.
5. **Screenshots come from the real app with made-up data.**
   `server/scripts/site/seed-demo.ts` builds a demo family (Maya and Sam Patel)
   with a week of mail, suggestions, calendar, to-dos, lists and a trip, and
   refuses any database whose name lacks `site` or `demo`. Captured images go
   in `mobile/public/site/shots/`; a page shows a screenshot when one exists
   and otherwise a drawn example of an email and the cards made from it.
6. **CI checks it.** `npm run site:check` fails when the committed pages differ
   from the generator, a link is broken, a page lacks a title, description,
   canonical link or valid JSON-LD, a store link is missing, a site path is not
   routed by nginx, or a retired claim ("30 days") comes back.

## Consequences

- Anyone changing what Chord does should change `content.mjs` in the same
  change; `npm run site:build` regenerates every page, the Markdown copies and
  llms.txt together.
- Prices on the site are the defaults from `server/src/config/env.ts`. A deploy
  that overrides `PRICE_*` must change `PRICING` too; the site cannot read the
  server's config.
- The App Store and Google Play links are only as live as the listings.
- Off-site work (store listings, Product Hunt, review sites, forum posts) is
  drafted in `docs/marketing/` but needs a person to post it. AI assistants
  weigh what other sources say about a product at least as much as its own
  site.

## Rejected

- **`"output": "static"` for the whole Expo app** - static-renders every app
  screen at build time, including signed-in ones that read browser storage on
  first render; a large change to the app to fix a marketing problem.
- **Marketing markup inside `index.html`'s `#root`** - every signed-in user
  would see the marketing page flash before the app replaced it, the problem
  ADR 0254 fixed.
- **A separate marketing domain or CMS** - another thing to deploy and keep in
  step with the app; the generated files ship with the deploy that changes the
  product.
- **Superlatives ("the best email app")** - unverifiable claims are the ones AI
  tools discount and the ones that carry false-advertising risk. The site makes
  specific, checkable claims instead.
