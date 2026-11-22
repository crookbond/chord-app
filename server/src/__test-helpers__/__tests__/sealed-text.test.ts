import { describe, expect, it } from 'vitest';

import { withoutSealedPayloads } from '../sealed-text.js';

// The stored thread facts from CI run 40030583099: fully sealed, yet "IAD"
// occurs inside the read_advisory_json ciphertext ("…wh41IADs20…").
const CI_SEALED =
  '"enc1.u_hboDAIpMEd-2.email_threads:delivery_json~json.wCYp5TeaY2PT-Qfw9pe7HIOl8mguqpvZCXzxaZ8lGJ9SZS8-Cu-uyZVTf6PukzUmcBKhK7yfGvqz5NXOJZj069jqzvQnDfONrF13NIeBDKa5qEDW6wp4yLmeWILTI_5oUa3clERXVGY"' +
  '"enc1.u_hboDAIpMEd-2.email_threads:flight_json~json.QnLyU6p8tCR4RO7RhE6YSsL_3kGsM2CCZ7aIalBCbiwVYLdaw1fWNtT1vPAJV6b6Ie9K-MZXnMgTZF1Al9vUQpp6wSPRmw8aS2o6xYLIdXaaadMagMhxSF3LKw"' +
  '"enc1.u_hboDAIpMEd-2.email_threads:receipt_json~json.2O4O57tkN7b63s2AcvgE_MKURIE8CF4VYTVOCAWlF8mehtx_LMXVy0dIlV_KcFAr6jJ1vYnDt5J5K7mQLviCZTn4JZLF8YTuJABwcUCN"' +
  '"enc1.u_hboDAIpMEd-2.email_threads:read_advisory_json~json.hg0LX_d349At_QA5xSF1B-omyDuxX1AgWO04kx8lQkzcKQv2T50AqLl5kdQ-6ReJHTIDbH-wh41IADs20JG73HWC85o0Dbi1Lgit-0VvMQ"';

describe('withoutSealedPayloads', () => {
  it('does not report a needle that only occurs inside random ciphertext', () => {
    expect(CI_SEALED).toContain('IAD');
    expect(withoutSealedPayloads(CI_SEALED)).not.toContain('IAD');
  });

  it('keeps the column label of each envelope', () => {
    expect(withoutSealedPayloads(CI_SEALED)).toBe(
      '"enc1.email_threads:delivery_json~json.…""enc1.email_threads:flight_json~json.…"' +
        '"enc1.email_threads:receipt_json~json.…""enc1.email_threads:read_advisory_json~json.…"',
    );
  });

  it('still shows plaintext that sits outside an envelope', () => {
    const leaked = '{"origin":"IAD"} "enc1.u_a.email_threads:flight_json~json.QnLyU6p8"';
    expect(withoutSealedPayloads(leaked)).toContain('IAD');
    expect(withoutSealedPayloads('{"iata":"UA"}')).toBe('{"iata":"UA"}');
  });
});
