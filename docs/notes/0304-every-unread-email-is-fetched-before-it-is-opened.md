# ADR 0304 - Every unread email is fetched before it is opened, on the web too

Status: accepted, 2026-10-27. Amends ADR 0302 (the phone's store) and ADR 0218
(prefetch).

## Context

The owner: "download the unread emails (not just the next one), so the
experience is seamless, on web as well as app", and then "except suspected
spam".

What existed:

- ADR 0218: the reader warms only the next and previous email (`?prefetch=1`,
  which also starts that email's read-time check, ADR 0205 addendum).
- ADR 0302: on phones, a background pass keeps two weeks of inbox mail as
  sealed files. That store only exists from the native build that carries
  `expo-secure-store` (added 2026-10-26, runtime `appVersion` 1.0.0; a phone on
  an older binary keeps nothing). Where it is live it still missed unread mail
  in two ways: an unread email older than **14 days** was never fetched and
  was pruned if stored, and a pass fetched only the newest **40** threads,
  read and unread mixed, so a busy fortnight pushed unread mail behind read
  mail.
- Web: no copy of any body at all - every open waited on the server.

## Decision

**One store, two backends.** The ADR 0302 store (`mobile/src/email-device-store.ts`)
gains a memory backend for the browser; the rules stay in
`kernel/src/email-device-cache.ts`, so the phone and the web decide the same
way. No second cache.

**What is kept.** Every unread inbox thread, **whatever its age**, plus read
inbox threads within the 14-day window (`keptOnDevice`). Caps:

- at most **300** unread threads (`DEVICE_MAIL_UNREAD_MAX_THREADS`); past
  that, the oldest unread **outside** the window go (unread inside it are kept
  as two-week mail);
- under the size and count limits, read mail goes before any unread email
  (`deviceMailToPrune` ranks unread first, each newest first);
- phone: 100 MB / 1,000 threads as before; browser: **40 MB / 400 threads**
  (`WEB_MAIL_LIMITS`), since it is held in a tab's memory;
- a thread over 1 MB is still not kept.

**What a pass reads.** The inbox list to the 14-day line (as before) and the
**unread-only** inbox list (`?unread=1`, up to 6 pages of 50 = 300). It
fetches new or changed threads **unread first, newest first**
(`threadsToPrefetch`), 3 at a time, 40 per pass; a pass that leaves work
behind runs again **5 s** later by itself, until everything is fetched. Every
fetch uses `?prefetch=cache` (ADR 0302): no read-time check, no warm-up, no
model call - the LLM cost of preloading 300 emails is zero. The real open
(read-time check, mark-read) still happens when the email is tapped; the
reader paints the stored copy first and replaces it with the open's answer, on
the web exactly as on the phone.

**Polite.** A pass fetches nothing while the app (phone: `AppState` not
`active`) or the tab (web: `document.visibilityState === 'hidden'`) is hidden,
or offline (`navigator.onLine === false`, or 3 failed fetches in a row), and
stops mid-pass when that changes. It resumes on the next sync, Email-tab
focus, or (web) the tab becoming visible or going back online - still at most
one pass a minute unless a sync forces one.

**Suspected spam is never kept** (owner). A list row in `SPAM` is never
fetched; a fetched thread whose sender check says **danger** (ADR 0294), or
that carries a read-time **caution** (ADR 0180), is not stored
(`suspectedForDevice`) and is not asked for again until a new message arrives
in it. Such an email opens online only, so a phishing message is never held
on the device. A list row says nothing about the sender, so judging needs one
fetch; it costs a request, not a model call. `caution`-level sender signals
(first contact, no auth) are not enough: they fire on ordinary mail.

**Leaving.** As ADR 0302/0286, plus:

- An old stored email kept only for being unread leaves when it is **read
  elsewhere**: the unread list a pass reads no longer shows it
  (`unreadReconcile`; judged only where that list reaches, or when it ended),
  an `email.thread.updated` event says it is read, or the reader marks it
  read on open (the stored copy is updated with the same answer).
- A removal from this device beats a fetch already in flight: a thread removed
  after its request started is not stored when the answer lands (ADR 0286's
  rule, applied to the store).

**Web: memory only, not IndexedDB.** The browser copy lives in a JavaScript
`Map` for the life of the page: a reload or closed tab empties it and the next
pass refills the unread mail in seconds. ADR 0302 seals every phone file
under a key in the Keychain/Keystore; a browser has no such key store, so
IndexedDB would hold readable mail on disk, on what is often a shared or
borrowed computer, surviving sign-out on a crash - the copy ADR 0269 exists
to prevent. The cost is a re-download after each reload. Sign-out clears the
memory with everything else (ADR 0269), and opening as another user drops
the previous user's entries.

No bot tool: this is how one device holds what it will show, with nothing to
change or choose (ADR 0282's reasoning for per-device storage).

## Consequences

- Opening any unread email, and walking through unread mail, paints at once
  on the web and on phones with the store's native build.
- More requests after a sync: up to 300 unread threads once, then only what
  changed. Server cost is a mirror read per thread; no model calls.
- Phones on a build without `expo-secure-store` still keep nothing (ADR 0302);
  this needs the next native build there. The web needs only a deploy.
- A suspected-spam email opens with a round trip, by design.
- Unread mail beyond the 300 newest unread threads is not preloaded.

## Rejected

- **IndexedDB on the web**: unencrypted mail on disk (above).
- **A separate web cache** beside the phone store: two sets of keep/evict rules
  to drift.
- **`?prefetch=1` for the unread preload**: a read-time model call per unread
  email nobody has opened (ADR 0219/0221 cost).
- **No cap on unread**: a mailbox with thousands of unread newsletters would
  fill the phone.
- **Fetching all unread in one pass**: 300 requests in a burst; chunks of 40
  with a short pause keep it polite and stop cleanly when hidden.
- **Skipping caution-level senders too**: would leave out much ordinary mail.
