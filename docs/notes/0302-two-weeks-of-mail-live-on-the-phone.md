# ADR 0302 - Two weeks of mail live on the phone

Status: accepted, 2026-10-26. Amends ADR 0218 (prefetch) and ADR 0269 (sign-out).
Amended by ADR 0304: unread mail is kept at any age and fetched first, suspected
spam is never kept, and the web keeps the same store in memory.

## Context

The phone kept almost no email. The inbox list's newest ~50 rows sat in
AsyncStorage (`email.threads.cache.v1`, no bodies), and the reader held up to
20 bodies in memory for two minutes, filled when it warmed the next and
previous email (ADR 0218). Everything else was fetched when opened: an email
from this morning took a round trip to show, and with no signal (a plane, a
basement, a lift) the Email tab showed nothing past that first page and no
email could be read at all.

The owner wants email to feel seamless: fetch ahead in the background and keep
the last two weeks on the device. Email content is sealed at rest on the
server (ADR 0201), so the copy on the phone is encrypted too, always (owner
decision, 2026-10-26: no user choice).

## Decision

**What is kept.** For every inbox thread whose newest message is within the
last **14 days** (`DEVICE_MAIL_KEEP_DAYS`): its list row and the full thread
as the reader receives it (each message's text and HTML, headers, the
attachment list). Not kept: **images** (they still load through the ADR 0136
proxy and the web view's own 24-hour cache) and **attachments** (still
downloaded when tapped). The short-lived image token that rides on a thread
(ADR 0136) is removed before it is written, so the device never holds a
capability that outlives the open that minted it.

**Files, not AsyncStorage.** Android's AsyncStorage is one SQLite database with
a 6 MB default cap, and one newsletter's HTML can be 200 KB; two weeks of
bodies does not fit and an overflow fails every later write, the session token
included. Each thread is one file under the app's **cache directory**
(`expo-file-system`), in a folder per signed-in user, beside a small index
(`index.json`: per thread its newest-message time, size, when stored and its
list row) and the last inbox list (`list.json`). The cache directory rather
than the documents directory: iOS backs the documents directory up to iCloud
and a copy of someone's mail in their phone backup is a place nobody would
think to look, while the cache directory is never backed up on either
platform. The OS may empty it under storage pressure; that only means the
next pass downloads it again.

**When it is fetched.** After each mail sync while the app is open (the Email
tab's own sync, a pull to refresh, an `email.synced` event while the tab is in
front) and when the tab comes into focus, on any network. One pass at a time,
at most one a minute. A pass reads the inbox list newest first until it passes
the 14-day line (at most 6 pages of 50), saves that list for offline painting,
and then fetches the threads that are new or whose newest message changed
since they were stored, newest first. Limits, so a huge mailbox cannot fill
the phone or the radio:

- 3 threads fetched at a time, at most 40 per pass (the next pass continues);
- a thread over **1 MB** stored is skipped (it opens online as before);
- **100 MB** in all and **1,000** threads: past either, the oldest go first.

Background fetches use **`?prefetch=cache`**, a new value of ADR 0218's flag.
`?prefetch=1` (the reader warming the next email) starts that email's one-time
read check (ADR 0205 addendum); doing that for every email of two weeks would
be a model call per email nobody has opened. `cache` skips both the check and
that warm-up; the server otherwise answers exactly as for `?prefetch=1`.

**How it stays current.** The real open still happens whenever the phone is
online: the reader paints the stored copy at once, then the open runs the
read-time check and marks it read (ADR 0180, ADR 0205) and its answer replaces
the stored copy. An `email.thread.updated` event patches the stored row (read
state, labels), or removes the thread when it was archived or trashed. A
thread the server no longer has (ADR 0224) is removed when an open says so. A
removal made from this device leaves the store once the mailbox confirmed it.
Each pass also compares the stored threads with the inbox list it just read:
a stored thread that should be on that list (newer than its last row, or the
list ended) and is not was archived, trashed, snoozed or deleted elsewhere,
and leaves. Anything older than 14 days is pruned on every pass.

