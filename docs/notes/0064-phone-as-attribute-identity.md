# 0064 — Phone-as-attribute identity + SMS verification

**Status**: accepted — testable server core shipped (schema, verification service, OTP provider abstraction, WhatsApp backfill); mobile OTP UI is a follow-up
**Date**: 2026-07
**Extends**: [ADR 0014 — Google-only auth](./0014-google-only-auth.md)
**Enables**: [ADR 0065 — deterministic contact discovery](./0065-deterministic-contact-discovery.md), and through it the flagship cross-user message (Workstream E)
**Workstream**: Friends & Family release plan — B

## Context

The flagship feature ("message Adrian to grab coffee at 11a") needs a
deterministic key to map a device-address-book contact to a Chord user. Names
are ambiguous and group-scoped; email isn't in the address book in a usable
form; a phone number is. But Chord's login anchor is Google (`google_sub`, ADR
0014) and that must stay — it's what carries the Calendar/Gmail scopes. So the
phone number is an **additional verified attribute** on the Google-anchored
account, not a second login method.

WhatsApp inbound (ADR 0053) already captures each sender's E.164 as
`external_identities.external_id` (platform `whatsapp`, stored as the Twilio
`From`, i.e. `whatsapp:+15551234567`) — WhatsApp already proved ownership, so
those users can be backfilled without re-verifying.

## Decision

### Phone is a verified attribute on `users`

Migration `022_user_phone` adds to `users`:
- `phone_number` — E.164, partial-`UNIQUE` (only when set),
- `phone_hash` — HMAC-SHA256 of the E.164 (the value ADR 0065 matches contacts
  against; denormalized + indexed so resolution is a hash-set lookup, never a
  per-row re-hash),
- `phone_verified` — `integer 0/1`.

Google login is untouched; a user without a phone is exactly as before.

### Verification via a provider abstraction (mock ‖ Twilio Verify)

Mirrors the LLM provider split (`LLM_PROVIDER=mock`). `OtpProvider`
(`services/phone/otp.ts`) has `start(db, phone)` / `check(db, phone, code)`:

- **mock** (default) — a deterministic, DB-backed store (`phone_verifications`
  table): "sends" a fixed code (`PHONE_VERIFY_MOCK_CODE`), enforces TTL +
  attempt-cap, deletes the row on success/burn. Runs the whole flow with no
  Twilio account (tests, mock demos).
- **twilio** — Twilio Verify (reuses `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN` +
  `TWILIO_VERIFY_SERVICE_SID`). Twilio owns the code + retry state, so the DB
  table is untouched on that path.

`getOtpProvider()` degrades to mock (with a warn) if `twilio` is selected but
creds are missing, so a half-configured deploy never crashes.

`phone.service.ts` owns normalization, the uniqueness guard, and the users-row
write; the provider only proves control of the number. Expected failures
(`invalid_phone`, `taken`, `invalid_code`, `expired`, `too_many_attempts`,
`not_found`) are a **result union**, not thrown — the route maps each to a
status without string-matching messages.

Endpoints: `POST /me/phone/start`, `POST /me/phone/verify`, `GET /me/phone`
(status). Kernel: `StartPhoneVerificationRequest` / `VerifyPhoneRequest` /
`PhoneStatus` + the `API.mePhone*` paths.

### Server-side normalization is deliberately small

