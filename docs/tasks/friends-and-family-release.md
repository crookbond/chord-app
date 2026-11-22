# Chord — Public Release Plan

> This began as the Friends & Family plan (2026-07). **TestFlight and the family
> cohort are live** as of 2026-09, so it now tracks the **public launch**. The
> filename is kept so existing links survive; the workstream sections further down
> keep their original history and F&F wording.

## Release status (2026-09-10)

**Target: public launch on the iOS App Store (US storefront) and the web
(`chordapp.ai`).** The native Android app is deferred (owner decision 2026-09-10) —
Android users come in through the web; see "Android is deferred" below. Five things
stand between us and launch:

| # | Blocker | State | Owner / gate |
|---|---|---|---|
| 1 | **Google OAuth verification + CASA** (Workstream O1) | **Not submitted — the longest external lead time.** An unverified app stops taking new users at 100 and shows everyone a "Google hasn't verified this app" screen, so this must finish *before* launch. `gmail.modify` is a restricted scope: annual CASA Tier 2 through an approved lab (TAC Security Premium **$855/yr**, checked 2026-09-10). Submission packet ready: [`docs/ops/google-oauth-verification.md`](../ops/google-oauth-verification.md) | Owner submits (console + demo video), then Google + the lab — **start first** |
| 2 | **Apple login rule 4.8** (O2) | **Open decision.** Google sign-in obliges an equivalent privacy-preserving login on the App Store. The email-client exception is a weak fit — Chord has features without mail, Gmail is optional, and it reads four providers. Either add **Sign in with Apple**, or make **phone the only login** (Google becomes a connection, not a login) | Owner decision → ADR → build |
| 3 | **Stripe subscription** (Workstream J3) | **Open.** `stripe.service.ts` still only does one-time `mode: 'payment'`; no subscription lifecycle webhook, no portal. Prod has `STRIPE_SECRET_KEY` empty and `BILLING_ENABLED=false`; checkout has never run even in test mode. Blocked first on the three J3 owner decisions. Web checkout is allowed from a **US-storefront** iOS app (see "Payments on the App Store" below) | Owner decisions, then us — see J3 |
| 4 | **Sentry** (Workstream N) | **Not started** — no Sentry code in server or mobile. Production errors exist only in `/var/lib/chord/logs/*.log` on the VM; mobile crashes leave no trace at all | Us — see N |
| 5 | **App Store submission** (O3) | **Not started.** Includes one piece of real code: Apple guideline 5.1.2(i) requires **explicit in-app permission** before personal data goes to a third-party AI, and Chord only discloses it in the privacy policy. Plus listing, App Privacy labels, a reviewer demo account, screenshots, age rating. In-app account deletion already exists (ADR 0043) | Us (consent screen), owner (listing) — see O3 |

**Closed since 2026-07-28:**

| Was | Closed by |
|---|---|
| WhatsApp production (G) | Live on **Meta Cloud API** since 2026-08-21 (ADR 0090) — Twilio's Embedded Signup could never claim the number. The `daily_briefing` template is approved and set in prod (`META_NUDGE_TEMPLATE_NAME=daily_briefing`, lang `en`; ADRs 0089/0091/0099). No longer gates anything |
| Website positioning (M) | Rewritten 2026-08-13 ("Your family's inbox, calendar, and to-dos - handled.", four surfaces, consent model, pricing section); Terms at `/tos` bound at sign-in |
| TestFlight + family cohort (H1) | Live as of 2026-09 — no longer a release step |
| Privacy policy vs. app behaviour | Corrected 2026-09-10 ahead of Google review: sending mail, stored bodies, AI-provider and WhatsApp/Telegram disclosures, dead `/settings/delete` link, Limited Use link; hosted `.txt` now generated from `privacy.tsx`. "Disconnect Gmail" now actually stops Gmail access (it kept the scope and re-imported the mailbox) |

**Payments on the App Store — resolved by Apple's 2025 rule change.** Guideline
3.1.1(a), as published on 2026-09-10: external-purchase entitlements *"are not required
for developers to include buttons, external links, or other calls to action in their
United States storefront apps"*. Every other storefront still requires in-app purchase
(or a regional entitlement). So J3's Stripe web checkout is fine **for a US-only App
Store listing**; selling the subscription outside the US means adding IAP
(e.g. RevenueCat) first. **Launch US-only.**

**Watch — copy ahead of product.** The landing page's pricing section promises
*"After that, a paid plan"*, which does not exist until J3 ships. Harmless while
`BILLING_ENABLED=false` (the trial never gates), but billing must not flip on
before a subscription can be bought — every account past 30 days would gate with
only one-time credits on offer.

**New cost, from 1 Oct 2026:** Meta starts charging for WhatsApp *service*
messages (every bot reply, not just templates — ADR 0139). The ADR 0053 taster
allowance and the ADR 0089/0091 briefing path both need re-costing before launch
traffic arrives.

### Android is deferred (2026-09-10)

> **Update 2026-10-13:** the in-app and build-config half of H3 is done
> ([ADR 0263](../notes/0263-android-is-brought-level-with-the-iphone-app.md)):
> `eas.json` has Android profiles, billing links out, contacts are explained
> before the prompt, and `/delete-account` exists. Still open: the
> `assetlinks.json` fingerprint, Firebase for push, the Play listing, and a run
> on a real device.

Workstream H3 is **out of the launch**, not cancelled. What that means for an
Android user:

- **They use the web app** at `chordapp.ai` in Chrome. Google sign-in works there —
  a mobile browser runs the ordinary web OAuth flow (`/oauthredirect`), which is
  exactly the path ADR 0081 kept distinct from the native `/nativeauth` one.
- **No push notifications on web.** `registerForPush` returns early off-device
  (`mobile/src/push.ts`), so an Android-on-web user only hears from Chord while the
  tab is open — or over WhatsApp/Telegram, which carry the briefing and bot
  replies. Onboarding copy for web users should steer them to connect WhatsApp.
- **Invite links** (`/join/<CODE>`) open the web join flow, which already works
  (ADR 0047); only the native hand-off (ADR 0048) is missing.
- `assetlinks.json` keeps its `REPLACE_WITH_ANDROID_SHA256_FINGERPRINT` placeholder
  and `eas.json` stays without an Android profile until H3 is picked back up. Both
  are harmless while no Android build is distributed.
- **Google Play's listing review (H2 gate 2) is deferred with it.** Google OAuth
  verification (formerly H2 gate 1) is **not** — it is about the Calendar/Gmail
  scopes and gates iOS and web too; it is now blocker #1 (Workstream O1).

### Shipped since this plan was written

| Area | State |
|---|---|
| A2 hardening | rate limits, helmet, log rotation, `/health/ready` — **done**. Sentry is release blocker #4 (Workstream N) |
| B phone identity | server + Twilio Verify **done** (ADR 0064; mock OTP removed); mobile `PhoneSection` in Settings |
| C contact discovery | server **done** (ADR 0065); mobile `find-friends` screen uses `expo-contacts` |
| D hybrid calendar | **done** (ADR 0057 + 0072), incl. two-way delete reconcile |
| E flagship `message_user` | server + calendar leg **done** (ADR 0067); WhatsApp production no longer blocks it — end-to-end over WhatsApp not yet verified |
| F push notifications | **done** (ADR 0054 + prefs addendum) — native only |
| G WhatsApp | **done** — Meta Cloud API (ADR 0090), 24h-window briefing (0089/0091), media (0140), CTA buttons (0139) |
| J1 billing core | **done** (ADR 0063) + **30-day trial then gate** (ADR 0079) |
| L global search | **done** (ADR 0062) + search UI + file-open fixes |
| M website | **done** 2026-08-13 |
| **Email track** (not in the original plan) | reader, attention map, classifier, magics, routing rules, people/family extraction, multi-account mailboxes — ADRs 0060–0080; bounded to family coordination by ADR 0149 |
| Proposal UX | source deep-links, duplicate consolidation, invite/decline convergence |

### Non-blocking known gaps

- **17 lost attachment blobs** on prod (pre-`DATA_DIR` uploads). Migration 033 + the
  stamp-on-410 path ship the fix; the rows still need a one-time bulk stamp after deploy.
- Deploy owes `npm run migrate` (028–033 + mailboxes) and promo-credit seeding **before**
  `BILLING_ENABLED` flips (ADR 0079 consequence).
- **EMAIL_PERSONS_ENABLED** has never been switched on against a real mailbox.
  `npm run dogfood:persons` (ADR 0149 lane) runs the pass in a rolled-back
  transaction and prints what it would stage — the safe way to look before a
  real mailbox is trusted to it. Runbook + code-read findings in
  [`persons-dogfood.md`](./persons-dogfood.md).

---

## Context

> *Original F&F-era context (2026-07), kept for history. The live blockers are the
> release status table at the top.*

Chord is a mobile-first group-chat app with an AI bot (Expo RN + Express/TS/Postgres),
working as a team MVP. We want to open it to a **larger friends-and-family audience**
(<50 users) **and** add a flagship capability: from a 1×1 WhatsApp thread with the bot,
a user can say *"send a message to Adrian to meet me for coffee at 11a"* and Chord will
resolve "Adrian" (a phone contact) to a real Chord user, message him on the user's behalf,
and put a coffee event on both calendars.

