# 0111 — A file is sent by id, not by bytes

**Status**: accepted
**Date**: 2026-08-25
**Relation**: Wave 2 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
completes the outbound half of [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md);
prerequisite for forward, which cannot ship honestly without it.

## Context

Compose and reply could send text and nothing else. That is a real gap on its
own — half of what a family emails is a photo of a form — but it also blocks
**forward**, because a forward that silently drops the attachment is the
failure ADR 0107 exists to prevent: a thing we did not do, reported as done.

The question is what crosses the wire. The obvious answer is the file: a
multipart upload to the send endpoint, bytes and message together.

## Decision

**The request carries Chord attachment ids. Never bytes.**

The file goes in through the attachment route that already exists, and the
send references it. A device pick uploads first and then attaches, so one wire
shape covers "send the itinerary you already have" and "send this photo I just
took" without the send endpoint learning to parse multipart.

The consequence is the argument for it: a file sent this way **stays**. It is
an ordinary Chord attachment — searchable, re-sendable, extracted like any
other — rather than a byte stream that existed for the length of one request.
A picked file lands in the user's **personal** group, which is where ADR 0071
already puts files that arrive *by* email, so mail in and mail out share a
shelf.

### An id is not permission

`getAttachment` looks up by id with no scope check at all. Resolving a
request-supplied id straight through it would let any user mail themselves any
file in the system by guessing an id — the whole of the attack. So every id
goes through `loadOutgoingAttachments`, which checks group membership (or
personal ownership) first, and which exists as one helper precisely because
there are three routes and four provider paths and any of them could forget.

Absent and forbidden return **the same sentence**. Telling them apart tells a
caller which ids are real, which is the reconnaissance half of the same attack.

### Size is refused, never truncated

Provider limits differ by an order of magnitude: Graph's inline
`fileAttachment` path tops out around 3MB while Gmail's raw upload takes tens.
The caps are therefore **per provider**, not one shared floor — "this file is
too big for that mailbox" is a true and useful sentence, and flattening every
mailbox down to the smallest would cripple Gmail to flatter Outlook.

Over the limit is a **400 before anything is sent**, with the message written
for the sender. Nothing goes out. That is the point: a message that leaves
without its attachment has failed in the one way the sender cannot see.

The same refusal covers a row whose blob is gone from disk. Sending a
zero-byte attachment because the file went missing is the same failure in
miniature.

### The MIME

With files, the payload becomes `multipart/mixed`: the existing body part
(alternative pair, or bare text) becomes the first part, and each file follows
as base64 with a `Content-Disposition`. Without files the output is byte-for-
byte what it was, because every existing send goes through this builder and
wrapping them all would change every message for no reason.

Two details are correctness rather than tidiness, and both have tests:

- **base64 wraps at 76 characters** (RFC 2045). Some servers reject a single
  enormous line outright.
- **CR and LF are stripped from filenames.** A filename carrying one would end
  the `Content-Disposition` line and let the rest be read as headers — header
  injection through a file picker. Quotes go for the same reason. Non-ASCII is
  transliterated rather than RFC-2231 encoded: a mangled name is cosmetic, and
  this runs on every send.

Outlook takes the same files as Graph `fileAttachment` entries and IMAP hands
the buffers to nodemailer, so all four provider paths carry them.

## Consequences

- Compose and reply can send files, on every provider.
- Forward is now buildable honestly, which is the next thing.
- A sent file is a kept file. That is a feature, and also a storage cost
  nobody has opted into — worth revisiting if personal groups start filling
  with one-shot outbound photos.
- The `attachments` array on the MIME input is optional everywhere, so the
  ADR 0104 iTIP reply and every internal caller are untouched.

## Alternatives rejected

**Multipart upload straight to the send endpoint.** The direct route, and it
makes the file disappear after the send. It also puts multipart parsing on an
endpoint whose job is a message, and needs its own size handling separate from
the one the attachment route already has.

**One shared size cap.** Simpler, and wrong in the direction that hurts: it
would refuse on Gmail a file Gmail would have taken, to keep a single number
true for Outlook.

**Dropping oversize files and sending anyway**, with a warning. The ADR 0107
failure exactly. A warning after the fact does not un-send a message that went
out incomplete.

**Uploading picked files into the thread's group.** Mail is personal (ADR
0084's whole scope argument), and a shared group is not where a private
attachment should land just because it was mailed from one.
