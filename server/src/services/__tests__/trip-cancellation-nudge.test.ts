/**
 * ADR 0169 — a partial cancellation (hotel cancelled, flights still booked,
 * or the reverse) enqueues a proactive nudge so the gap doesn't sit
 * unnoticed until someone opens the Trips tab. The renderer is deterministic
 * (no DB read, no LLM call — everything it needs was already known when
 * `applyCancellation` ran), and the kind must NOT read as the scheduled
 * briefing (ADR 0137) or it inherits that incident's WhatsApp/quiet-hours bug.
 */
import { describe, expect, it } from 'vitest';

import { isScheduledBriefing } from '@/db/schema.js';
import { __testing, type TripCancellationPayload } from '@/services/proactive.service.js';

const { renderTripCancellationNudge } = __testing;

describe('renderTripCancellationNudge (ADR 0169)', () => {
  it('names both what was cancelled and what remains, ending with an open question', () => {
    const payload: TripCancellationPayload = {
      tripId: 'tr_1',
      tripName: 'Vail',
      destination: 'Vail',
      cancelledItems: ['Residence Inn by Marriott Vail (2027-02-11–2027-02-15)'],
      remainingItems: [
        'UA123 JFK→DEN (2027-02-11)',
        'UA456 DEN→JFK (2027-02-15)',
      ],
    };
    const body = renderTripCancellationNudge(JSON.stringify(payload));
    expect(body).toContain('Residence Inn by Marriott Vail (2027-02-11–2027-02-15)');
    expect(body).toContain('cancelled');
    expect(body).toContain('UA123 JFK→DEN (2027-02-11)');
    expect(body).toContain('UA456 DEN→JFK (2027-02-15)');
    expect(body).toMatch(/\?$/); // ends by handing the decision to the user
    // Never invents a recommendation — it asks, per the owner's framing
    // ("user can act as they want"), not "I dropped the flights for you."
    expect(body).not.toMatch(/I('ve| have)? (dropped|removed|cancelled|rebooked)/i);
  });

  it('a full cancellation (nothing remains) states that plainly, with no dangling question', () => {
    const payload: TripCancellationPayload = {
      tripId: 'tr_1',
      tripName: 'Vail',
      destination: 'Vail',
      cancelledItems: ['Residence Inn by Marriott Vail (2027-02-11–2027-02-15)'],
      remainingItems: [],
    };
    const body = renderTripCancellationNudge(JSON.stringify(payload));
    expect(body).toContain('cancelled');
    expect(body).toContain('Vail');
    expect(body).not.toMatch(/Want me to update anything\?/);
  });

  it('malformed payload fails closed to null rather than throwing', () => {
    expect(renderTripCancellationNudge('not json')).toBeNull();
  });

  it('is not treated as the scheduled briefing — WhatsApp-window-gated, not quiet-hours-exempt', () => {
    // The exact bug class ADR 0137 fixed: a proactive kind nobody asked for
    // at a specific moment must not ride the briefing's exemptions.
    expect(isScheduledBriefing('trip_cancellation')).toBe(false);
  });
});
