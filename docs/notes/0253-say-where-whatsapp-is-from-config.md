# 0253 — Say where WhatsApp is, from config

**Status**: accepted
**Date**: 2026-10-15

## Context

Telegram is explained in the app: a Connected apps card says what it does and
walks the binding. WhatsApp had nothing. The Chord business number appeared in no
screen (no `wa.me` link, no number anywhere in `mobile/` or the API); the only
WhatsApp UI was a mute row under Briefings that appears once a chat is already
bound, and the phone-verification copy said numbers exist "so friends can find
you" while verifying one is also what links the user's WhatsApp automatically
(ADR 0064). A person learned Chord was on WhatsApp by being told, and was never
told where.

The owner will change the business number later.

## Decision

- **The number is configuration, read at runtime.** `WHATSAPP_PUBLIC_NUMBER`
  (E.164) is the one place it lives. It is validated (`normalizeE164`, so a typo
  hides the entry rather than rendering a broken link) and served on `/health`
  (the sign-in page needs it before anyone is signed in) and on `/me/settings`.
  Nothing in the app binary knows a number, so changing it is a redeploy, never
  an app release or an OTA. Empty hides every entry: an offer with no number
  would be worse than no offer.
- **Three places say it**, all tap-to-open `wa.me` with a first message:
  1. Settings → Connected apps gets a WhatsApp card beside Telegram (what it is,
     the number, **Open WhatsApp**, and "✓ Connected" once a chat is bound);
  2. the phone-verify step says verifying also lets you chat on WhatsApp;
  3. the sign-in page's "also works where your circle already chats" names the
     number and links it.
- **Linking is by the user's number, not Chord's.** A person's WhatsApp identity
  is keyed on THEIR `whatsapp:+E164`; changing Chord's number leaves every
  binding intact. What changes is where people send messages and what Chord
  sends from: the Meta phone-number id and token (`META_WHATSAPP_*`) are a
  separate config that has to move with it, and the 24-hour window is per
  business number, so a chat a user had open with the old number does not carry
  over.

## Consequences

- No bot tool: this is information, not a way to change anything.
- A person who has the old number saved keeps messaging it until it is retired;
  the app, the landing page and the briefing's links all follow the new one the
  moment config does.
- The card needs `settings` loaded to render; on a slow load it appears with the
  rest of Connected apps.

## Rejected

- **Baking the number into the app.** The owner is going to change it.
- **A Connect button that binds in-app.** WhatsApp onboards by the user
  messaging Chord (ADR 0053); there is no pairing code to show. The honest entry
  is "message this number from the one you verified".
- **Showing the card without a number.** A card that says "WhatsApp" and offers
  nothing is the same gap with a heading.
