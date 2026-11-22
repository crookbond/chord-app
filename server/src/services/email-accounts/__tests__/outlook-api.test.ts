/**
 * A reply that names its recipients AND carries a file sent the recipients
 * only: the recipients block replaced `payload.message` instead of adding to
 * it, so `attachments` never reached Graph. The app always names recipients,
 * so every Outlook reply with a file went out without it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { realOutlookApi } from '../outlook-api.js';

describe('Outlook meeting messages (prod 2026-11-10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The user's "Accepted: John Doe: Introductory Meeting" reply in Sent.
  // Graph types it eventMessageResponse; the probe read only eventMessage, so
  // it reached the model, which staged "Introductory Meeting with Mark
  // Clark" and invited Mark when confirmed.
  it('reads an accept reply (eventMessageResponse) as a meeting message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ '@odata.type': '#microsoft.graph.eventMessageResponse', id: 'm1' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          meetingMessageType: 'meetingAccepted',
          event: { iCalUId: 'uid-mark', subject: 'Introductory Meeting' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const info = await realOutlookApi('tok').getMeetingInfo('m1');
    expect(info?.meetingMessageType).toBe('meetingAccepted');
  });

  it('reads an invitation (eventMessageRequest) as a meeting message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ '@odata.type': '#microsoft.graph.eventMessageRequest' }))
      .mockResolvedValueOnce(Response.json({ meetingMessageType: 'meetingRequest', event: null }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await realOutlookApi('tok').getMeetingInfo('m2'))?.meetingMessageType).toBe('meetingRequest');
  });

  // Prod 2026-11-16/17: every Outlook invite probe failed with
  // `graph meeting info 400: Could not find a property named 'event' on type
  // 'microsoft.graph.message'`, so the thread was deferred forever and no
  // RSVP card was made. `event` belongs to the derived eventMessage type, so
  // on /me/messages it must be expanded through the type cast.
  it('expands the event through the eventMessage type cast', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ '@odata.type': '#microsoft.graph.eventMessageRequest', id: 'm4' }))
      .mockResolvedValueOnce(Response.json({ meetingMessageType: 'meetingRequest', event: null }));
    vi.stubGlobal('fetch', fetchMock);

    await realOutlookApi('tok').getMeetingInfo('m4');
    const url = new URL((fetchMock.mock.calls[1] as unknown as [string])[0]);
    expect(url.searchParams.get('$expand')).toBe(
      'microsoft.graph.eventMessage/event($select=iCalUId,subject,start,end,location,isAllDay,organizer)',
    );
    expect(url.searchParams.get('$select')).toBeNull();
  });

  it('leaves ordinary mail alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ '@odata.type': '#microsoft.graph.message' })));
    expect(await realOutlookApi('tok').getMeetingInfo('m3')).toBeNull();
  });
});

describe('Outlook reply payload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the attachments when recipients are named', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await realOutlookApi('tok').reply(
      'msg-1',
      '<p>See attached</p>',
      { to: ['help@example.com'], cc: ['spouse@example.com'] },
      [{ filename: 'slip.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf') }],
    );

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body)) as {
      message: { toRecipients: unknown[]; ccRecipients: unknown[]; attachments?: { name: string }[] };
    };
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'help@example.com' } }]);
    expect(body.message.ccRecipients).toHaveLength(1);
    expect(body.message.attachments?.map((a) => a.name)).toEqual(['slip.pdf']);
  });
});
