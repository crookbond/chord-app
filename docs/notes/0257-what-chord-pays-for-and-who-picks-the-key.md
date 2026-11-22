# 0257 — What Chord pays for, and who picks the key

**Status**: accepted. A living inventory: adding an external dependency means adding
a row here, in the same change.
**Date**: 2026-10-16
**Relates to**: ADR 0063/0079/0195/0196 (billing and entitlement), 0251 (BYOK is free),
0252 (own-key health)

## Context

Nothing listed, in one place, the outside services Chord pays for. The cost sat in
dozens of ADRs, and the question that matters when billing is switched on — *which of
these does a plan have to cover, and which does billing actually guard?* — had no
answer. Compiling it from the code found a real defect: eleven call sites asked for
Chord's own model (`getLlm()`) instead of the user's. A BYOK user's email suggestions,
people extraction, morning briefing, attachment indexing and memory extraction ran on,
and were paid for by, Chord, and a dead key never showed on any of them.

## Decision

### 1. One function picks the key

`getLlmForUser(db, userId)` (`services/llm/factory.ts`) is the only way to reach a
model: the user's own key when they have one, else Chord's (no user, no stored key, or
a key that will not decrypt). Every site was moved onto it — the briefing and trip
nudge, email suggestions and people extraction, attachment summary / questions / OCR,
content and trip classifiers, post-turn memory extraction, forms, the WhatsApp import —
and `getLlm()` is now private in practice: a test
(`one-key-chooser.test.ts`) fails the build if any service calls it. **For a BYOK user,
all AI runs on their key.** A user's own-key calls are also the ones `withKeyHealth`
watches (ADR 0252), so the "your key is out of credit" nudge now covers all of it.

### 2. The inventory

**A. Metered by use — grows with users**

| Service | What uses it | Meter | BYOK user | Guarded by billing today |
|---|---|---|---|---|
| LLM, Chord's key (`LLM_PROVIDER`: OpenAI / Anthropic / Gemini) | Everything AI for a user with **no** key: chat turns, reply drafting, email sorting / suggestions / people, briefing, attachment indexing, memory extraction, forms | Tokens in and out | **Not Chord's cost** | Chat turns, reply drafting, email AI passes and the full briefing are gated on entitlement (bot.service, compose-reply, gmail.service afterSync, proactive scan). **Attachment indexing / classification on upload is not gated.** Email AI is roughly $0.78 to $2.01 per user per month (ADR 0110). |
| LLM, user's own key (OpenRouter and others) | The same work, for a BYOK user | Tokens, on their account | Theirs | n/a |
| OSS free-tier model (`OSS_*`) | A cheaper model shown for a billing user out of credits | Tokens | n/a | Display only (`resolveTurnLlm`) |
| Meta WhatsApp Cloud API | Every bot reply and briefing sent on WhatsApp; media; the out-of-window template | Per message since 1 Oct 2026 (US about $0.0034, unconfirmed; a possible 1,000 free per number a month, unconfirmed); about 80 messages a user a month measured | **Chord's cost** (the open question in ADR 0251) | **No.** Sends never check entitlement. |
| Twilio Verify (SMS) | Phone verification (ADR 0064) | Per verification plus SMS | **Chord's cost** | **No.** Throttled per number by Twilio only. Rate not recorded here. |
| Open-Meteo (forecast + city geocoding) | The briefing's weather line, one forecast per user per briefing, plus a geocode when a place is set or a move is checked (ADR 0091, 0148) | Calls; the free tier is **non-commercial only** (section E) | Chord's | **No** |
| Google Custom Search (`search_web`) | The bot's web search | Per query beyond the free tier | Chord's | **Dormant**: `SEARCH_PROVIDER` is unset, the tool returns a free Google link |
| Embeddings, Chord's key (`EMBEDDINGS_*`, default the OpenRouter `OPENAI_*` key) | Meaning-based search (ADR 0276): one vector per email thread and file, plus each search question | Tokens in; `openai/text-embedding-3-small` about $0.02 per million, so about **$0.16 per user once** to backfill, then pennies | A BYOK OpenRouter/OpenAI/Gemini user embeds on **their** key. **An Anthropic-key user is embedded on Chord's key, unmetered** (Anthropic has no embeddings API; `EMBEDDINGS_BYOK_FALLBACK=none` turns it off) | Yes: the background pass is gated on entitlement and metered as `token_usage` source `embedding` for users without a key. **Off by default** (`EMBEDDINGS_ENABLED`) |