Exploration confirmed this set of asks interlocks and crosses Chord's deepest invariant
(strict per-group scope, ADR 0004/0032). The decisions taken with the user resolve the
tensions:

- **Auth:** Keep Google login; add a **verified phone number as a user attribute** (identity
  key for contact matching). No phone-only login → calendar/Google integration stays intact.
- **Calendar:** **Hybrid** — device-local read (EventKit / Android CalendarProvider) for
  availability/conflict detection; keep server-side Google write-back (ADR 0040) for event
  creation + attendee invite fan-out.
- **Cross-user messaging:** **Sender-initiated, recipient opt-out.** Satisfy "message Adrian"
  by find-or-creating a **shared pair group**, so we *create* scope rather than break ADR 0032.
- **Notifications:** In scope (Expo push) — required for cross-user messages and nudges.
- **Bugs:** A **triage workstream** (no list yet — collect, reproduce, prioritize, fix).
- **Distribution:** TestFlight (iOS) + Android internal/APK via EAS — closed beta, no public
  store listing. *(TestFlight, not the public App Store: for <50 F&F it avoids full App Review
  and public exposure of an evolving MVP; the same App Store Connect + EAS setup later promotes
  to the App Store with no rework.)*
- **Stability bar:** Pragmatic F&F (deploy+HTTPS, auth rate-limits, Sentry, backups, log
  rotation, real health check; no Redis/Docker/orchestration).

What's grounded in current code:
- No `phone_number` on `users` (`server/src/db/schema.ts` UsersTable). Google `sub` is the
  anchor. **But WhatsApp inbound already captures the E.164 phone** as
  `external_identities.external_id` (platform `whatsapp`).
- Contacts are **free-text** (`saves`, `kind='contact'`) — no phone/email/user link, no
  user-discovery endpoint. `resolveAssignee` matches a name only against current-group members.
- Bot can only write/message **inside the triggering group**; `relay` hits only that group's
  external bridges. Events fan out to current group members via `event_attendees` + Google invite.

---

## Workstream A — Foundations: Stability + Bug Triage

**Why:** The server assumes a single trusted dev. F&F users need it to survive abuse, surface
failures, and not lose data.

### A1. Deploy & secrets (blocking)
- Server on a stable HTTPS host/domain (`chordapp.ai` already wired into `mobile/eas.json` +
  deep-link config). TLS via Caddy/Let's Encrypt or managed.
- **Rotate the Postgres password** — `docs/ops/postgres.md` still carries the local peer-auth
  placeholder. Move all secrets (Google OAuth, LLM key, `MASTER_KEY`, Twilio) out of git into
  the host secret store. `MASTER_KEY` loss invalidates all stored refresh tokens (ADR 0041) —
  back it up.
- Apply the documented kernel-rsync step in the deploy script (`docs/ops/kernel-path.md`).

### A2. Hardening & observability
- `express-rate-limit` on `server/src/routes/auth.ts` and on message/upload/bot routes. **[done]**
- `helmet` in `server/src/app.ts`. **[done]**
- **Sentry** (server + mobile) — today errors only hit local logs (`app.ts:89`).
- Log rotation (`winston-daily-rotate-file`) in `server/src/config/logging.ts`. **[done]**
- Real readiness probe on `GET /api/v1/health/ready` (checks Postgres + LLM). **[done]** —
  plus deploy `pg_dump` cron and test one restore; boot-time retry for interrupted extractions
  (`attachments.indexed_at IS NULL`).
- Thin **route/auth integration tests** (server had zero route tests; health route tests added).

### A3. Bug triage
- Collect bugs (your list + a triage pass), reproduce, prioritize by user-facing severity, fix.
- Each fix gated by `npm test --workspace=server` (per project memory rule).

---

## Workstream B — Identity: Phone-as-Attribute + Verification

**Why:** A verified phone number is the deterministic key that maps a device contact to a
Chord user. We keep Google as the login/calendar anchor and attach phone to that account.

- **Schema:** add `phone_number` (E.164, unique) + `phone_verified` to UsersTable
  (`server/src/db/schema.ts`). Migration in `server/src/db/migrate.ts`.
- **Verification:** SMS OTP via **Twilio Verify** (we already use Twilio for WhatsApp). New
  endpoints `POST /api/v1/me/phone/start` + `/verify`; new env (Verify service SID) in
  `server/src/config/env.ts` + `example.env`.
- **Backfill:** WhatsApp-linked users already have their E.164 in `external_identities`
  (platform `whatsapp`) — backfill `users.phone_number` with `phone_verified=1` (WhatsApp
  proved ownership). One-time script alongside `connectors-bind.ts`.
- **UI:** "Add your phone number" step in `mobile/app/settings.tsx` (and onboarding), with the
  OTP flow.

**Progress (2026-07): testable server core landed ([ADR 0064](../notes/0064-phone-as-attribute-identity.md)).**
Migration `022` adds `users.phone_number` (E.164, partial-unique) + `phone_hash` (indexed) +
`phone_verified`, and a `phone_verifications` table. `phone.service.ts` (`startPhoneVerification` /
`verifyPhone` / `getPhoneStatus`) sits over an `OtpProvider` abstraction — **mock** (deterministic
DB-backed, default, runs with no Twilio) ‖ **twilio** (Twilio Verify). Endpoints `GET/POST /me/phone`,
`/me/phone/start`, `/me/phone/verify`; kernel `StartPhoneVerificationRequest`/`VerifyPhoneRequest`/
`PhoneStatus`. `backfillWhatsappPhones` (`npm run backfill:phones`) marks WhatsApp-linked numbers
verified, idempotently. New env: `PHONE_VERIFY_PROVIDER`, `TWILIO_VERIFY_SERVICE_SID`,
`PHONE_VERIFY_*`, `CONTACT_HASH_PEPPER`. Integration tests cover verify happy/wrong-code/expiry/
attempt-burn/uniqueness + backfill. **Remaining:** the mobile OTP UI + flipping the deploy to Twilio.

---

## Workstream C — Deterministic Contact Resolution ("who's on Chord")

**Why:** Map the user's device contacts to Chord users so the bot can act on a name.

- **Mobile:** read device contacts (`expo-contacts`), normalize numbers to E.164
  (libphonenumber), **hash** them client-side, upload the batch. Request contacts permission
  with a clear rationale string.
- **Server:** `POST /api/v1/me/contacts/resolve` — match uploaded hashed numbers against
  `users.phone_number` (hashed the same way) → return `{ contactName, chordUserId, displayName }[]`.
  Signal-style hashed discovery (flag that it is *not* cryptographically private like Signal's
  enclave — acceptable for F&F; document the privacy posture).
- **Persistence:** new `contact_links` table (or extend the `saves` contact rows) linking the
  user's contact → resolved `chord_user_id` + phone. This is the durable name→user map.
- **Resolver:** new `resolveContactToUser(senderUserId, name)` that searches the sender's
  resolved contacts (handles disambiguation when multiple matches). Distinct from the existing
  group-scoped `resolveAssignee` (`server/src/services/bot/executor.ts`).

**Progress (2026-07): testable server core landed ([ADR 0065](../notes/0065-deterministic-contact-discovery.md)).**
Migration `023` adds `contact_links` (owner→resolved-contact map, `UNIQUE (owner_user_id, phone_hash)`,
both user FKs `ON DELETE CASCADE`). `contacts.service.ts`: `resolveContacts` matches uploaded
client-hashed numbers against verified users' `phone_hash` and persists **only** the hits (non-matches
dropped — no whole-address-book retention); `resolveContactToUser` is strictly sender-scoped (exact
then first-name/prefix match, `match`/`ambiguous`/`none`, never a global user search). Endpoints
`POST /me/contacts/resolve` + `GET /me/contacts`; kernel `ResolveContactsRequest`/`ResolvedContact`.
Privacy posture (pepper ships in the client → not enclave-grade) documented in the ADR. Integration
tests cover verified-only matching, self/unverified exclusion, upsert, disambiguation, and strict
per-sender scope. **Remaining:** the mobile `expo-contacts` read+hash+upload, and wiring
`resolveContactToUser` into the flagship `message_user` (Workstream E).

---

## Workstream D — Hybrid Calendar

**Why:** Device-local read removes the per-session Google-token fragility for *showing*
availability; Google write-back keeps real invites/fan-out working.

- **Device-local read:** `expo-calendar` to read events for free/busy + conflict detection on
  device (iOS EventKit / Android CalendarProvider, which already aggregate iCloud+Google+Exchange).
  Surface availability in-app and feed `find_conflicts`.