`normalizeE164` canonicalizes already-international input (`+`-prefixed, or a
`00` IDD prefix) to `+`<digits> and rejects anything ambiguous (a bare national
number with no country code isn't guessed). The mobile client does the richer
libphonenumber parsing before it ever hits the server; the server's job is a
stable canonical form so its stored hash matches the client's. No
libphonenumber dependency on the server.

### WhatsApp backfill

`backfillWhatsappPhones(db)` (script: `npm run backfill:phones`) reads
`external_identities` platform `whatsapp`, strips the `whatsapp:` prefix,
normalizes, and sets `phone_number`/`phone_hash`/`phone_verified=1` — trusting
WhatsApp's prior verification. Idempotent: skips a user who already has a
number, and never clobbers a number another user owns. Extracted from the
script into a service function so it's unit-tested against seeded rows.

## Consequences

- A verified phone is now a first-class identity key, without weakening the
  Google login/calendar path.
- `BILLING_ENABLED`-style gating isn't needed — the feature is inert until a
  user verifies; nothing else reads `phone_*` yet except ADR 0065.
- The mobile "add your phone" step (onboarding + settings) and switching the
  deploy to `PHONE_VERIFY_PROVIDER=twilio` remain; the server contract they
  build against is fixed and tested.

## Alternatives considered

- **Phone-only login.** Rejected — it would sever the Google token that carries
  Calendar/Gmail scopes (ADR 0014/0015), the whole reason auth is Google-anchored.
- **Store only the raw number, hash on demand.** Rejected — every contact-resolve
  request would re-hash every user row. Denormalizing `phone_hash` at verify
  time makes resolution an indexed `IN (…)` lookup.
- **Roll our own SMS.** Rejected — Twilio Verify handles code generation,
  delivery, rate-limits, and fraud; we already depend on Twilio for WhatsApp.

## Addendum (2026-08-21) — verification claims the WhatsApp identity

The backfill above runs one way only: WhatsApp identity → phone number. The
reverse never existed, so a user who verified their number in the app was
still a stranger to WhatsApp. To bind, they had to message the business
number, spend all `WHATSAPP_TASTER_TURNS` (10) as a shadow, wait for the
turn-11 signup nudge, and tap its referrer link *on the device they sign in
on* — the AsyncStorage token doesn't cross browsers (ADR 0053 / 0031). In
practice that last hop is where people fall off.

`linkWhatsappIdentityForPhone` (`phone/whatsapp-link.ts`) closes the loop.
On a successful `verifyPhone`, the number's `whatsapp:+E164` identity is
claimed for the verifying user: created if absent, or — when a taster shadow
already holds it — folded in via the existing `mergeOrLinkExternalIdentity`,
which re-points memberships, message attribution, and every user FK before
deleting the shadow. Wrapped in one transaction; a partial apply would orphan
those rows or trip the FK on the delete.

The payoff is on the *next* inbound message: `maybeAutoBindForPairedSender`
sees a real (non-shadow) identity and binds the DM straight to the user's
personal group. No taster, no link, no cross-device hop.

**Gated to a real OTP provider** (`provider.name !== 'mock'`). This is the
non-obvious part. The mock provider's code is fixed (`PHONE_VERIFY_MOCK_CODE`,
`000000` in prod today), so under it "verification" proves nothing. Claiming
an identity on that evidence would let any signed-in user type a stranger's
number plus `000000` and absorb the shadow behind it — including the personal
group holding that shadow's taster conversations. Two existing guards bound
the damage but don't remove it: `isTakenByAnother` blocks numbers a *real*
user already verified, and `mergeOrLinkExternalIdentity` refuses to re-point
an identity owned by a non-shadow user. Shadows are left exposed, and a shadow
holds real chat history. The gate is on the provider rather than an env flag
so a stale `.env` can't re-arm it.

Consequence: the feature is inert until the deploy moves to
`PHONE_VERIFY_PROVIDER=twilio` with a real `TWILIO_VERIFY_SERVICE_SID` — the
switch ADR 0064 already listed as outstanding. Note `getOtpProvider` fails
*soft*: provider set to `twilio` with a missing SID logs a warning and returns
mock, which also (correctly) leaves the auto-claim off.

Link failures are swallowed and logged — a connector-side problem must never
undo a verification the user actually completed.

### Release + transfer (same date)

The original design had no way out of an attachment. `isTakenByAnother`
refused a held number at both `start` and `verify`, and the API surface was
GET / start / verify — no release, no operator tool. The only escape was the
holder deleting their whole account (`account.service.ts` does a real
`DELETE FROM users`, so the number frees then). That fails two ordinary
cases: carriers recycle numbers after 45–90 days, and — under the mock
provider, where `000000` validates *any* number typed — a single mistyped
digit permanently attaches a stranger's real number to your account and locks
its actual owner out forever.

Two additions:

- **`DELETE /api/v1/me/phone`** (`releasePhone`) clears
  `phone_number`/`phone_hash`/`phone_verified` for the caller, idempotently.
- **Transfer on proof.** A successful code from a real provider now takes the
  number from its prior holder instead of returning `taken`. A fresh OTP
  proves *current* control of the line, which is better evidence than a stale
  attachment; this is what most services do.

Both drop the number's WhatsApp identity **and** its
`group_external_channels` binding (`unlinkWhatsappIdentityForPhone`). Dropping
the binding is not incidental: the inbound pipeline resolves the channel
before the sender, so an orphaned row would keep routing that number's
WhatsApp into a group whose owner no longer claims the number, minting a
fresh shadow per message. It is also what makes transfer work end-to-end —
`linkWhatsappIdentityForPhone` refuses an identity a real account still
holds, so the prior owner must be detached first, in the same transaction as
the ownership swap.

