# 0225 — An image is fetched when the mail arrives, not when it is opened

Status: accepted (2026-10-03)

## Context

ADR 0136 routes every remote image in an email through Chord's server, so the
sender never sees the reader's IP address or device. It said plainly what was
left: the fetch still happens when the mail is opened, so the sender learns
that the address is live and roughly when the mail was read. That ADR named
the fix (Apple's preload at delivery) and declined it as "an order of
magnitude more machine".

Two things were found while checking why the app showed tracking domains in
the phone's privacy report (it did not: the entries were Google's own sign-in
page). Both are fixed here.

1. **The sanitizer missed seven spellings of a remote reference.** It matched
   the literal text `http(s)://` and `url(...)`, but a browser accepts more: a
   tab or newline inside the scheme, CSS escapes in `url` or in the address, a
   comment inside the brackets, and `image-set()`, which takes a bare string.
   Each reached the web view untouched, with images blocked and with images
   proxied alike, and was fetched directly from the phone.
2. **Nothing but the sanitizer stood between an email and the network.** The
   web view would load whatever the sanitizer let through.

## Decision

**The reader's document can load images only from Chord.** The email body is
rendered with a content security policy (`emailBodyCsp`): `default-src 'none'`,
images from Chord's own origin or `data:`, inline styles, and nothing else. A
reference the sanitizer fails to recognise is refused by the web view. The
seven spellings are also recognised by the sanitizer now (`cleanEmailUrl`,
`filterRemoteCss` in `kernel/src/email-images.ts`), and a style declaration
that still names a remote host after every `url()` is rewritten is dropped
whole. The web reader has no document to put a policy on and relies on the
sanitizer alone.

**Images are fetched when the mail arrives.** After each sync,
`preloadEmailImages` (`services/email/image-preload.ts`) goes through the
user's newest messages that have not been through it, fetches every remote
image in the body, and stores it. Opening the mail later is answered from the
store and sends the sender nothing. To the sender every message looks opened,
at delivery, from Chord's address, whether or not it is ever read.

- **The reader does not change.** It still asks `GET /me/email/image` for each
  image. The route answers from the store when it holds the image and fetches
  live (ADR 0136) when it does not. A miss is therefore never a broken image.
- **One name for an image.** The pass and the reader both go through
  `absoluteEmailImageUrl`, and the store is keyed by a hash of the parsed URL.
  Where the pass's reading of the HTML (`remoteImageUrlsInHtml`, a regex over
  the raw body) differs from the sanitizer's parse, the image is simply not
  found ahead of time and is fetched on open.
- **All mail, including bulk.** Marketing mail carries the most trackers, so
  skipping it would skip the case this is for.
- **Not junk or trash.** A fetch at delivery tells the sender the address is
  live; that is acceptable for mail the user receives and not for spam.
- **Not for a reader who blocks images.** With `users.email_images_auto` off
  the pass fetches nothing and leaves the messages unmarked, so turning images
  back on still preloads recent mail.
- **Bounded.** 20 messages per pass, 40 images and 5 MB of stored bytes per
  message (the rest load on open), only mail from the last 30 days, and stored
  copies are removed after 30 days. All four are settings.
- **Not awaited.** The pass is started from `runAfterSyncPasses` above the
  ADR 0079 gate (it costs no LLM call) and runs behind the sync, one pass per
  user at a time, so a sync never waits on a slow image host.
- **Stored like other files.** Bytes go to `DATA_DIR/email-images/<user>/` via
  `writeBlob`, so they are sealed when content encryption is on (ADR 0201).
  Rows cascade with the user; account deletion removes the folder.

Migration `098`: `email_image_cache` and `email_messages.images_preloaded_at`.

No bot tool: nothing here is something a user does or sets.

## Rejected

- **Preload only non-bulk mail.** Far less bandwidth, but it leaves the open
  visible for exactly the senders who track opens.
- **Rewrite the stored HTML to point at stored copies.** A second copy of the
  is-this-remote decision, on the server, that must agree with the sanitizer
  forever (the ADR 0085/0127 failure). Leaving the reader alone and answering
  the same route from a store has no such agreement to keep.
- **Retry a failed fetch on a later pass.** The proxy already fetches it when
  the mail is opened, and a host that is down would be asked again every sync.
- **Await the pass in the sync.** A sync would then take as long as the
  slowest image host in the mailbox (ADR 0205's reasoning).
- **A shared store across users.** Tracking URLs are per recipient, so there
  is little to share, and a shared store would let one user's token read an
  image fetched for another.
- **Store images when the proxy fetches them live.** Would help re-opens, but
  the browser cache already covers those for a day, and it is a second writer
  to the store.

## Consequences

- Senders' open statistics for Chord users become meaningless rather than
  merely anonymous. A sender who acts on opens (a "you haven't opened our
  mail" sweep) will see every message as opened.
- The server now fetches images for mail nobody reads. Bandwidth and disk
  grow with mail volume, not with reading. `EMAIL_IMAGE_PRELOAD=false` turns
  the pass off and the route goes back to fetching on open.
- A message whose images were not stored (over the allowance, fetch failed,
  older than the window, synced before this shipped) still reveals its open.
- Not checked on a device: the content security policy bans page script, and
  the height probe is injected by the app, which should be exempt. If it is
  not, bodies render at the default height.