**Always encrypted, no setting.** Every file in the store (the index and list
too, since they hold subjects and senders) is sealed with AES-256-GCM
(`@noble/ciphers`, pure JS) under a random key kept in the iOS Keychain /
Android Keystore through `expo-secure-store`, marked this-device-only and
available after first unlock. There is no plain mode and no switch: a file
that is not sealed is treated as missing, and a file that cannot be opened
(the key was lost, for instance after a restore to a new phone) is dropped and
downloaded again. No passcode or Face ID prompt is ever shown; the OS releases
the key to this app silently once the phone has been unlocked since restart.

In plain words: someone who can read the app's files (a jailbroken or rooted
phone, a forensic copy of the phone, a malicious app with root) gets sealed
files they cannot read without the key, which the OS gives only to this app on
this phone. It does not protect against someone holding the unlocked phone and
opening Chord: that person sees the mail, as in any mail app. A phone with no
passcode is past "first unlock" all the time, so there the protection is
mostly against files copied off the phone.

`expo-secure-store` is a native module, so it reaches phones only with the next
native build. It is loaded lazily, as ADR 0258 loads `expo-location`. **A build
without it keeps no mail at all**: the store needs the key, so such a phone
behaves exactly as before (the short AsyncStorage list, the in-memory
prefetch). Where the store is active, that plain AsyncStorage list is deleted,
so the phone holds no unencrypted copy of the inbox. Its config plugin is
listed in `app.json` (no Face ID text: no biometric prompt is used) so that
Android Auto Backup leaves the key out - a key restored onto another phone
could not be opened by that phone's Keystore. iOS and Android behave the same;
the Keychain item is this-device-only, so an iCloud restore does not carry it
either.

**Sign-out and account switch.** Sign-out deletes the whole store folder (every
user's) and the Keychain/Keystore key, so nothing of the account survives it;
`onSignOut` resets may now be asynchronous and are awaited. The store is a
folder per user, and opening it as one user deletes any other user's folder,
so an account switch that skips sign-out cannot show the previous account's
mail either.

**Web keeps today's behaviour.** The web app reloads fresh, has no keychain to
hold a key, and is often a shared or borrowed computer, where two weeks of
someone's mail left in IndexedDB is the copy ADR 0269 exists to prevent. Web
keeps the AsyncStorage list cache and the in-memory prefetch.

**What does not change.** The server (apart from the `cache` flag value), how
images and attachments load, the read-time check, mark-read, and how a thread
opens when it is not stored.

No bot tool: this is how one device stores what it has already been shown,
with nothing for anyone to choose (ADR 0282's reasoning for per-device
storage).

## Consequences

- Mail read in the last two weeks opens with no wait and with no signal.
- More bandwidth: a pass downloads up to 40 threads after a sync, once each
  until they change.
- The store exists only from the next native build on; until then phones
  behave as before.
- Sealing and opening in pure JS costs some CPU per email (AES-GCM over at
  most 1 MB); acceptable for a background pass and one open.
- Archiving or deleting mail in another app reaches the store at the next pass
  that reads the list, not instantly.
- The store fills only while the Email tab is in use; a phone that has not
  opened the Email tab since a sweep (ADR 0144) has nothing new stored.

## Rejected

- **AsyncStorage** for bodies: Android's 6 MB cap.
- **expo-sqlite**: a native module not in the shipped build, for a store keyed
  by thread id that a folder of files already serves.
- **`?prefetch=1` for background fetches**: a model call per stored email.
- **Encryption as a per-device switch, off by default** (this ADR's first
  version): two weeks of readable mail on most phones, since few people change
  a default. Owner reversed it the same day.
- **Plain storage on builds without the key store**: would leave readable mail
  on every phone that has not taken the next native build.
- **Storing images**: the proxy cache already covers re-opens, and images are
  most of the bytes.
- **IndexedDB on web**: see above.
- **The documents directory**: backed up to iCloud.