- **Write-back:** keep server-side Google two-way sync (ADR 0040) as the authoritative path for
  creating events and inviting attendees (so invites fan out to others' calendars).
- **Reconciliation:** device-local is read-only/advisory; authoritative writes go through Google.
  Document as an extension to ADR 0040; keep the proactive reconnect nudge (ADR 0042) for the
  Google side.

**Status (2026-07): largely delivered by ADR 0057 + the delete-reconcile below.** The device→Chord
read (device events mirrored into the `events` table) already feeds availability/`find_conflicts`
(they're first-class `events` rows under the ADR 0033 busy policy), and Google remains the
authoritative write path (ADR 0040). **Bidirectional delete now reconciles across an app close**
(ADR 0057 addendum): device→Chord via `syncDeviceCalendar`'s reverse-delete (tested), and Chord→device
via a new `reconcileCalendarDeletes` run each foreground (was live-SSE only). Remaining: nothing
blocking — richer in-app availability surfacing is the only nice-to-have.

---

## Workstream E — Flagship: Cross-User Message + Calendar Invite (on behalf)

**Why:** The headline feature. It must not break ADR 0032 — so we **create a shared scope**
(pair group) instead of crossing scope.

**Progress (2026-07): server core + calendar-invite leg landed ([ADR 0067](../notes/0067-pair-groups-and-cross-user-messaging.md)).**
Migration `025` adds `groups.pair_key` + a `blocks` table. `ensurePairGroup` (find-or-create the
2-member group). `message_user` bot tool (personal-only): `resolveContactToUser` → block check →
`ensurePairGroup` → post + broadcast (recipient notified via the existing push-publisher). Returns the
recipient NAME not the pair-group id, so ADR 0032's scrubber leaves it intact. `blocks.service`
(is/​block/​unblock). The tool's optional `event` (title/startsAt/endsAt/location) creates a shared
event in the pair group → ADR 0040 fan-out puts coffee on **both** people's calendars; result carries
`eventCreated`. 6 integration tests (find-or-create idempotent + symmetric; delivery; calendar
fan-out to both; not_found; blocked; ambiguous). **Remaining:** the **WhatsApp NLU** delivery path
(needs ADR 0053 template approval), block-management UI, and the mobile pair-group title (show the
other person's name).

- **Pair-group primitive:** `ensurePairGroup(db, userA, userB)` — find-or-create a 2-member
  shared group (new `kind='pair'` or reuse `'group'`), mirroring `ensurePersonalGroup`
  (`server/src/services/groups.service.ts:328`). All cross-user messages/events live here, so
  the strict group-scope scrubber (`scrubCrossGroupLeak`) is satisfied, not bypassed.
- **New bot tool `message_user`** (`server/src/services/bot/tools.ts` + `executor.ts`):
  args `recipientName`, `body`, optional event fields. Flow: `resolveContactToUser` →
  `ensurePairGroup` → post the message → deliver to recipient via their channel (WhatsApp if
  bound, else push, else in-app).
- **Consent (sender-initiated, opt-out):** new `blocks` table; bot creates the pair group and
  sends if the recipient is a Chord user in the sender's resolved contacts and hasn't blocked
  the sender. Recipient can block/leave. Relax the event-trust gate (ADR 0026) within pair
  groups under this opt-out model (or auto-grant on pair-group creation) — document it.
- **Calendar invite (shipped):** `message_user`'s optional `event` reuses `createEvent` in the
  pair group with no `assigneeId`, so ADR 0040 fan-out mints an owner copy for both members and
  each syncs to that person's Google calendar. The shared event *is* the invite (no separate
  attendee email). Future: use Workstream D device-read for the sender's 11a-availability check.
- **WhatsApp NLU path:** in the WhatsApp 1×1 (the sender's personal group), the bot parses the
  request and calls `message_user` — the one deliberate, bounded place a personal-group turn
  acts on another user, mediated entirely through the pair group.

---

## Workstream F — Notifications (Expo Push)

**Why:** Cross-user messages (Adrian must hear about it), nudges, and event changes need to
reach users when the app is closed.

- **Tokens:** register device push tokens (`expo-notifications`); new `push_tokens` table
  (migration `012_push_tokens` already exists; an in-flight push effort is in the tree —
  reconcile rather than duplicate).
- **Service:** server notification fan-out via Expo Push API. Triggers: new pair-group / cross-user
  message, daily briefing (ADR 0034), calendar reconnect (ADR 0042), event/RSVP changes.
- **WhatsApp fallback:** for WhatsApp-bound users, deliver via WhatsApp (template when the 24h
  window is closed — see Workstream G), else push.

---

## Workstream G — WhatsApp: Production + Proactive  ✅ **DONE 2026-08-21**

> **Superseded status.** The plan below was written for Twilio. Prod went direct to
> **Meta Cloud API** instead (ADR 0090) — the number already sat on a WABA, which
> Twilio's Embedded Signup can never claim. The 24h-window gate and template send
> shipped as ADR 0089/0091, with the `daily_briefing` template approved. Kept below
> for the history.

**Why:** WhatsApp is where F&F live, and it carries the flagship feature's delivery.

**Status (2026-07-28): blocked on the DBA certificate.** Meta Business verification needs
proof the business exists — the **DBA ("doing business as") certificate** is the document we
are waiting on. Until verification clears we cannot get a production WhatsApp sender, and
until we have one we cannot submit **message templates** — which the proactive path (nudges,
briefings, cross-user delivery outside the 24h window) requires. Everything today runs on the
**Twilio Sandbox**, where outbound only works to numbers that have joined the sandbox
(otherwise Twilio error 63015; proactive sends fail with 63016).

**Ordered plan once the certificate is in hand:**
1. Submit Meta Business verification (DBA cert + domain) → obtain the production WhatsApp
   sender on Twilio.
2. Submit templates for approval (ADR 0053): daily briefing, cross-user message delivery,
   calendar reconnect nudge. Approval is days, not minutes — submit all three at once.
3. Land the code that is already designed but unbuilt: `isWindowOpen(platform, externalUserId)`
   keyed on last inbound, `deliverToWhatsApp(user, payload)` choosing free-form vs template,
   and `sendTemplate()` in `whatsapp.api.ts` (Twilio Content API). Route the F/D nudges through
   it. Extend `whatsapp.connector.test.ts` for the window + template branches.
4. Wire the flagship's WhatsApp NLU delivery leg (Workstream E's remaining piece).
5. Flip F&F testers off the sandbox onto the production sender.

*Meanwhile:* the app + push (F) cover every F&F flow without WhatsApp, so this blocks the
**WhatsApp-first cohort**, not the release itself — decide at go-time whether to ship
app-only first (recommended) or hold for WhatsApp.

- **External (start now, long pole):** Twilio WhatsApp Business number + Meta verification;
  submit message **templates** for approval (ADR 0053).
- **24h-window gating (blocking for proactive):** add `isWindowOpen(platform, externalUserId)`
  keyed on last inbound timestamp (deferred at `whatsapp.connector.ts:12`) and
  `deliverToWhatsApp(user, payload)` that picks free-form vs template send.
- **Template send + proactive wiring:** `sendTemplate()` in `whatsapp.api.ts` (Twilio Content
  API); route nudges (D, F) through `deliverToWhatsApp`. Today proactive sends fail with Twilio 63016.
- **Parity:** consider adding `whatsapp` to `PAIRABLE_PLATFORMS` (`routes/connectors.ts:55`);
  inbound/outbound media currently dropped (`whatsapp.connector.ts:106`) — recommend deferring
  media to a fast-follow. Extend `whatsapp.connector.test.ts` for window + template paths.

---

## Workstream H — Distribution (TestFlight + Google Play publish)

> **2026-09-10:** H1 (TestFlight) is live. The public App Store submission is
> Workstream O3; Google OAuth verification moved from H2 to O1; H2's Play listing and
> H3 are deferred with the Android app.

- iOS via TestFlight, Android via EAS → Play Console (`mobile/eas.json`, `mobile/app.json`
  already configured; bundle `app.chord.demo`).
- **Fix the Android deep-link fingerprint:** replace `REPLACE_WITH_ANDROID_SHA256_FINGERPRINT`
  in `mobile/public/.well-known/assetlinks.json` with the release keystore SHA-256
  (`docs/ops/native-deeplinks.md:15`); verify `apple-app-site-association` is served from the domain.
- Ship a **privacy policy** page (referenced, not present) — required for Calendar + Contacts
  OAuth/permission consent, TestFlight, and the Play Data-safety form.

### H3. Android — unblock sign-in, then ship a build  ⟵ **DEFERRED (post-launch)**

> **Deferred 2026-09-10 (owner).** The launch is iOS + web; Android users come in
> through the web app until this is picked up. See "Android is deferred" at
> the top for what that costs them (chiefly: no push). Everything below still
> stands for when it resumes.

**Status (2026-07-28): everything is configured except the one value that makes it work.**
`mobile/app.json` already declares `package: app.chord.demo`, the calendar/contacts/camera
permissions, and `autoVerify` intent filters for `/join`, `/welcome`, and — per
[ADR 0081](../notes/0081-android-oauth-via-app-link-redirect.md) — `/nativeauth`. But
`mobile/public/.well-known/assetlinks.json` still ships
`REPLACE_WITH_ANDROID_SHA256_FINGERPRINT`, and that placeholder has two consequences:

1. **Android Google sign-in does not work at all.** Google dropped custom-scheme redirects
   for Android OAuth clients, so ADR 0081 routes Android through the **web** client and
   catches the redirect at `https://chordapp.ai/nativeauth` via a verified App Link. If the
   link isn't verified, the redirect opens the browser instead of the app and login dead-ends.
   **This is a login blocker, not a polish item.**
2. Invite links (`/join/<CODE>`) fall back to the web instead of opening the app (ADR 0048).

**Steps:**
- Create/choose the **release keystore** (EAS-managed is fine — `eas credentials` prints the
  SHA-256), paste the fingerprint into `assetlinks.json`, redeploy the web build, and verify
  with Google's tester:
  `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://chordapp.ai&relation=delegate_permission/common.handle_all_urls`.
  If Play App Signing is used later, **the Play signing cert's SHA-256 must be added too** —
  list both fingerprints, or store-installed builds break again.
- **Build profiles** (`mobile/eas.json` has none for Android today): add
  `"android": { "buildType": "apk" }` to `preview` for direct sideload to F&F testers, and
  leave `production` as the default **AAB** for Play. `submit.production` is empty — add the
  Play service-account key when the Play track is opened.
- **Smoke on a real device:** Google sign-in end-to-end; tap a `chordapp.ai/join/<CODE>` link
  and confirm the app opens (not Chrome); push notification arrives (ADR 0054); calendar +
  contacts permission prompts show the rationale copy.
- **Decide the distribution channel:** direct APK to F&F is instant and avoids Play review
  entirely; a Play internal track triggers the H2 verification gates. **Recommend APK for the
  first cohort**, Play afterwards.

### H1. iOS — TestFlight (closed beta)  ✅ **LIVE 2026-09**
*Original note, kept for history:* Stay on TestFlight for F&F — internal testers install instantly, external testers clear only a
light Beta App Review, nothing is publicly listed. Promotes to the public App Store later as a
metadata + full-review pass on the same build pipeline.

### H2. Google Play publish — the verification gates
> **2026-09-10:** gate 1 (Google OAuth verification) is now Workstream O1 and gates
> iOS + web; gate 2 (Play listing) is deferred with Android.

Publishing to Play (even a closed/internal track that real users install) trips **two Google
review gates that each require a video**, and both must be cleared before non-test users can use
Google Calendar/Contacts features:

1. **Google OAuth verification (the hard gate).** Chord requests **restricted/sensitive scopes** —
   Calendar today, Contacts once Workstream C lands. To leave "testing" mode (capped ~100 users,
   unverified-app warning screen) Google requires a submitted **OAuth verification**, and for
   restricted scopes that includes a **demonstration video** (see I2) showing: the OAuth consent
   screen with the app name, the user granting each requested scope, and exactly how the app uses
   the data for each scope. Restricted-scope apps may also need a **CASA security assessment**.
   *This is the long pole — Google review can take weeks; submit early.*
2. **Play Console listing review.** Store listing + **Data-safety** form (declare Calendar/Contacts/
   phone data use), content rating, target-audience, and — because Chord handles personal data and
   does cross-user messaging — a clean **permissions/Prominent-disclosure** declaration. A Play
   **promo video** (YouTube link) is optional but recommended; it can reuse the I2 how-to footage.

Sequence: keep the unverified app on the **100-user testing cap** for the first F&F cohort while the
OAuth verification + (if required) CASA assessment are in flight; flip to the verified consent screen
before going past the cap or removing the warning screen.

---

## Workstream I — Onboarding UX, Pain Points, Video & In-App Help

**Why:** Flows work but assume technical users; new permissions (phone, contacts, calendar)
add steps a relative must understand.

### I1. Top pain points to fix
1. **Bot undiscoverable** — no in-app help; `@Chord` + follow-up window (ADR 0051) invisible →
   header "What can Chord do?" sheet + one-time intro message.
2. **Calendar/contacts/phone permission prompts** feel scary → clear rationale copy before each
   OS prompt; success toasts after.
3. **Calendar connect feels broken** — no post-OAuth confirmation, silent sync failures →
   auto-sync + toast, stale-sync banner.
4. **Join flow loses code on interruption** (`mobile/app/join/[code].tsx:33`) → better error copy
   + reset-code banner.
5. **Intimidating settings** — BYOK key UI, greyed "Active" mode, jargon toggles, fragile
   nudge-time parse → plain language, time-picker, translated key errors, scope badges.

### I2. Videos — script + storyboard (TWO videos, different audiences)
Two scripts under `docs/`; they share footage but serve different reviewers.

**(a) How-to / promo video (users + Play listing) — ~2–3 min.** Shot-by-shot scenes, on-screen
text, VO: install → sign in (Google) → add phone → find friends on Chord → join a group →
first `@Chord` ask → connect calendar → **"text Adrian to grab coffee at 11a" over WhatsApp** →
set a daily nudge time. Doubles as the optional Play Store promo video (H2).

**(b) Google OAuth verification demo video (review gate — H2).** A separate, plain screencast
recorded to Google's spec, **not** a marketing cut. Must show, on a real device/build for the
**production** OAuth client: the full sign-in, the **consent screen displaying the exact app name
and each requested scope**, the user granting consent, and then a concrete in-app demonstration of
how each restricted scope is used — for Calendar, creating/reading an event; for Contacts (post-C),
the contact-resolution flow. The `chordapp.ai` privacy-policy URL must be visible/linked. Keep it
literal and complete; Google rejects videos that don't show every requested scope being granted and
used. Record this only after the production OAuth client + privacy policy (Workstream H, A1) exist.

### I3. In-app help copy mirroring the video
Same teaching points as durable in-app text mapped to concrete strings:
`mobile/app/index.tsx`, `settings.tsx`, `groups/[id]/settings.tsx`, `join/[code].tsx`, bot intro.

---

## Workstream J — Billing + model routing  ⟵ release-blocking

**Why:** Before F&F we must not hand strangers an open tab on our premium LLM key — but instead
of a hard paywall, free/out-of-credit users degrade gracefully to a **cheap open-source model**.
Billing is 100% greenfield (ADR 0044 documented the model, built none of it). Payment is **Stripe
web checkout** (no in-app buy button) to avoid the store cut.

**Three-tier model routing** (chosen per *triggering user*, ADR 0007):
| Tier | Model | Credits |
|---|---|---|
| **BYOK** (own key) | their provider/model | free, no check |
| **Paid, credits > 0** | premium system model (current GPT/Claude) | debit 1/turn |
| **Free, or paid out of credits** | **cheap OSS model** (our key, low cost) | no debit |

Out-of-credits is **not blocked** — the turn still runs on the OSS model; the bot notes "you're
on the free model now — buy credits or add your own key for the premium model."

**Progress (2026-07): routing + credit core landed ([ADR 0063](../notes/0063-billing-and-model-routing.md)).**
Migration `021` adds `users.credit_balance` + the `credit_ledger` table. `billing.service.ts`
(`getCreditBalance` / `debitCredit` / `grantCredits`, idempotent by `ref`). `resolveTurnLlm` in
`llm/factory.ts` picks BYOK / premium / OSS by tier; `bot.service.ts` debits 1 credit per successful
premium turn (keyed on the bot message id). Gated by `BILLING_ENABLED` (off = unchanged behavior).
`GET /me/billing` returns `{ balance, tier, model, billingEnabled }`; OSS provider via `OSS_*` env.
5 integration tests (ledger correctness + idempotency + zero-floor + tier routing under the flag).
**Remaining: the Stripe slice** — `grantCredits` is the seam; needs `checkout` + webhook + the mobile
billing card (deferred, needs Stripe keys).

### J1 — Paid / billing track (Stripe + credits)
- **Schema (new):** `credit_balance` int on `users` (fast gate) kept in lockstep with a
  `credit_ledger` append-only table (`user_id`, signed `delta`, `reason`
  purchase|turn_debit|grant|refund, `ref` = Stripe session / message id, `balance_after`,
  `created_at`; unique `ref` for idempotency). Optional `usage_log` (tokens/turn) for analytics.
  Enforcement debits **1 credit per premium turn** so users reason in messages ("≈N for $9.99").
- **Routing + debit (turn path):** in `bot.service.ts`, pick the provider per the table above via
  a small router around `getLlmForUser` (`llm/factory.ts`). Debit 1 credit only on a successful
  **premium** turn (ledger insert + balance decrement, one transaction). OSS/BYOK turns never debit.
- **Stripe (server):** `stripe` dep. `POST /api/v1/me/billing/checkout` → Checkout Session
  (`client_reference_id = userId`, fixed $9.99 price), returns hosted URL.
  `POST /api/v1/webhooks/stripe` verifies signature vs the raw body (already captured in `app.ts`),
  credits the bundle on `checkout.session.completed` idempotently by session id.
  `GET /api/v1/me/billing` → `{ balance, tier, model }`. New env: `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `CREDITS_PER_BUNDLE` (start ~500, tunable),
  `BILLING_ENABLED`. New kernel `API.*` paths.
- **Mobile UI:** Billing card in `settings.tsx` — show "Chord credits: N" / current model / "Using
  your own key (free)"; "Buy credits" opens the Checkout URL in the system browser.

### J1 status (2026-07-28) — built, never run against real Stripe

Shipped per [ADR 0075](../notes/0075-stripe-checkout-without-the-sdk.md) — deliberately
**without the Stripe SDK** (raw REST session-create + hand-rolled HMAC `v1` verify over
`req.rawBody`), so every test runs keyless: `POST /me/billing/checkout` (503 until keys are
set), `POST /webhooks/stripe` (registered before the `/:platform` catch-all, paid-guard,
200-on-unprocessable, `grantCredits` idempotent by session id), `checkoutAvailable` on
`BillingStatus`, and the AI Plan card in Settings. [ADR 0079](../notes/0079-thirty-day-trial-then-gate.md)
layered the **30-day trial then gate** on top: `getEntitlement` (BYOK → trial → credits),
gated bot turns / email AI passes / proactive, with the daily briefing still arriving as a
deterministic no-LLM teaser.

**Remaining for release:**
- **Test-mode smoke** (never done): `stripe listen --forward-to localhost:4000/api/v1/webhooks/stripe`,
  buy with `4242 4242 4242 4242`, confirm the balance increments **once** and a replayed
  webhook doesn't double-credit; then the same against the deployed webhook URL with the
  live-mode keys + endpoint secret.
- **Post-purchase feedback**: the billing card doesn't confirm a successful purchase
  (`/settings?checkout=success` lands but says nothing). Small, user-visible.
- **Promo-credit seeding before `BILLING_ENABLED=true`** — otherwise every account older
  than 30 days gates the instant billing turns on (ADR 0079 consequence).

### J4 status (2026-10-08) — billing as designed, still never run against a live seller

**Supersedes the J1/J3 notes below where they disagree** (they predate ADR 0195-0197 and 0231).
Built: individual + family plans, monthly + annual, Stripe web checkout + billing portal,
App Store via RevenueCat, pooled family allowance, family roster + invites + Chordinators
(Settings and chat), single-use promo codes, grandfathering, configurable prices
([ADR 0231](../notes/0231-a-family-pays-once-and-shares-one-pool.md)). Every part that can be
tested without a live seller is (webhooks are driven with locally signed events).

**Owner checklist before `BILLING_ENABLED=true`:**
1. **Stripe** (account exists; no key is in any env file yet): in test mode create four recurring
   prices — Individual monthly/annual, Family monthly/annual — and put the ids in
   `STRIPE_PRICE_ID`, `STRIPE_PRICE_ID_YEARLY`, `STRIPE_PRICE_ID_FAMILY`,
   `STRIPE_PRICE_ID_FAMILY_YEARLY`; add `STRIPE_SECRET_KEY` and the webhook endpoint
   `/api/v1/webhooks/stripe` (`invoice.paid`, `checkout.session.completed`) → `STRIPE_WEBHOOK_SECRET`;
   **save a Customer portal configuration** (Settings → Billing → Customer portal) or Manage 400s;
   enable the plans/prices the portal may switch between. Payouts: Stripe pays out to a bank
   account or debit card — confirm what it will accept for you before going live.
2. **Test-mode smoke**: buy each of the four with `4242 4242 4242 4242`; a promo code
   (`npm run promo:codes -- generate --count 1`); confirm the free month opens at once, the first
   real `invoice.paid` extends it, the code is burned, and a replayed webhook changes nothing.
3. **App Store**: four auto-renewable subscriptions in one group in App Store Connect with the ids
   in `APPLE_PRODUCT_*`; a RevenueCat project with the iOS key (`EXPO_PUBLIC_REVENUECAT_IOS_KEY`
   in the EAS build env) and a webhook to `/api/v1/webhooks/revenuecat` with
   `REVENUECAT_WEBHOOK_SECRET` as its Authorization value; generate offer codes if you want iOS promos.
   **Needs a new native build** (the SDK is a native module). Sandbox-test purchase, restore, cancel.
   Keep Apple and Stripe prices equal; Apple sells in fixed tiers, so $24.99 / $87.89 / $274.89
   may round to the nearest tier.
4. **Grandfather everyone first**: `npm run grandfather:users -- --before <go-live date>` (dry run),
   then `--apply`, then flip `BILLING_ENABLED`. Anyone who signs up after the cutoff gets the 30-day trial.
5. Review the privacy policy / terms for the new data (family roster holds names, emails, phones).

### J3 — Subscription enablement  ⟵ **RELEASE BLOCKER #3 (new work)**

**Why:** credits are a one-time top-up (`mode: 'payment'`). A family assistant that runs
ambient email/calendar passes every day needs **recurring** revenue, and users need
"it just keeps working" rather than remembering to re-buy.

**Decisions to make first (owner):**
1. **Plan shape** — one paid tier (e.g. $9.99/mo) vs monthly + annual. Recommend starting
   with one monthly price + an annual option at ~2 months free.
2. **What the subscription grants** — simplest and most honest: *unlimited premium turns +
   the full ambient AI layer*, with a fair-use ceiling enforced by the existing per-turn
   ledger (log, don't block, at F&F scale). Alternative: a monthly credit refill, which
   reuses `grantCredits` untouched but keeps users counting.
3. **Coexistence with credits** — keep one-time bundles for non-subscribers, or retire them?
   Recommend keeping both: bundles for gift/one-off, subscription for regulars.

**Build (server, mirrors ADR 0075's no-SDK posture):**
- `createCheckoutSession` gains `mode: 'subscription'` + `STRIPE_PRICE_ID_SUB` (monthly)
  and optionally `STRIPE_PRICE_ID_SUB_ANNUAL`; the existing signature-verify path is reused
  unchanged.
- Webhook handles the subscription lifecycle: `checkout.session.completed` (activate),
  `customer.subscription.updated` / `deleted` (status + period end),
  `invoice.payment_failed` (grace, then lapse). Store `stripe_customer_id`,
  `stripe_subscription_id`, `subscription_status`, `current_period_end` on `users`
  (new migration) — all idempotent by event id, same discipline as the credit ledger.
- **`getEntitlement` gains a `subscription` reason**, ordered **BYOK → subscription → trial →
  credits** so a paying subscriber is never debited from a bundle. This is the single
  chokepoint every gate already reads, so nothing downstream changes.
- **Billing portal**: `POST /me/billing/portal` → Stripe Billing Portal session, so cancel /
  change-card / invoices are Stripe's UI, not ours. Cheapest possible path to "manage
  subscription" and it satisfies store/consumer expectations.
- Mobile: the AI Plan card shows plan + renewal date + **Manage subscription** (portal) and
  **Subscribe** for non-subscribers; trial countdown copy already exists.
- Tests: keyless as today — sign synthetic subscription events with `signStripePayload`,
  assert entitlement transitions (active → past_due → canceled → re-subscribe), idempotency
  on replay, and that a subscriber's premium turn is **not** debited.
- **ADR**: extend ADR 0075 with the subscription addendum (lifecycle events, entitlement
  ordering, portal) rather than a new ADR — same decision space.

**Store caveat — resolved for the US (2026-09-10):** Apple's guideline 3.1.1(a) no
longer requires an entitlement for buttons or links to web purchase in **US-storefront**
apps, so the iOS app may send people to Stripe checkout. Every other storefront still
requires IAP. Launch the App Store listing US-only; add IAP (RevenueCat) before
expanding to other countries.

### J2 — Open-source model track  **(owner: Adrian — runs in parallel with J1)**
- **Research the right OSS model** for the free tier: must do reliable **tool-calling** against
  Chord's tool registry (`bot/tools.ts`), be cheap, and ideally low-latency for chat. Validate on
  the Berkeley Function-Calling Leaderboard + a Chord-specific tool-use eval. Candidates (mid-2026):
  **Llama 3.3 70B (Groq — fast, free dev tier)**, **gpt-oss-120B (DeepInfra — ~$0.08/1M, cheapest)**,
  Qwen3-Coder-30B. Models with weak native tool-calling can still work via Chord's **text-fence
  fallback** (ADR 0003) — but native function-calling is strongly preferred.
- **Integration is low-effort:** the factory already supports an OpenAI-compatible `OPENAI_BASE_URL`
  override (Ollama/vLLM/OpenRouter). Add a dedicated **OSS provider profile**
  (`OSS_PROVIDER`/`OSS_BASE_URL`/`OSS_MODEL`/`OSS_API_KEY`) the router selects for the free tier —
  no new provider class needed, just config + a routing branch.
- **Deliverable:** model pick + provider/host recommendation with cost/latency numbers, a tool-use
  eval result, and the env profile wired so J1's router can point free/out-of-credit turns at it.

### Apple/Google caveat — resolved for the US storefront (2026-09-10)
Web checkout for credits and subscriptions is permitted from a **US-storefront** iOS app
under guideline 3.1.1(a) as published 2026-09-10; other storefronts still need IAP or a
regional entitlement. See "Payments on the App Store" at the top.

---

## Workstream K — Per-group inbound email mailbox (SMTP → bot)

> **CUT from the release (2026-07-15).** Superseded by the in-app Gmail reader
> track (ADR 0060/0061/0066 + email magics): Chord already *reads* each user's
> email, classifies it, and stages calendar/list proposals from it — so the
> job K solved ("get school PDFs / tickets / receipts into Chord") is covered
> without running an internet-facing SMTP server (MX, DMARC verification,
> port-25 ops). What K uniquely offered — non-users emailing a group directly,
> and files landing as *group* attachments — is not worth that ops burden at
> F&F scale; a user can share from the reader into a group instead. Revisit
> only if real users ask to email a group from outside. The design below is
> kept for that day.

**Why:** Let members forward documents (school PDFs, tickets, receipts) into a group by email;
attachments land as group files and flow through the existing extraction/indexing pipeline and the
bot. Architecturally this is **a connector that speaks SMTP instead of webhooks** — it reuses the
existing inbound machinery rather than inventing a parallel path.

**Reuse (confirmed in code):** `groups.ingest_email` column already exists; `handleInbound()`
(`connectors/inbound-pipeline.ts`) already does resolve-sender → ensure-member → `saveFile()` →
`postMessage(kind:'file')` → `reactToMessage()`; `resolveIdentity()` supports a new `'email'`
platform; extraction auto-fires from `saveFile()`. The email channel just normalizes a parsed
message into the existing `InboundMessage` shape.

- **SMTP listener:** add `smtp-server` + `mailparser` deps; start a listener conditionally
  (`SMTP_ENABLED`) in `server.ts`, mirroring `connectors/init.ts`, with graceful shutdown alongside
  the connector registry. Accept mail only for our domain; ack/queue fast, process async.
- **Mailbox addressing (memorable, not secret):** address = a slugified group name + numeric
  disambiguator at the real domain, e.g. `smith-family@chordapp.ai`, `smith-family2@chordapp.ai`
  if taken. Add a `mailbox_local` column to `groups` (unique, globally, since it's one namespace
  at `chordapp.ai`); generate from the name with a collision-incrementing suffix; assigned once and
  kept **stable across renames** (so shared addresses don't break) with an explicit regenerate
  action. O(1) recipient `mailbox_local` → group lookup. Replaces the old `ingest_email` value.
  *Security note:* a memorable address is intentionally guessable — that's fine because **the
  allowlist + sender authentication, not address secrecy, is the security boundary**. A guessed
  address only lets a stranger's mail get *rejected*.
- **Allowlist managed via `@chord` (chat-first):** the allowlist is edited from the group chat with
  bot commands — new group-scoped bot tools `add_mailbox_sender` / `remove_mailbox_sender` /
  `list_mailbox_senders` (`bot/tools.ts` + `executor.ts`), e.g. *"@chord let alice@example.com email
  this group"* / *"@chord stop bob@example.com from emailing us."* Tools operate only on the turn's
  group (ADR 0032 scope) and validate the address. Backed by a new `group_mailbox_allowlist` table
  (`group_id`, `email`, `added_by`, `created_at`). Effective allowlist = group members' verified
  `users.email` (auto) **+** these explicit entries. Inbound `From` not on the list → drop. Sender
  maps to the real member by `users.email` when possible (file attributed to that member), else an
  allowlisted non-member becomes a shadow user.
- **Anti-spoofing (REQUIRED — doubly so given guessable addresses):** the allowlist keyed on `From`
  is trivially spoofable, and the address is public, so sender authentication is the *only* real
  gate. Verify **SPF + DKIM + DMARC** on every inbound message (e.g. `mailauth`) and drop on DMARC
  fail *before* the allowlist check. Enforce max message/attachment size and a per-sender rate limit.
- **Multiple attachments:** loop `saveFile()` per MIME attachment and post one `file` message each
  (or a single message with the body + first attachment, rest as follow-ups) — reusing the pipeline.
- **Surfacing the address (tap the group):** show the mailbox address in the **group header / info
  view** reached by tapping the group (with copy), not buried in settings — primary discovery point.
  `groups/[id]/settings.tsx` keeps the enable toggle + regenerate + a read-only allowlist view (edits
  happen via `@chord`). New kernel `API.*` paths (`groupMailbox` read; regenerate).
- **Env:** `SMTP_ENABLED`, `SMTP_HOST`, `SMTP_PORT` (25 inbound / 587 submission), `SMTP_DOMAIN`,
  `SMTP_MAX_BYTES`. Document in `example.env`.
- **Domain first (blocker, found 2026-08-21):** `createGroup` hardcodes the address at
  `@chord.app` — a domain the project does not own; everything real is `chordapp.ai`. Whatever
  K does, the local-part generator must mint at a domain we control (env-driven, not a literal)
  and existing `groups.ingest_email` rows need a migration. Until then no surface may show the
  address — the Settings hatch was removed for exactly this (ADR 0083 addendum).
- **Ops (new doc `docs/ops/inbound-email.md`):** MX record for `SMTP_DOMAIN` → server, reverse DNS,
  STARTTLS cert, and the cloud caveat that **many providers block inbound/outbound port 25** — may
  need a request to unblock or a relay. Note the lower-ops alternative (SES inbound / Mailgun routes /
  Cloudflare Email Workers → an HTTP webhook reusing the same `handleInbound`) in case self-hosted
  SMTP is impractical on the chosen host — but the build target is self-hosted SMTP per the request.

---

## Workstream L — Global search (messages · tasks · lists · saves · files)

**Why:** As groups accumulate history, F&F users need to *find* things — "where did we put the
soccer schedule", "that task about the dentist", "the link Mom shared". Today there is **no search
UI and no FTS on anything but attachments**; users can only scroll. This is a usability blocker for
a real (non-demo) audience.

**What exists (grounded in code):** `attachment_chunks` already has a generated `body_tsv` tsvector
+ GIN index and a working ranked search (`searchAttachmentChunks` in `attachments.index.ts`, with
keyword extraction, prefix `tsquery`, `ts_rank_cd` ranking, `ts_headline` snippets, and
visibility gating in `bot/retrieval.ts`). **No FTS exists for messages, tasks, lists/list_items, or
saves** — those have only plain `WHERE group_id = ?` list queries. So files come nearly free; the
other four need indexing.

**Scope model (does NOT violate ADR 0032).** ADR 0032's strict per-group scope governs *the bot*
not leaking across groups. A *user* searching their own data is different: the searcher is a member
of every group queried, so results may span **all groups the user belongs to** — that's the user's
own data, surfaced to the user. Two surfaces:
- **In-group search** — `GET /api/v1/groups/:id/search?q=` (membership-gated by
  `require-member.ts`), results from that one group.
- **Global search** — `GET /api/v1/me/search?q=` — searches across **only the groups the searcher is
  a member of** (membership pre-filter on `group_members`), each hit tagged with its group + entity
  type. This is the headline feature. The `scrubCrossGroupLeak` post-filter still applies as a
  belt-and-suspenders net.

**Indexing approach — per-table generated `body_tsv` + GIN (mirror the attachments pattern), then
`UNION ALL` at query time.** For each of `messages`, `tasks`, `lists`, `list_items`, `saves`, add a
`STORED GENERATED` tsvector over its human-text columns and a GIN index (migration in
`server/src/db/migrate.ts`):
| Entity | Table | Indexed columns |
|---|---|---|
| Message | `messages` | `body` (exclude `chord_visible=0` bot-only rows at query time) |
| Task | `tasks` | `title`, `details` (default-hide `archived`/`superseded`) |
| List | `lists` | `name` |
| List item | `list_items` | `text` (group scope via join to `lists.group_id` — no own `group_id`) |
| Save | `saves` | `title`, `note` |
| File | `attachments` / `attachment_chunks` | **reuse existing** `searchAttachmentChunks` |
Generated columns are maintained by Postgres on every write — **zero drift, no sync code**, unlike a
single denormalized `search_index` table that we'd have to keep in lockstep across five services
(rejected for that maintenance/correctness risk at F&F scale).

**Query path — new `search.service.ts`.** Reuse the existing keyword-extraction + prefix-`tsquery`
helpers; run the five entity queries (each group-scoped + visibility-gated) `UNION ALL`-style,
rank with `ts_rank_cd`, generate `ts_headline` snippets, recency tiebreak, paginate. Return a
typed `SearchHit[]` (`entityType`, `groupId`, `groupName`, `entityId`, `title`/`snippet`,
`createdAt`, score). Files come from the existing attachment path, merged into the same result list.
Visibility rules carry over: bot-only messages excluded; attachment guest/own-upload gating reused.

**Kernel contract.** New `API.groupSearch(id)` + `API.meSearch` paths in `kernel/src/api.ts`; a
zod `SearchRequest` (`q`, optional `types[]` filter, `groupId?`, cursor) and a `SearchHit` type in
`kernel/src/types/`. No new SSE event (search is request/response).

**Mobile UI.** A search entry in the app shell (search icon in the group-list header and/or an
in-group search bar). Query box → debounced call to `meSearch` (global) or `groupSearch` (in a
group) → results grouped by entity type or interleaved by rank, each row showing group name +
snippet with match highlight; tapping a hit **deep-links** to that message/task/list/save/file in
its group (reuse existing `groups/[id]/...` routes + the `join`/deep-link patterns). Empty/zero-
result and min-2-char states handled.

**Nice-to-have (note, don't block):** expose the same index to the bot as a `search` tool so
"@chord find the soccer schedule" works in chat — but the user-facing search bar is the deliverable.

**Progress (2026-07): server slice landed ([ADR 0062](../notes/0062-global-search-fts.md)).**
Migration `020` adds `STORED GENERATED search_tsv` + GIN on messages/tasks/lists/list_items/saves.
New `searchHits()` (FTS, flat ranked `SearchHit[]`) beside the bot's `searchEverything`; visibility +
scope gated; files reuse `searchAttachmentChunks`. Endpoints `GET /me/search` (cross-group) +
`GET /groups/:id/search` (membership-gated). Kernel `SearchHit`/`SearchRequest`/`SearchResponse` +
`API.meSearch`/`API.groupSearch`. Integration tests cover each entity type, cross-group scoping,
non-member exclusion, and bot-only-message exclusion.

**Mobile UI (2026-07):** search is invoked from the **1×1 (personal) chat composer** — a 🔍 button
next to `+`, shown only when `group.kind === 'personal'` — opening a full-screen `GlobalSearchModal`
(`mobile/src/global-search.tsx`) that debounces `searchGlobal()` → `GET /me/search`, renders a ranked
list with a per-type icon + `ts_headline` match highlight + group name, and deep-links each hit via
`router.push(hit.href)` — and for **file** hits, opens the file directly (native share sheet / web
blob tab) instead of just navigating to the Files tab. `searchGlobal`/`searchInGroup` added to
`mobile/src/api.ts`. The same modal (now `SearchModal`, with an optional `groupId`) also does
**in-group** search: the 🔍 shows in every chat, and a **shared group** scopes to
`GET /groups/:id/search`. **Remaining (optional):** converging the bot's ADR 0059 tool onto the FTS
path, and a message-anchor deep-link (a message hit currently opens its group chat, not the exact row).

---

## Workstream N — Sentry / error visibility  ⟵ **RELEASE BLOCKER #4**

**Why:** today a production failure exists only as a line in `/var/lib/chord/logs` on the VM —
someone has to SSH in and grep to learn anything, and **mobile crashes leave no trace at all**.
With real relatives using the app we will not hear "the calendar screen went white"; we will
hear nothing. This is the difference between fixing a bug in an hour and finding it a week
later. The current per-bug diagnosis loop (grep the VM log, reproduce locally) is exactly what
Sentry replaces.

**Server (`@sentry/node`):**
- Init in `server/src/app.ts` behind `SENTRY_DSN` (empty = disabled, same posture as every
  other integration), with `environment` from `NODE_ENV` and `release` from the deployed git
  SHA so a regression points at a commit.
- Express error handler registered **after** the routes, next to the existing handler at
  `app.ts:89` — keep the local winston log as-is; Sentry is additive, not a replacement.
- Capture the paths that currently swallow: the connector inbound pipeline, the proactive
  drain, and the email `afterSync` passes (each already `try/catch`-and-warns — add a
  `captureException` alongside the `logger.warn`).
- **Scrub aggressively — Chord handles email bodies.** `beforeSend` must drop request bodies
  and strip `x-chord-token` / cookies; never send message text, email content, or attachment
  text. Send ids, not content. Set `sendDefaultPii: false`.
- `tracesSampleRate` low (0.1) or off — we want errors, not APM cost.

**Mobile (`@sentry/react-native`):**
- Init in `mobile/app/_layout.tsx` behind `EXPO_PUBLIC_SENTRY_DSN`; wire the Expo plugin so
  **source maps upload on EAS builds** (a minified RN stack is useless).
- The same scrub rule: no message/email text in breadcrumbs.
- Tag `platform` + `appVersion` — this is how we tell an Android-only bug from a shared one,
  which matters immediately given H3.

**Env:** `SENTRY_DSN` (server), `EXPO_PUBLIC_SENTRY_DSN` (mobile), `SENTRY_ENVIRONMENT`,
`SENTRY_TRACES_SAMPLE_RATE` — appended to the dated **NEW KEYS** section at the bottom of
`example.env` per the owner convention.

**Verification:** throw a test error on the deployed server and confirm it lands with the
right release tag; force a mobile JS error in a preview build and confirm the stack is
symbolicated; confirm a request carrying a session token shows **no** token and **no** body
in the Sentry event.

---

## Workstream O — Store & platform compliance  ⟵ **RELEASE BLOCKERS #1, #2, #5**

Added 2026-09-10 for the public launch. Everything here is a gate someone outside the
team controls (Google, an assessment lab, Apple review), so the lead times are theirs.

### O1. Google OAuth verification + CASA  ⟵ **#1 — start first**

**Why:** an unverified app stops accepting new users at 100 and shows every user
"Google hasn't verified this app". Chord requests `calendar` (sensitive) and
`gmail.modify` (**restricted**), and a restricted scope adds an annual CASA
security assessment.

**Steps** (full packet: [`docs/ops/google-oauth-verification.md`](../ops/google-oauth-verification.md)):
1. Deploy `main` — reviewers compare the live privacy policy to the app (policy
   corrected 2026-09-10).
2. Confirm the consent screen is **In production**, not Testing.
3. Verify `chordapp.ai` in Google Search Console with an owner of project `178917388887`.
4. Record the demo video on desktop web (script in the packet) with a demo Google account.
5. Paste the console fields and scope justifications from the packet; submit.
6. After the scope review, complete **CASA Tier 2** with an approved lab. TAC Security,
   checked 2026-09-10: $675 (2 rescans) / **$855 (unlimited rescans — pick this)** /
   $1,800 per app per year; Tier 3 is $4,500 if Google assigns it. Renews yearly.

Adding any new sensitive or restricted scope sends the app back through review.

### O2. Apple login rule (guideline 4.8)  ⟵ **#2 — owner decision**

Google sign-in obliges *"another login service"* that limits collection to name and
email, lets the user keep their email private, and does no ad tracking. Options:

| Option | Satisfies 4.8? | Work | Main risk |
|---|---|---|---|
| **Add Sign in with Apple** | Yes | Days: `expo-apple-authentication` (a native module → new build), server verification of Apple's identity token, `users.apple_sub`, Apple private-relay emails, revoke the Apple token on account deletion (Apple requires it) | An Apple-login user who later connects Google needs account matching |
| **Phone as the only login** (Google becomes a connection for Calendar/Gmail) | Yes, via *"exclusively uses your company's own account setup"* — **only** if Google is no longer a login anywhere, existing users included | Bigger: supersedes ADR 0014, amends ADR 0064, every existing Google-anchored user needs a verified number, a text message per login | SIM swap: whoever holds the number passes the code and any periodic re-check. Mitigations: a new device cannot open Gmail/Calendar until the user also re-authenticates with Google; a new-device alert by push + WhatsApp/Telegram; a carrier SIM-swap lookup (Twilio; country coverage + price unverified) |
| Google + phone, both as logins | Unlikely — a phone number is more than name + email, and it is not "exclusively" our own system | — | Rejection at review |
| Google only, claiming the email-client exception | Unlikely — Chord has features with no mail, Gmail is optional, and it reads four providers | — | Rejection at review |

Either real option needs an ADR before code (it changes ADR 0014). Owner floated
phone login with periodic re-verification on 2026-09-10 — undecided.

### O3. App Store submission  ⟵ **#5**

- 📄 **Submission packet drafted 2026-10-25:**
  [`docs/ops/app-store-submission.md`](../ops/app-store-submission.md) — listing
  text, App Privacy answers, age rating, review notes, demo-account steps,
  screenshot plan. Calendar permission text now says Chord also reads the chosen
  calendars; `supportsTablet` is off (no iPad to test on). Left for the owner:
  demo account, screenshots, App Store Connect forms, a native build. Open risk:
  no Report/Block in group chats (guideline 1.2).
- ✅ **Built 2026-10-20 (ADR 0283)**: `/ai-consent` screen after sign-in, AGREE / NO in
  chat, Settings → AI model switch, every AI path gated on `users.defaults.ai_consent`.
  Original note:
- **Explicit AI-sharing consent (code work, not metadata).** Guideline 5.1.2(i):
  *"You must clearly disclose where personal data will be shared with third parties,
  including with third-party AI, and obtain explicit permission before doing so."*
  Chord sends messages, email and calendar content to its model provider (prod:
  `openai/gpt-4.1-mini`, whose `openai/` prefix suggests a router such as OpenRouter —
  confirm and name the real recipient). The privacy policy discloses it; nothing in the
  app **asks**. Needs an in-app consent step before the first AI use and before Gmail
  connect, naming the provider, with a way to decline. BYOK users send to the provider
  they chose — the same screen names it.
- **Reviewer demo account** (guideline 2.1): working credentials plus notes. With
  Google login, a demo Google account holding sample mail + calendar. With phone login,
  one allow-listed number with a fixed code bound to one demo account — a narrow cousin
  of the `000000` bypass ADR 0064 removed, so pin it to that account and test it.
- **Account deletion in-app** (5.1.1(v)) — exists (ADR 0043). If Sign in with Apple
  ships, deletion must also revoke the Apple token.
- **App Privacy labels** — declare: contact info (name, email, phone), user content
  (messages, email, files, photos), contacts (hashed numbers, ADR 0065), coarse location
  (the IP/timezone-derived weather city, ADR 0091), identifiers, and diagnostics once
  Sentry lands. Not used for tracking.
- **Availability: US storefront only** — the condition for Stripe web checkout.
- **Listing:** name, subtitle, description, keywords, screenshots at the sizes App Store
  Connect asks for, support URL, privacy URL (`https://chordapp.ai/privacy`), age rating
  (any age with a parent's or guardian's consent since 2026-10-20 — ADR 0283; under-13s
  only through a Family Link-supervised Google account), export-compliance answer.
- **Permission prompts** (calendar, contacts, camera, notifications) — purpose strings
  in `mobile/app.json` should read as specific reasons, not boilerplate.

---

## Workstream M — Website / positioning  ✅ **DONE 2026-08-13**

**Why:** the landing page (`mobile/app/index.tsx`, served by the same Expo web build at
`chordapp.ai`) still describes the **team-MVP** product: *"FAMILY OPERATING SYSTEM — the
group chat that actually keeps track."* Every example on the page is a chat message
(`@Chord add milk to the Costco list`), and the whole flow is framed around **Telegram
onboarding**. That is no longer what Chord is. A visitor cannot tell that Chord reads and
organizes their **email**, keeps a real **calendar** in sync both ways, extracts **to-dos
and events** from mail without being asked, remembers **people and important dates**, and
handles **files and search** across all of it. We are pitching a chat app and shipping an
assistant.

**Rewrite the story around what actually ships today:**
1. **Lead with the outcome, not the surface.** Something in the shape of *"Your family's
   inbox, calendar, and to-dos — handled."* The group chat becomes **one** of the ways you
   talk to it, not the product.
2. **Show the four real surfaces** (they map to the app's tabs, so the page mirrors the
   product): **Email** — the attention map, suggestions docked on the mail that produced
   them; **Calendar** — two-way Google sync, invites reconciled, no duplicates;
   **To Do's** — action items, tasks, lists, trips, attachments; **Chat** — ask Chord
   anything, in-app or Telegram/WhatsApp.
3. **Replace the Telegram-first onboarding** as the hero path with **Sign in with Google →
   connect Gmail/Calendar**; keep Telegram/WhatsApp as "also works where you already chat".
4. **Say the consent model out loud** — nothing is written without a confirm; every
   suggestion links back to the email it came from. This is the differentiator against
   "an AI that just does things," and it is literally true in the code.
5. **Pricing section** (needs J3 decided): free 30-day trial, then the plan; BYOK is
   always free. The page should state the trial *and* what happens after, since the app
   now gates.
6. **Screenshots over prose** — the email map and a suggestion card carry more than a
   paragraph. Reuse the Workstream I2 footage.
7. **Housekeeping:** privacy policy already exists (`mobile/app/privacy.tsx`) — link it
   from the pricing/consent copy too; make sure the waitlist form still points somewhere
   we read; keep the page a single self-contained route (it is the same Expo web bundle,
   so no new hosting).

**Verification:** show the page to someone who has never seen Chord and ask what it does —
if "group chat" is the first phrase back, it hasn't landed.

---

## New ADRs to write (per CLAUDE.md convention)
- **Billing + tier-based model routing** (implements ADR 0044's deferred billing; three-tier
  routing, cheap-OSS free tier + graceful out-of-credit degradation, Stripe web checkout,
  per-premium-turn debit, public-store IAP caveat).
- ~~**Per-group inbound email mailbox**~~ — not needed; Workstream K cut 2026-07-15
  (superseded by the Gmail reader track, see the note on K).
- **Global cross-entity search** (per-table generated `body_tsv` + GIN mirroring the attachment FTS,
  `UNION ALL` query rather than a denormalized index; user-scoped to the searcher's group
  memberships — the user-facing complement to the bot's ADR 0032 scope, not a violation of it;
  reuses `searchAttachmentChunks` for files).
- **Phone-as-attribute identity + SMS verification** (extends ADR 0014; phone backfill from WhatsApp).
- **Deterministic contact discovery** (hashed phone matching; privacy posture).
- **Pair groups + cross-user `message_user`** — the bounded exception that *creates* scope rather
  than violating ADR 0032; sender-initiated opt-out consent + relation to trust ADR 0026.
- **Hybrid calendar** (device-local read + Google write-back; extends ADR 0040).
- **Push notifications** (Expo; fan-out + WhatsApp fallback).
- **WhatsApp 24h-window gating + templates** (extends ADR 0053).
- **Login for the App Store (O2)** — Sign in with Apple vs phone-only login; amends
  ADR 0014 either way (added 2026-09-10).
- **AI-sharing consent (O3)** — what the in-app permission covers, when it is asked,
  and what declining disables (Apple 5.1.2(i); added 2026-09-10).
- F&F deployment/hardening posture; native distribution + **Google Play publish & OAuth
  verification posture** — restricted-scope verification, demo-video requirement, CASA, and the
  100-user testing cap as the bridge for the first cohort (extends ADR 0048).

---

## Critical path to the public launch (2026-09-10)

The sequencing further below is the original F&F build order, kept for reference. What
remains for the **iOS App Store (US) + web** launch, in dependency order:

| When | Item | Blocks |
|---|---|---|
| **Now, owner** | **Submit Google OAuth verification (O1)** — deploy `main` first; then Search Console, demo video, console fields. CASA follows the scope review | new users past 100; the unverified-app screen |
| **Now, owner** | **Apple login decision (O2)** — Sign in with Apple vs phone-only login | the O2 ADR + build |
| **Now, owner** | **J3 subscription decisions** (plan shape, what it grants, coexist with credits) | all J3 code |
| **Now, us** | **Sentry (N)** — hours, and it should be watching before public traffic arrives | seeing what breaks |
| **Now, us** | **AI-sharing consent screen (O3)** — needed by Apple 5.1.2(i) regardless of the other decisions | App Store approval |
| Next | O2 ADR, then build the chosen login | App Store approval |
| Next | J3 build: subscription mode + lifecycle webhook + entitlement ordering + portal + card | charging anyone |
| Next | **Stripe smoke** (test mode, then live keys) — J1 + J3 together | charging anyone |
| Next | CASA Tier 2 with the lab; fix findings; rescan | Google approval |
| Then | App Store submission (O3): listing, privacy labels, demo account, US storefront only | the launch |
| Then | Deploy: `npm run migrate`, bulk-stamp the 17 ghost attachments, **seed promo credits**, then `BILLING_ENABLED=true` | flipping billing on |
| Before 1 Oct | Re-cost the WhatsApp taster + briefing under Meta's service-message pricing (ADR 0139) | WhatsApp cost at launch volume |
| Deferred | Android fingerprint + build profiles + Play listing (H2 gate 2, H3) | the native Android app only |
| Optional | `EMAIL_PERSONS_ENABLED` dogfood (`npm run dogfood:persons`) | nothing |

**Order of work:** the three owner items first, because Google's review and CASA are
the longest waits and every later step depends on the Apple and J3 decisions. Sentry
and the AI-consent screen can run in parallel with them — neither depends on a decision.

**Do Sentry first among the build items.** It is hours, not days, and it is worth more
before public traffic arrives than after.

---

## Suggested sequencing (original build order)
1. **Long poles now (parallel):** Twilio/Meta WhatsApp Business + templates (G); production host +
   secrets (A1); **Google OAuth verification + (if required) CASA assessment (H2)** — weeks of
   external review, so open the ticket and record the OAuth demo video as soon as the production
   OAuth client + privacy policy exist.
2. **Foundations:** stability/hardening + bug triage (A2/A3).
3. **Billing gate (J) — release-blocking:** credit ledger + per-turn debit + BYOK-free gate +
   Stripe web checkout. Must land before any non-team user touches our LLM key.
4. **Identity + Contacts (B → C):** phone attribute + verification, then device contact discovery
   and the resolver — prerequisites for the flagship.
5. **Notifications (F)** and **Hybrid calendar (D)** — both feed the flagship.
6. **Flagship (E):** pair groups + `message_user` + cross-user calendar invite, then wire the
   WhatsApp NLU path (depends on B, C, D, F, G).
7. **Global search (L)** — independent of the flagship; can land anytime after Foundations since the
   attachment FTS pattern is proven. Slot it alongside UX work as a high-value, self-contained win.
8. **Distribution (H)** + **UX/help (I1, I3)**, then record the **videos (I2)** against finished UI.
9. Pilot with 3–5 people before the full F&F list.

---

## Verification
- **Identity/contacts:** verify a phone via OTP; confirm a WhatsApp-only user got backfilled;
  upload a contact list and confirm only real Chord users resolve; confirm a non-Chord contact
  does not resolve.
- **Flagship (end-to-end):** from a real WhatsApp 1×1, send *"message Adrian to meet for coffee
  at 11a"* → Adrian (a second test account) receives the message (push + WhatsApp) and a calendar
  invite for 11a; verify a pair group was created (not a scope leak into either personal group);
  verify a blocked sender is refused.
- **Calendar hybrid:** confirm device-local events show as busy for availability; confirm a
  created invite still lands on the attendee's Google calendar.
- **WhatsApp proactive:** let the 24h window lapse, confirm a nudge arrives via approved template;
  forged webhook rejected.
- **Stability:** rate-limit returns 429; `/health/ready` reports unhealthy when Postgres is down; an
  error reaches Sentry; one backup→restore cycle; `npm test --workspace=server` green.
- **Sentry (N):** a deployed server error appears with the right release/environment tag; a mobile
  crash in a preview build arrives symbolicated; a request carrying `x-chord-token` shows neither
  the token nor the request body in the event.
- **Android (H3) — deferred, not part of the initial release:** Google's digital-asset-links tester returns the app statement for
  `chordapp.ai`; on a real device, Google sign-in completes **in the app**, a
  `chordapp.ai/join/<CODE>` link opens the app rather than Chrome, and a push notification lands.
- **Distribution:** install via TestFlight + a Play track; tap a `chordapp.ai/join/<CODE>`
  link on a fresh device on both platforms and confirm native open + correct group.
- **Google publish:** OAuth verification submitted with the demo video; consent screen shows the
  verified app name with no unverified-app warning; Play Data-safety form matches the scopes
  actually requested; a non-test Google account (outside the testing cap) can grant Calendar and
  complete the flagship flow.
- **Search:** a query matching content in messages, a task, a list item, a save, and a file returns
  one hit of each kind with a highlighted snippet; tapping each deep-links to the right place in the
  right group; global search spans the searcher's groups but a query is confirmed to return **nothing**
  from a group the searcher is not a member of; bot-only (`chord_visible=0`) messages never appear.
- **Onboarding:** a non-technical tester runs the full cold path; in-app help + video cover each stall.
