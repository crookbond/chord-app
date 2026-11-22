# 0262 — What Chord cannot do gets a search, not a stand-in

**Status:** Accepted, 2026-10-16. Extends ADR 0188 (a request with no
matching tool is a question) and ADR 0039/0153 (`suggest_external_action`).

## Context

Prod, WhatsApp, 2026-10-16:

> **User:** can you generate a picture for me. of a boy running
> **Chord:** I can't create pictures directly … Would you like me to find
> some running boy images online for you?
> **User:** yes
> **Chord:** I've found some images of a boy running on Google Maps …

The model had no way to link to a general search. `suggest_external_action`
had ten kinds, each tied to one subject (restaurant, flight, parcel, …), and
`map` was the only one that took a free-text term, so the model used it for
"boy running". `search_web` (ADR 0164) does have a Google search link as its
fallback, but its description talks only about places and businesses, so the
model did not think of it here. ADR 0188 covers a request that matches no
tool, but only for writes (spreadsheets, trackers). It says nothing about a
request Chord cannot do at all: making a picture, playing a song or video,
making a call, sending a text, buying something.

## Decision

1. **A catch-all `search` kind.** `suggest_external_action { kind: 'search',
   query: { q, searchType } }` opens a Google search. `searchType` is `web`
   (default), `images` (`udm=2`), `videos` (`tbm=vid`), `news` (`tbm=nws`) or
   `shopping` (`tbm=shop`). No terms → no card (`reason: 'no_query'`), since an
   empty search page is not an answer. The link is shown, never fetched
   (ADR 0135).
2. **One rule for what Chord cannot do**, in both prompt catalogues and the
   capabilities block in `context.ts`: say so in one sentence and, where a
   search would help, attach the `search` card **in the same reply**, without
   asking first. The card is described as what it is ("here's an image search
   for…"), never "I found" or "I generated".
3. **`map` is for a real place only**, stated in its description and in the
   rule, so it stops being used as a general search.

## Consequences

- Covers the whole family of open-ended asks (pictures, videos, news, things
  to buy, general lookups) with one kind instead of one per subject.
- Enforced by prompt only. A deterministic check (for example refusing `map`
  for a term that is not a place) was not built: there is no reliable test
  for "is a place", and the prod turn's term ("boy running") carried no image
  words to catch. If the model keeps mis-picking, revisit.
- `search_web` is unchanged. It is still the tool for a question about a
  business that live data should answer; the new kind is for handing the user
  a search to look at.

## Rejected

- **A separate kind per tab** (`images`, `videos`, …): five kinds that differ
  only by a URL parameter.
- **Asking "would you like me to find…?" first**: an extra turn for the one
  thing Chord can offer.
- **Image generation**: a different product decision (cost, provider,
  content policy), not a fix for a wrong card.