**B. Per transaction**

| Service | Cost | Note |
|---|---|---|
| Stripe | Card-processing fee on every charge, plus any Billing fee (published US rate 2.9% + $0.30; check the account's own pricing) | A flat $0.30 matters more than the WhatsApp cost on a sub-$2 add-on |
| App Store / RevenueCat | Apple's commission (15 or 30%) | Dormant while iPhone billing is in the browser (ADR 0241) |

**C. Fixed — not per user**

GCP VM, Cloud SQL (ADR 0202), Cloud KMS (ADR 0201, 0210), Secret Manager (0211),
Cloud Logging / Monitoring and the audit log bucket (0207), Redis when `REDIS_URL` is
set (BullMQ queues and SSE fan-out, ADR 0170-0178), the domain, the Apple Developer
Program, Google Play, EAS builds and updates, the crash-fix GitHub Action's Anthropic
API calls (ADR 0227, per crash), and the annual Google OAuth **CASA** assessment for
`gmail.modify` (Tier 2 listed at $675 to $855 a year, checked 2026-09-10 in
`docs/ops/google-oauth-verification.md`). Amounts for most are not recorded in the repo.

**D. No per-use cost today**

Gmail and Calendar APIs (within quota), Microsoft Graph, IMAP / SMTP through the user's
own mailbox, Telegram Bot API, Expo push, Sign in with Apple, and the in-repo reference
tables in section E. (Weather and the IP database look free but carry licence terms that
change when Chord charges; they are in E, not here.)

### 3. What billing does not yet cover (open, no behaviour changed here)

1. **WhatsApp is unguarded and BYOK-agnostic.** A lapsed, trial-ended or BYOK user keeps
   receiving metered messages. This is the add-on in ADR 0251.
2. **Attachment indexing on upload runs for anyone**, including a user past their trial
   with no plan, on Chord's key.
3. **SMS verification is a cost an abuser can generate.** Only Twilio's per-number limits
   stand in the way.
4. **Fixed costs are in no plan's price.** The owner's formula (fixed cost plus K tokens,
   ADR 0195) has no number for the fixed part yet.
5. **Weather is on a non-commercial licence.** Before billing is turned on Chord needs an
   Open-Meteo paid plan. (The CC BY 4.0 credit is now in the privacy screen.)
6. **GeoLite2 has no scheduled refresh.** Its 30-day replacement rule is kept only by
   deploying often enough.

### E. Data and licence terms that start to matter when Chord charges

Checked against each provider's own terms on 2026-10-16. Not legal advice; the
wording to act on is the provider's.

| Source | What Chord does with it | Terms that bite once there is revenue | Status |
|---|---|---|---|
| **Open-Meteo** (`api.open-meteo.com`, `geocoding-api.open-meteo.com`) | Forecast and city lookup for the briefing, at the location from the phone when allowed (ADR 0258), else the IP or time-zone city | The free API is "for non-commercial use"; the terms list *"sites or apps with subscriptions or ads"* as commercial. Commercial use needs a paid plan (Standard 1M calls a month, Professional 5M, Enterprise 50M+; price not shown on the pages checked). Free limits are 600 a minute, 5,000 an hour, 10,000 a day. Data is **CC BY 4.0: attribution is required even on a paid plan**. The geocoding API's terms are not stated separately. | **Needs a paid plan before billing is on.** The CC BY 4.0 credit is now in the privacy screen (ADR 0258). Chord's volume (a call or two per user a day) is far under any limit. |
| **MaxMind GeoLite2-City** (a local `.mmdb`, IP to city) | Estimates a city when no place is set (ADR 0091); the IP itself is never stored | Licence is for "internal business purposes"; requires attribution (*"This product includes GeoLite Data created by MaxMind…"*); a new release must be used promptly and **old copies destroyed within 30 days**; no disclosing the file to third parties; accurate to postal-code level only and must not be used to locate a household or street address; MaxMind may begin charging for updates. | Stays as the second choice after the phone's location (ADR 0258). Attribution **is** in the privacy screen. The 30-day rule is met only by `deploy.sh`, which refreshes the file when it is over a week old **at deploy time**; a month with no deploy leaves an older copy in use, so there is no scheduled refresh. |
| **Airport, metro, time-zone and airline tables** (`kernel/src/airport-*.ts`, `flight-ident.ts`) | Anchor flight times to the airport's clock; turn a flight number into a FlightAware ident | Hand-curated in the repo from identifiers (IATA / ICAO designators, IANA zone names); **no external call and no licensed database**. If these are ever replaced by a downloaded airport database, check its licence (several are share-alike). | No action |
| **Link-outs only**: FlightAware, Google Maps and Search, OpenTable, carrier tracking pages (UPS, FedEx, USPS, DHL, Amazon, Canada Post, Royal Mail), Booking / Expedia | The app builds a URL; **Chord never fetches the page or calls an API** (ADR 0135, 0138, 0153, 0213) | No data licence is taken, so none is owed. Each site's terms and brand rules still govern how the link is described. | No action |
| **Google public holiday calendars** and the user's own calendars (Calendar API) | Read through the user's own Google grant | Google API Services terms and the Limited Use rules, already met for the restricted Gmail scope (CASA, section C). No per-call charge. | No action |
| **Public school-district calendars** (a curated registry of feeds) | Fetched as `.ics` when a user asks to import one | Public feeds, fetched on the user's request through the SSRF guard (ADR 0050). Terms vary by district. | Watch if the registry grows |
| **Open-source libraries** (libphonenumber metadata, sharp / libvips, pdf.js, fonts under OFL) | Built into the app and server | Permissive or LGPL licences; no payment, some notice requirements. | No action |
| **Image proxy** (ADR 0136, 0225) | Fetches a remote image for the reader | No licence, but bandwidth and storage cost, growing with mail volume. | Fixed-cost bucket |

## Consequences

- With BYOK free (ADR 0251), a BYOK user's remaining cost to Chord is WhatsApp, SMS
  verification and the fixed share. That is why the WhatsApp price is the open decision.
- Anything AI added from now on takes a user and goes through `getLlmForUser`; the test
  enforces it.
- Turning billing on has a licence prerequisite that is not engineering work: an
  Open-Meteo plan (E, gap 5). GeoLite2's refresh (gap 6) is the other thing to keep.
- **Device location (decided, ADR 0258)** now comes first and GeoLite2 is the fallback, so it
  is not retired: people who decline, or use WhatsApp only, still resolve through it.
- Turning billing on has a licence prerequisite that is not engineering work: an
  Open-Meteo plan (E, gap 5). GeoLite2's refresh (gap 6) is the other thing to keep.
- **Device location would retire GeoLite2, not Open-Meteo.** Asking the phone (or the
  browser) for approximate location gives coordinates the forecast can use directly, so the
  IP database and its attribution / 30-day-refresh duties would go. It is not free of cost:
  `expo-location` is not in the shipped app, so it needs a new native build and store review
  (an OTA cannot add it); it reverses ADR 0091's choice never to prompt for location and the
  privacy text that says so; the App Store privacy label changes; and users who decline, use
  WhatsApp or Telegram only, or sit in a shared time zone still need the time-zone fallback,
  which is coarser. Open-Meteo is still needed for the forecast either way. Not decided.
- This ADR records costs and terms; it sets no price.

## Rejected

- **Leave `getLlm()` exported "for system work".** Every real caller had a user in scope;
  the exception was the bug.
- **Fix the nudge wording to match the code** (the first reaction): the rule the owner set
  is that BYOK means everything runs on their key, so the code was wrong, not the copy.
