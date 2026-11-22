# 0331 — An event opens to read, with its links live

**Status**: accepted
**Date**: 2026-11-10

## Context

Tapping a calendar event went straight to the edit form (ADR 0072). The
description sat at the bottom of that form as plain text, so a Google event's
description read as raw HTML (`<b>`, `<br>`, `<a href=…>`), and nothing in it
could be tapped: not the Google Meet or Teams link, not a document link, not
the address. The Meet link Google keeps on the event itself (`hangoutLink`)
and the Teams join link Graph keeps (`onlineMeeting.joinUrl`) were read by
the server (ADR 0323) but never sent to the app. The location was a plain
line of text.

## Decision

- **A tap opens a read view; Edit opens the form.** The read view shows the
  title, the time, the calendar and trip lines, then the event's content.
  Edit switches the same popup to the form it always had. The form no longer
  shows the description and "why" lines (read-only text, now shown properly
  in the read view).
- **Join buttons.** `eventJoinLinks` (`kernel/src/event-detail.ts`) collects
  the calendar's own join link first (`EventGuestsResponse.videoCallLink`,
  read on the existing `GET /events/:id/guests` from the provider event the
  guests are already read from), then any Google Meet, Teams, Zoom or Webex
  link in the location or description, one per provider. Each is a small
  pill sized to its label. An ordinary Google or Microsoft page is not taken
  for a call: the URL must have the meeting path.
- **The place is a map link.** `eventPlaceLink`: a URL location opens as
  itself; anything else is a Google Maps search URL, the same on iPhone,
  Android and web (it opens the Maps app where installed). A location that
  only names a call ("Microsoft Teams Meeting", "Zoom") gets no map link.
- **The description is drawn as text, never as HTML.**
  `eventDescriptionBlocks` turns Google's HTML (bold, line breaks, lists,
  links) or plain text into paragraphs and bullets of styled runs; bare URLs
  and email addresses in text become links. Style, script, head and comments
  are dropped with their content. Only `http(s)`, `mailto` and `tel` links
  are kept; any other link keeps its text and loses the link. It renders
  with ordinary `Text`, so a description cannot run anything, load an image
  or style the screen.
- **The guests box moves into the read view** (out of the form), above the
  description: guests with their answers, the viewer's own Yes / Maybe / No
  when invited (ADR 0328), adding and removing guests, Add Google Meet /
  Teams, and Reply all. Answering an invitation must not need an Edit tap.
  An event that already has a call shows its link instead of an "Add"
  button.

No bot tool: the view changes nothing.

## Consequences

- An Outlook event whose body is HTML is still stored as Graph's short
  `bodyPreview` (`plainBody` in `outlook-calendar/map.ts`), so its full text,
  and any link past the preview, does not reach the view. The Teams join
  button does not depend on it (it comes from `onlineMeeting.joinUrl`).
  Storing a text rendering of the HTML body would also change what a later
  push writes back, so it is its own change.
- The join link is read from the provider when the view opens, the same read
  the guest list already made; an event only in Chord shows links found in
  its own text.

## Rejected

- **Rendering the description as HTML** (the email reader's frame): a heavy
  surface inside a popup, and calendar descriptions need links and lists, not
  layout.
- **Opening Apple Maps on iPhone and Google Maps elsewhere**: one link that
  works everywhere avoids an iPhone-only branch.
- **Keeping the form as the first screen** with links added to it: the form's
  fields are inputs, so nothing in them can be a link.
- **A full-width Join button**: tried, too heavy for one line of action.

## Addendum 2026-11-19

An Outlook copy of a Google Meet invite showed its location as a Maps link
("Google Meet (instructions in description); https://meet...") and its
description as Proofpoint-wrapped links in angle brackets, cut off at
"https://cale". Now:

- A location that is only a call (a join link plus the words around it) shows
  no place; the Join button covers it. A place beside a join link keeps the
  place.
- Proofpoint URL Defense (v2, v3) and Microsoft Safe Links are unwrapped to the
  real address (`unwrapSafeLink`), and a link whose text is its address reads
  short (`meet.google.com/abc-defg-hij`). `<url>` brackets go.
- A description paragraph that only repeats the title is left out; more than
  six paragraphs fold behind Show more.
- "Add Google Meet / Teams meeting" is not offered when the event already has
  a call to join.
- **Outlook bodies are read in full**: a delta event that arrives with only its
  `bodyPreview` (cut at about 222-255 characters) of 200+ characters gets its
  body read with `GET /me/events/{id}?$select=body`, 4 at a time, at most 50 a
  listing (`needsFullBody`, `fillCutOffBodies`); an HTML body is read as
  visible text (`visibleHtmlText`). Not yet checked against a live mailbox.
