# 0140 — A deferral outlives the provider it was for

**Status**: accepted
**Date**: 2026-08-27
**Relation**: the same audit [0139](./0139-a-link-is-a-button-only-when-it-is-the-only-one.md)
came out of, swept properly; lifts constraints [0053](./0053-whatsapp-twilio-connector.md)
took on and [0090](./0090-whatsapp-cloud-api-direct.md) silently kept; applies
[0107](./0107-chord-reads-and-answers-gmail-manages.md)'s rule about reporting
what we did not do, and [0111](./0111-a-file-is-sent-by-id-not-by-bytes.md)'s
refuse-never-truncate.

## Context

ADR 0139 fixed one stale Twilio-era comment. The obvious next question is
whether there are others, and there were three — all of them deferrals taken
for Twilio's reasons, carried onto the Meta connector, and left there after
ADR 0090 made the reason obsolete.

The pattern is worth naming, because it is not the same as a bug. Each was
written down honestly at the time. What rots is the *reason*: a deferral cites
a constraint, the constraint goes away, and nothing links the two. The cloud
connector's own comment says it outright — media is deferred *"matching the
Twilio connector's current scope"* — which is a reason about a sibling, not
about Meta.

## Decision

### A file is really sent, and when it cannot be, we say so

`send_file` (ADR 0036) posts a `kind: 'file'` message whose body is
`note || filename`. That message reaches WhatsApp bindings — `forward()` has no
`kind` filter — where both connectors logged a warning and sent the body. So
asking for the school calendar over WhatsApp returned the literal string
`LakesideCalendar2026.pdf` and no file, with ADR 0036 correctly forbidding the
bot from inventing a URL to make up for it. A thing we did not do, presented as
done: ADR 0107's failure on the outbound path, and invisible to the sender.

Meta takes the **bytes** (`POST /<phone-number-id>/media` → media id → send by
id). Twilio pulls from a **public URL**, which is the whole reason 0053
deferred: sending a family document would have meant hosting it
unauthenticated. That was a real objection to Twilio and never applied to Meta.

So media send is built on the cloud connector, and **Twilio's deferral stands —
but its silence does not**. Both now fall back to one sentence naming the file
and pointing at Chord (`file-fallback.ts`, one rule with two callers for
ADR 0122's reason: the transports fail for unrelated causes but what the
recipient deserves to hear is identical, and two copies stop being identical).

Size is **refused, never truncated**, and the caps are **per kind** because
Meta's are (image 5MB, video/audio 16MB, document 100MB) — ADR 0111's rule and
its reasoning about per-provider limits both apply unchanged. The check runs
before the upload, so an oversize file costs no round trip.

The kind is not cosmetic: only `document` accepts a `filename` and `audio`
accepts no `caption`, and Meta rejects a payload carrying a field its type does
not take. A caption identical to the filename is dropped, since that is what
`send_file` posts when the bot gave no note and a document already shows its
own name.

### Inbound media is a message, not a drop

Twilio logged *"inbound media not yet supported — dropping"*; the cloud
connector had no media handling at all, so a photo fell into its
unsupported-type branch. A parent photographing a permission slip into WhatsApp
got nothing, while the identical photo in-app feeds the whole ADR 0071
extraction pipeline.

Retrieval is two hops — the media node returns a short-lived URL, and that URL
still needs the bearer token. Both must succeed, so a download failure **keeps
the caption and omits the attachment** rather than claiming a file arrived.
`voice` is deliberately absent from the media-type set: a voice note is `audio`
with `voice: true`, so listing it would match nothing. WhatsApp gives a photo no
filename, so one is derived from the mime type — otherwise the stored file is
opaque to every reader downstream.

### The length cap belongs to the transport

`WHATSAPP_LIMIT = 1600` is **Twilio's** cap (it rejects with 21617 rather than
truncating). WhatsApp's own is **4096**. The constant lived in the shared
renderer, so Meta sends were clipped at Twilio's number — and ADR 0091 worked
around the symptom, noting a full briefing "exceeds WhatsApp's 1600 cap", which
is where the wrong number had already become folklore.

`RenderInput.textLimit` lets the connector state its own. The default stays
**1600**, which is the fail-safe direction: a caller that forgets clips early
(degraded but sent), where defaulting to 4096 would hand Twilio a body it
refuses outright (no send at all). `INTERACTIVE_BODY_MAX = 1024` is real on Meta
and is untouched.

## Consequences

- Briefings to WhatsApp carry ~2.5× more before clipping; `moreUrl` (ADR 0091)
  still catches the rest.
- `toInbound` became async, so `parseInboundBatch` awaits per message. Batched
  notifications are already handled one at a time (ADR 0090), so ordering is
  unchanged.
- **Untested against the live API**, like ADR 0118 and unlike 0139: the payload
  shapes are pinned against Meta's documented fields, but no real photo has made
  the round trip. The failure paths are the ones with tests, which is the right
  way round — they are what runs when a shape is wrong.
- Media messages are service messages, so the **1 Oct 2026** billing change
  (ADR 0139) covers them too.

## Alternatives rejected

- **Leave Twilio's file behaviour alone** because it is now the local-dev path.
  The dishonesty is the defect, not the missing capability, and it costs one
  sentence to fix.
- **Send media on Twilio by hosting the file at a signed public URL.** Puts
  family documents on an unauthenticated URL to serve a provider we no longer
  send production traffic through.
- **Fall back to text on an oversize file**, silently. That is the behaviour
  being removed, with a size check in front of it.
- **One shared media cap.** ADR 0116's named trap: it would refuse on Meta a
  document Meta would take, to keep one number true for a provider that cannot
  send documents at all.
- **Read `WHATSAPP_PROVIDER` inside the renderer.** Couples a pure function to
  env and makes every renderer test stub it; the connector already knows.
- **Raise the default cap to 4096 and let Twilio pass its own.** Same
  information, failure inverted — a forgotten call site becomes a rejected send
  instead of an early clip.
