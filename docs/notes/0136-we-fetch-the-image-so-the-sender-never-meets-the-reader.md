# 0136 — We fetch the image, so the sender never meets the reader

**Status**: accepted
**Date**: 2026-08-25
**Relation**: revisits the alternative [ADR 0120](./0120-a-remote-image-is-a-read-receipt.md)
parked; reuses the SSRF guard [ADR 0122](./0122-unsubscribe-is-three-different-promises.md)
extracted.

## Context

ADR 0120 blocked remote images and said the trade out loud: *"some mail looks
plainer until the reader taps Show."* In practice "plainer" understates it. A
retail or school email is mostly images — the logo, the header, the buttons —
so blocking them does not produce a plain email, it produces a **broken** one,
and the reader has to tap a banner on nearly every message to get a mailbox
that looks like the one they left.

That ADR also named the fix and declined to build it:

> **Proxy images through Chord.** What Gmail and Apple do, and the best answer
> for the reader — the sender learns nothing, images still appear. It is a
> service to run, cache, secure and pay for, and it makes us the party fetching
> arbitrary URLs on a user's behalf. Worth revisiting; not worth blocking this
> on.

Two of those three costs have since been paid by other work. ADR 0122 needed to
POST to an unsubscribe URL that arrived in someone's mail, and extracted
`utils/ssrf.ts` for exactly the "we are now the party fetching arbitrary URLs"
problem — the guard is written, tested, and has a second caller by design. What
is left is bandwidth, which is a number rather than an architecture.

## Decision

**Load remote images by default, and always through us — never from the
device.**

### The proxy is unconditional; the setting only decides whether to fetch

Once a proxy exists there is no case left where the device should fetch an
image out of someone else's email directly, so it never does. That splits the
question cleanly in two:

- **Whether** we fetch is the reader's call — a per-user default plus ADR
  0120's per-sender allow list.
- **How** we fetch is not a question at all. Every remote image in every email
  goes through `GET /me/email/image`, including one from a sender the reader
  explicitly allowed.

This is why the change is small. ADR 0120's blocking path is untouched and
still correct; it is now what a reader gets when they turn the default off,
rather than what everyone gets always.

### What the sender learns, stated exactly

This is a real reduction, not an elimination, and the difference matters
enough to write down.

| | Before (blocked) | Now (proxied) | If we had just unblocked |
|---|---|---|---|
| Your IP / rough location | never | never | **leaked** |
| Your device + mail client | never | never | **leaked** |
| Cookies, correlation across senders | never | never | **leaked** |
| Address is live, and roughly when read | never | **leaked** | **leaked** |

The bottom row is the honest cost and the reason this is an ADR rather than a
patch. Fetching a per-recipient URL at all tells the sender the address is
real. Caching blunts the repeat-open signal — a second read of the same mail
sends nothing — but the first open does report.

That is precisely Gmail's posture, and Gmail is the mailbox these readers came
from. What a proxy buys is that the sender meets *our server* instead of *a
family's phone*, which is where the location, device and correlation harms all
live. Apple's relay additionally decouples fetch-time from read-time by
preloading at delivery; that is a bigger machine (fetch and store every image
in every message on arrival) and is noted as future work rather than built.

### It stays on by default

The default is the whole decision here, exactly as it was in ADR 0120 — and it
is the opposite one, because the facts changed. 0120 chose blocking as the only
honest option *when the alternatives were load-and-be-tracked or
block-and-look-plainer*. With a proxy there is a third option that keeps the
harms that ADR was actually about, so the reasoning that produced block-by-
default now produces proxy-by-default.

`users.email_images_auto` (default 1) turns it off, and the reader is back to
ADR 0120 in full — banner, Show, Always, per-sender list — with the proxy still
carrying anything they do choose to load.

### One field, so the client keeps one rule

`EmailThreadDetail.imagesAllowed` becomes `auto || sender-is-allowed`, resolved
server-side as before. The reader already branches on that one boolean, so
default-on needs no new client logic and no second flag to keep consistent with
the first.

### The token is a capability, not an identity

An `<img>` inside a rendered body cannot send the session header, which is why
attachments (RN `<Image source={{headers}}`) do not have this problem and this
does. The proxy URL therefore has to authenticate itself.

It carries a sealed `{u, exp}` blob (AES-256-GCM via the existing
`sealToken`, 12-hour TTL, minted when the thread is opened) rather than the
session token. Three reasons, in order of how much they matter: a session
credential in a query string lands in every access log and proxy along the way;
the user id is not visible to anyone holding the URL, because the blob is
encrypted rather than signed; and a stolen image token expires on its own and
unlocks nothing but the image proxy.

### Refusing to become an open relay

The route is the one place in the product that fetches a URL chosen by whoever
mailed you, so the fetch is fenced on every axis: `assertPublicHost` per
redirect hop (`redirect: 'manual'`, max 3), `image/*` responses only, a 10 MB
cap enforced while streaming rather than after, an 8-second timeout, and no
request body, cookies or credentials forwarded either way.

Failure renders as a 1×1 transparent GIF, not a 502. A broken-image glyph in
the middle of an email is indistinguishable from the blocking this ADR exists
to remove, and a reader cannot act on it either way.

## Consequences

- Mail renders the way readers expect it to, without a per-message tap.
- Every opened email with a remote image now costs a server fetch. Bandwidth is
  bounded per image (10 MB) and cut by `Cache-Control: private, max-age=86400`,
  but this is a real running cost that scales with mail read, and it is the one
  thing here worth watching in production.
- Senders regain the open signal that ADR 0120 took away. Readers who want it
  back turn off one setting.
- `EMAIL_IMAGE_PROXY=false` kills the route deployment-wide and falls back to
  ADR 0120 behaviour, for the case where the cost above turns out to bite.

## Alternatives rejected

**Just unblock remote images.** The one-line version of what was asked for, and
it hands back the IP, device and cross-sender correlation — the three harms ADR
0120 was actually written about — to buy a rendering fix that the proxy also
buys.

**Load only "safe-looking" images (logos, anything not 1×1).** Treats "is this
a tracker" as knowable from a URL and a size. A tracking pixel can be any
dimension and a logo can be served from the tracking domain; ADR 0120 already
rejected this shape for block lists and it is no better here.

**Preload at sync, Apple-style.** Genuinely better — it decouples the fetch
from the read, so even the open signal goes — but it means fetching and storing
every image in every message that arrives, including the mail nobody opens.
That is a storage and bandwidth commitment an order of magnitude past this one,
and it can be added later behind the same route without changing what the
client renders.

**Sign the URL on the client.** Would avoid minting a token per thread open,
and cannot work: signing needs the secret, and a secret shipped to the client
is not one.

**Rewrite the HTML server-side instead of in the sanitizer.** Puts the
"which URLs are remote" rule in a second place, and the sanitizer must keep its
copy for the blocking path regardless. Two copies of one predicate is the
failure ADR 0085 and ADR 0127 both exist to prevent.
