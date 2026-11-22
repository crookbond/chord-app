/**
 * The calendar's event view (kernel/src/event-detail.ts, ADR 0331): a
 * description drawn as formatted text with its links, the calls it can be
 * joined on, and a map link for the place.
 */
import { describe, expect, it } from 'vitest';

import {
  eventDescriptionBlocks,
  eventJoinLinks,
  eventPlaceLink,
  joinProviderOf,
  unwrapSafeLink,
} from '@chord/kernel';

const text = (blocks: ReturnType<typeof eventDescriptionBlocks>) =>
  blocks.map((b) => (b.kind === 'li' ? '- ' : '') + b.runs.map((r) => r.text).join('')).join('\n');
const links = (blocks: ReturnType<typeof eventDescriptionBlocks>) =>
  blocks.flatMap((b) => b.runs.filter((r) => r.href).map((r) => [r.text, r.href]));

describe('eventDescriptionBlocks', () => {
  it('draws Google Calendar HTML as text with its links, not as tags', () => {
    const html =
      'Agenda for <b>Q4 review</b>:<br><ul><li>Budget</li><li>Hiring &amp; plans</li></ul>' +
      'Doc: <a href="https://docs.google.com/document/d/abc">the deck</a><br>Call me at 555-0100';
    const blocks = eventDescriptionBlocks(html);
    expect(text(blocks)).toBe('Agenda for Q4 review:\n- Budget\n- Hiring & plans\nDoc: the deck\nCall me at 555-0100');
    expect(links(blocks)).toEqual([['the deck', 'https://docs.google.com/document/d/abc']]);
    expect(blocks[0]!.runs.find((r) => r.text === 'Q4 review')?.bold).toBe(true);
    expect(text(blocks)).not.toMatch(/</);
  });

  it('reads a pasted Teams invite: styles and comments dropped, join link kept', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body><!-- x -->' +
      '<div>________________</div><div><span style="font-size:24px">Microsoft Teams meeting</span></div>' +
      '<div><a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x" ' +
      'target="_blank">Click here to join the meeting</a></div><div>Meeting ID: 123 456</div></body></html>';
    const blocks = eventDescriptionBlocks(html);
    expect(text(blocks)).not.toContain('color:red');
    expect(text(blocks)).toContain('Microsoft Teams meeting');
    expect(links(blocks)[0]![0]).toBe('Click here to join the meeting');
  });

  it('turns bare URLs and addresses in plain text into links, without trailing punctuation', () => {
    const blocks = eventDescriptionBlocks(
      'From chat: "dinner at https://maps.app.goo.gl/xyz." — ask kevin@example.com\n\n- bring wine',
    );
    expect(links(blocks)).toEqual([
      ['maps.app.goo.gl/xyz', 'https://maps.app.goo.gl/xyz'],
      ['kevin@example.com', 'mailto:kevin@example.com'],
    ]);
    expect(blocks.at(-1)).toEqual({ kind: 'li', runs: [{ text: 'bring wine' }] });
  });

  it('keeps the text of an unsafe link but not the link', () => {
    const blocks = eventDescriptionBlocks('<a href="javascript:alert(1)">click</a> <a href="data:text/html,x">y</a>');
    expect(text(blocks)).toBe('click y');
    expect(links(blocks)).toEqual([]);
  });

  it('is empty for no description', () => {
    expect(eventDescriptionBlocks(null)).toEqual([]);
    expect(eventDescriptionBlocks('   ')).toEqual([]);
  });
});