Transfer carries the same `canTransfer(provider)` gate as the auto-claim, for
a sharper reason: it deliberately removes the last-owner guard, so pairing it
with the mock's fixed code would let anyone take any number — including ones
a real user verified. Under mock the old `taken` behaviour stands unchanged.

A transfer logs at **warn**: an account silently lost a verified identity
attribute, and with it contact discovery (ADR 0065). Notifying the prior
owner out-of-band is the obvious follow-on and is not built.

## Addendum (2026-08-21) — the mock OTP provider is removed

`mockOtpProvider` and `PHONE_VERIFY_MOCK_CODE` are gone. The original ADR
framed the mock as mirroring `LLM_PROVIDER=mock` — a deterministic seam for
tests and demos. That analogy was wrong, and the difference is the whole
lesson: a mock LLM produces a fake *answer*, while a mock OTP produces a real
*identity claim*. A verified number drives contact discovery (ADR 0065),
claims the matching WhatsApp identity, and now takes a number off another
account. Under a fixed `000000`, any signed-in user could type a stranger's
number and collect all three.

It also shipped that way. `PHONE_VERIFY_PROVIDER=mock` ran in production for
weeks, which is the argument against keeping a "dev only" fixed-code path at
all: the safe default has to be *off*, not *weaker*.

What changed:

- Twilio Verify is the only provider. `getOtpProvider()` returns
  `OtpProvider | null` and **never falls back** — null when the credentials
  are absent. The old soft fallback was the sharp edge: a deploy with
  `PHONE_VERIFY_PROVIDER=twilio` and an empty service SID logged a warning
  and quietly verified everyone with `000000`.
- `unavailable` is a real result on both service functions, surfaced as
  **503** (the request was fine; the deploy isn't configured), with client
  copy to match.
- `PHONE_VERIFY_PROVIDER`, `PHONE_VERIFY_MOCK_CODE`, `PHONE_VERIFY_TTL_MINUTES`
  and `PHONE_VERIFY_MAX_ATTEMPTS` are deleted. Twilio owns code lifetime and
  attempt limits, so the last two only ever configured the mock. Verification
  is now ON iff `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` +
  `TWILIO_VERIFY_SERVICE_SID` are all set — no separate switch to fall out of
  sync with the credentials.
- Tests inject their own provider through the existing `provider` parameter.
  The tests that exercised expiry and attempt-burning were testing the mock's
  own state machine, which Twilio owns; they are now stub-driven assertions
  that the service surfaces each provider reason.

**Behavioural consequence worth knowing:** the `canTransfer(provider)` gate
and the matching gate on the WhatsApp claim are gone, because no provider can
issue a guessable code any more. Transfer-on-proof is therefore
unconditional, and `taken` survives only as the partial-unique-index race
backstop — `startPhoneVerification` no longer pre-refuses a held number at
all, since proving control of the line is precisely how a recycled number is
reclaimed. The protection is structural now rather than a runtime check.

`phone_verifications` is left in place but is no longer read or written by
anything; only the mock used it. Dropping it wants its own migration and is
deliberately not bundled here.

## Addendum (2026-08-21) — WhatsApp signup verifies the number

Both directions now hold. The earlier addendum made a verified number claim
its WhatsApp identity; this one makes a linked WhatsApp identity grant the
verified number. Registering a WhatsApp account requires an OTP to that same
line, so it is the same proof arriving by a different route — asking someone
who signed up *through* WhatsApp to then receive an SMS code is asking them
to prove the same fact twice.

The rule already existed as `backfillWhatsappPhones`, but only as a one-shot
script, so every new WhatsApp signup got an identity row and no phone. The
per-row logic is now `adoptPhoneFromWhatsapp`, called from
`mergeOrLinkExternalIdentity` — the single choke point every link passes
through (pair code, referrer signup, and the phone→WhatsApp claim). The
backfill is the same function swept over pre-existing rows.

Two deliberate refusals:

- **It never takes a number another account holds**, where
  `/me/phone/verify` now does. The evidence is equally strong but not equally
  *fresh*: an OTP proves control a minute ago, while an identity row may date
  from a taster months back (the referrer token alone lives 14 days).
  Freshness only matters for the one operation that takes something away from
  someone else, so transfer stays with the deliberate, real-time path.
- **It never gives a shadow a verified number.** A shadow is not an account
  yet, and `phone_verified = 1` is exactly what makes a row resolvable in
  contact discovery (ADR 0065) — a taster would otherwise surface in
  strangers' contact lists as though it were a person. Adoption therefore
  runs *after* the shadow merge, against the real owner.

Adoption is best-effort and never fails the link: it is a convenience on top
of a completed merge, not part of it.