describe('eventJoinLinks', () => {
  it("puts the calendar's own Meet link first and does not repeat it from the description", () => {
    const meet = 'https://meet.google.com/abc-defg-hij';
    expect(eventJoinLinks({ videoCallLink: meet, description: `Join: ${meet}` })).toEqual([
      { provider: 'google_meet', label: 'Join Google Meet', url: meet },
    ]);
  });

  it('finds Teams and Zoom links in a description, once each', () => {
    const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc';
    const r = eventJoinLinks({
      description: `<a href="${teams}">Join</a> or ${teams} or https://us02web.zoom.us/j/8812345678?pwd=x`,
    });
    expect(r.map((j) => j.provider)).toEqual(['teams', 'zoom']);
  });

  it('reads a join link given as the location', () => {
    expect(eventJoinLinks({ location: 'https://zoom.us/j/123' })[0]?.provider).toBe('zoom');
  });

  it('does not take an ordinary Google or Microsoft page for a call', () => {
    expect(joinProviderOf('https://meet.google.com/')).toBeNull();
    expect(joinProviderOf('https://teams.microsoft.com/v2/')).toBeNull();
    expect(eventJoinLinks({ description: 'https://docs.google.com/x' })).toEqual([]);
  });
});

describe('eventPlaceLink', () => {
  it('searches Maps for an address', () => {
    expect(eventPlaceLink('Nobu, 195 Broadway, New York')).toEqual({
      url: 'https://www.google.com/maps/search/?api=1&query=Nobu%2C%20195%20Broadway%2C%20New%20York',
      isMap: true,
      label: 'Nobu, 195 Broadway, New York',
    });
  });

  it('opens a URL location as itself, and gives a call name or join link no map', () => {
    expect(eventPlaceLink('https://example.com/venue')).toEqual({
      url: 'https://example.com/venue',
      isMap: false,
      label: 'example.com/venue',
    });
    expect(eventPlaceLink('https://zoom.us/j/1')).toBeNull();
    expect(eventPlaceLink('Microsoft Teams Meeting')).toBeNull();
    expect(eventPlaceLink('')).toBeNull();
  });
});

// Prod 2026-11-19: an Outlook copy of a Google Meet invite, "Follow up: Neural
// Ads/ Post Oak Group". Its location was drawn as a Maps link and its
// description as Proofpoint-wrapped URLs in angle brackets.
describe('an Outlook copy of a Google Meet invite', () => {
  const title = 'Follow up: Neural Ads/ Post Oak Group';
  const location = 'Google Meet (instructions in description); https://meet.google.com/eex-vixv-cmh';
  const wrapped =
    'https://urldefense.proofpoint.com/v2/url?u=https-3A__meet.google.com_eex-2Dvivx-2Dcmh-3Fhs-3D224' +
    '&d=DwMFaQ&c=euGZstcaTDllvimEN8b7jXrwqOf-v5A_CdpgnVfiiMM&e=';
  const description = `${title}\n\nThis event has been updated\n\nChanged: time\n\n<${wrapped}>\n\nJoin with Google Meet`;

  it('shows no place: the location is only the call', () => {
    expect(eventPlaceLink(location)).toBeNull();
    expect(eventPlaceLink('Room 4B; https://meet.google.com/eex-vixv-cmh')?.label).toBe('Room 4B');
  });

  it('unwraps Proofpoint and Safe Links to the real address', () => {
    expect(unwrapSafeLink(wrapped)).toBe('https://meet.google.com/eex-vivx-cmh?hs=224');
    expect(unwrapSafeLink('https://urldefense.com/v3/__https://zoom.us/j/9__;!!abc$')).toBe('https://zoom.us/j/9');
    expect(
      unwrapSafeLink(
        'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fa&data=x',
      ),
    ).toBe('https://example.com/a');
    expect(unwrapSafeLink('https://example.com/x')).toBe('https://example.com/x');
  });

  it('draws the description without the title echo, brackets or the wrapper', () => {
    const blocks = eventDescriptionBlocks(description, { title });
    expect(text(blocks)).toBe(
      'This event has been updated\nChanged: time\nmeet.google.com/eex-vivx-cmh\nJoin with Google Meet',
    );
    expect(links(blocks)).toEqual([
      ['meet.google.com/eex-vivx-cmh', 'https://meet.google.com/eex-vivx-cmh?hs=224'],
    ]);
  });

  it('finds the Meet link through the wrapper for the Join button', () => {
    expect(eventJoinLinks({ location, description }).map((j) => j.provider)).toEqual(['google_meet']);
  });
});
