/**
 * Sender checks (ADR 0294): a display name that claims a company must come
 * from that company's domain; look-alike spellings and failed authentication
 * are called out; a person who happens to be named Chase is not a bank.
 */
import { describe, expect, it } from 'vitest';
import {
  BRANDS,
  isFreemail,
  checkSender,
  decodePunycode,
  hostToUnicode,
  latinSkeleton,
  claimedBrandOf,
  linkHostsFromHtml,
  parseAuthenticationResults,
  registrableDomain,
  replyToWarning,
  type SenderCheckInput,
} from '@chord/kernel';

const base = (over: Partial<SenderCheckInput>): SenderCheckInput => ({
  fromName: null,
  fromEmail: null,
  toEmails: ['me@example.com'],
  ccEmails: [],
  ownAddresses: ['me@example.com'],
  history: { received: 4, wrote: 0, inPeople: false },
  ...over,
});
const codes = (c: ReturnType<typeof checkSender>) => c.signals.map((s) => s.code);

describe('brand claims', () => {
  it('flags Robinhood mail sent from a domain that is not Robinhood', () => {
    const c = checkSender(base({ fromName: 'Robinhood', fromEmail: 'support@rh-account-notice.com' }));
    expect(c.level).toBe('danger');
    expect(c.claimedBrand).toBe('Robinhood');
    expect(codes(c)).toContain('brand_mismatch');
    expect(c.signals[0]!.message).toContain('robinhood.com');
  });

  // Prod 2026-10-28: "Robinhood Email Alerts" <gv@usdigitize.com> with a
  // Cyrillic о in the name. Matched letter for letter it claimed no brand, so
  // only the mixed-alphabet caution fired and the email got a to-do card.
  it('reads look-alike letters in the name before matching a brand', () => {
    const c = checkSender(base({ fromName: 'Rоbinhood Email Alerts', fromEmail: 'gv@usdigitize.com' }));
    expect(c.claimedBrand).toBe('Robinhood');
    expect(codes(c)).toContain('brand_mismatch');
    expect(codes(c)).toContain('mixed_script_name');
    expect(c.level).toBe('danger');
  });

  // Prod 2026-10-29: "C<VS>o<VS>i<VS>n<VS>b<VS>a<VS><VS><VS>se Email Support"
  // <kz@bjhengye.net>, with U+E0139 (an invisible variation selector) between
  // the letters. The name read as single letters, claimed no brand, and the
  // email's "call support at +1 888 814 6053" became a to-do card.
  const vs = '\u{E0139}';
  const prodCoinbaseName = `C${vs}o${vs}i${vs}n${vs}b${vs}a${vs}${vs}${vs}se Email Support`;
  it('reads a brand name split by invisible characters', () => {
    const c = checkSender(
      base({
        fromName: prodCoinbaseName,
        fromEmail: 'kz@bjhengye.net',
        auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: 'bjhengye.net', dkimDomain: 'bjhengye.net' },
        toEmails: ['you'],
        history: { received: 0, wrote: 0, inPeople: false },
      }),
    );
    expect(c.claimedBrand).toBe('Coinbase');
    expect(codes(c)).toContain('brand_mismatch');
    expect(codes(c)).toContain('hidden_characters');
    expect(c.level).toBe('danger');
  });

  it.each([
    ['between letters of a name that claims no brand', `A${vs}ccount S${'​'}ecurity`],
    ['at the end of a name', `Account Security${'​'}`],
    ['a soft hyphen', `Acc${'­'}ount Security`],
    ['a joiner between letters', `می${'‌'}خواهم`],
    ['a tag character', 'Support\u{E0041}'],
    ['a selector after a letter', `Support${'️'}`],
  ])('treats any invisible character as hidden: %s', (_label, fromName) => {
    const c = checkSender(base({ fromName, fromEmail: 'notice@acct-help.net' }));
    expect(codes(c)).toContain('hidden_characters');
    expect(c.level).toBe('danger');
  });

  it('does not flag the selector and joiner that write an emoji', () => {
    expect(codes(checkSender(base({ fromName: 'Bakery ❤️', fromEmail: 'hi@bakery.example' })))).not.toContain('hidden_characters');
    expect(codes(checkSender(base({ fromName: 'The Smiths 👨‍👩‍👧', fromEmail: 'hi@smith.example' })))).not.toContain('hidden_characters');
  });

  it.each([
    ['Coin base Support'],
    ['C o i n b a s e'],
    ['Coinbase.com'],
    ['CoinbaseSupport'],
    ['Coinbase-Support'],
    ['C0inbase Support'],
  ])('reads %s as Coinbase', (fromName) => {
    expect(claimedBrandOf(fromName, 'x@phish.example')?.name).toBe('Coinbase');
  });

  it('does not read a brand out of a longer ordinary word', () => {
    expect(claimedBrandOf('Venmore Realty', 'x@venmore.example')).toBeNull();
    expect(claimedBrandOf('Gazelle Sports', 'x@gazelle.example')).toBeNull();
    expect(claimedBrandOf('Coin Collectors Base Camp', 'x@cc.example')).toBeNull();
  });

  it('still accepts the real brand when its name is written plainly', () => {
    const c = checkSender(base({ fromName: 'Robinhood', fromEmail: 'notifications@robinhood.com' }));
    expect(codes(c)).not.toContain('brand_mismatch');
  });

  it('accepts Robinhood mail from a robinhood.com subdomain', () => {
    const c = checkSender(
      base({
        fromName: 'Robinhood',
        fromEmail: 'notifications@info.robinhood.com',
        auth: parseAuthenticationResults('mx.google.com; dkim=pass header.i=@robinhood.com; spf=pass; dmarc=pass (p=REJECT) header.from=info.robinhood.com'),
      }),
    );
    expect(c.level).toBe('none');
    expect(c.verifiedDomain).toBe(true);
  });

  it('flags a company name on a personal gmail address', () => {
    const c = checkSender(base({ fromName: 'PayPal Service', fromEmail: 'paypal.service.team88@gmail.com' }));
    expect(c.level).toBe('danger');
    expect(c.signals[0]!.message).toContain('personal gmail.com address');
  });

  it('does not treat a person named Chase as the bank', () => {
    expect(claimedBrandOf('Chase Miller', 'chase.miller@gmail.com')).toBeNull();
    expect(checkSender(base({ fromName: 'Chase Miller', fromEmail: 'chase.miller@gmail.com' })).level).toBe('none');
  });

  it('treats "Chase Alerts" as the bank', () => {
    const c = checkSender(base({ fromName: 'Chase Alerts', fromEmail: 'no-reply@chase-alerts-secure.net' }));
    expect(c.claimedBrand).toBe('Chase');
    expect(c.level).toBe('danger');
  });

  it('does not read ordinary words as a brand', () => {
    expect(claimedBrandOf('Apple Orchard Farm', 'hello@appleorchard.farm')).toBeNull();
    expect(claimedBrandOf('Target Practice Club', 'club@tpc.org')).toBeNull();
  });

  it('accepts a country domain for brands that use them', () => {
    expect(checkSender(base({ fromName: 'Amazon.de', fromEmail: 'versandbestaetigung@amazon.de' })).level).toBe('none');
  });

  it('reads the brand from the address when there is no display name', () => {
    const c = checkSender(base({ fromName: null, fromEmail: 'robinhood.security@mailer-xyz.com' }));
    expect(c.claimedBrand).toBe('Robinhood');
    expect(c.level).toBe('danger');
  });
});

describe('look-alike domains', () => {
  it('catches digit-for-letter spellings', () => {
    const c = checkSender(base({ fromName: 'Billing', fromEmail: 'billing@paypa1.com' }));
    expect(codes(c)).toContain('lookalike_domain');
    expect(c.level).toBe('danger');
  });

  it('catches rn-for-m', () => {
    expect(codes(checkSender(base({ fromEmail: 'account@rnicrosoft.com' })))).toContain('lookalike_domain');
  });

  it('catches a one-letter typo of a long name', () => {
    expect(checkSender(base({ fromEmail: 'help@robinhod.com' })).level).toBe('danger');
  });

  it('marks the brand inside a longer name as caution only', () => {
    const c = checkSender(base({ fromName: 'Security Team', fromEmail: 'alerts@robinhood-secure.com' }));
    expect(c.level).toBe('caution');
  });

  it('leaves unrelated domains alone', () => {
    expect(checkSender(base({ fromName: 'Lincoln Elementary', fromEmail: 'office@lincoln-elem.org' })).level).toBe('none');
  });

  it('decodes punycode to what the reader sees', () => {
    expect(decodePunycode('pple-43d')).toBe('аpple');
    expect(hostToUnicode('mail.xn--pple-43d.com')).toBe('mail.аpple.com');
    expect(decodePunycode('mnchen-3ya')).toBe('münchen');
  });

  it('catches a Cyrillic letter imitating a Latin one', () => {
    const c = checkSender(base({ fromName: 'Billing', fromEmail: 'id@xn--pple-43d.com' }));
    expect(codes(c)).toEqual(['lookalike_domain']);
    expect(c.level).toBe('danger');
    expect(c.signals[0]!.message).toContain('letters from another alphabet to look like apple.com');
  });

  it('catches a capital I standing in for an l', () => {
    // Domains are case-insensitive, so paypaI.com arrives as paypai.com.
    expect(checkSender(base({ fromEmail: 'service@paypaI.com' })).level).toBe('danger');
  });

  it('catches full-width letters', () => {
    expect(latinSkeleton('ｐａｙｐａｌ')).toBe('paypal');
  });

  it('notes an international domain that imitates nothing, as caution only', () => {
    const c = checkSender(base({ fromEmail: 'info@xn--mnchen-3ya.de' }));
    expect(codes(c)).toEqual(['punycode_domain']);
    expect(c.signals[0]!.message).toContain('münchen.de');
  });

  it('catches a look-alike of a domain the user writes to', () => {
    const known = ['lakesideschool.org', 'gmail.com'];
    const fake = checkSender(base({ fromName: 'Ms Allen', fromEmail: 'mallen@iaKesideschool.org', knownDomains: known }));
    expect(fake.level).toBe('danger');
    expect(fake.signals[0]!.message).toContain('look like lakesideschool.org, which you correspond with');
    const typo = checkSender(base({ fromEmail: 'office@lakesideschol.org', knownDomains: known }));
    expect(typo.level).toBe('danger');
    expect(checkSender(base({ fromEmail: 'mhill@lakesideschool.org', knownDomains: known })).level).toBe('none');
  });

  it('does not flag a domain the user already writes to', () => {
    const known = ['abcschool.org', 'abc-school.org'];
    expect(checkSender(base({ fromEmail: 'a@abc-school.org', knownDomains: known })).level).toBe('none');
  });
});

describe('authentication', () => {
  it('parses a Gmail header and ignores comments', () => {
    expect(
      parseAuthenticationResults(
        'mx.google.com; dkim=pass header.i=@robinhood.com header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@robinhood.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@robinhood.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=robinhood.com',
      ),
    ).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: 'robinhood.com', dkimDomain: 'robinhood.com' });
  });

  it('parses an Outlook header', () => {
    const a = parseAuthenticationResults(
      'spf=fail (sender IP is 1.2.3.4) smtp.mailfrom=evil.com; dkim=none (message not signed) header.d=none;dmarc=fail action=quarantine header.from=evil.com;compauth=fail reason=000',
    );
    expect(a).toMatchObject({ spf: 'fail', dkim: 'none', dmarc: 'fail', dmarcFrom: 'evil.com' });
  });

  it('turns a DMARC failure into a warning', () => {
    const c = checkSender(base({ fromEmail: 'x@shop.com', auth: { dmarc: 'fail' } }));
    expect(codes(c)).toContain('auth_failed');
    expect(c.level).toBe('danger');
  });

  it('does not claim a check it did not make', () => {
    expect(checkSender(base({ fromEmail: 'x@shop.com' })).authChecked).toBe(false);
  });
});

describe('other signals', () => {
  it('flags a Reply-To on a personal address when the sender claims a brand', () => {
    const c = checkSender(
      base({ fromName: 'Netflix', fromEmail: 'info@mailer.netflix.com', replyTo: 'netflix.help.desk@outlook.com' }),
    );
    expect(codes(c)).toEqual(['reply_to_elsewhere']);
    // Real Netflix domain, nothing else wrong: the gentle line stays.
    expect(c.level).toBe('caution');
    const w = replyToWarning(c)!;
    expect(w).toMatchObject({ address: 'netflix.help.desk@outlook.com', level: 'caution', confirmBeforeReply: false });
    expect(w.message).toBe('Replies would go to netflix.help.desk@outlook.com, not to the sender.');
  });

  // The fake Robinhood email that passed the provider's spam filter: a brand in
  // the display name, a domain that is not Robinhood's, replies collected at a
  // personal Outlook address.
  it('makes the Reply-To a danger warning on a fake Robinhood email', () => {
    const c = checkSender(
      base({
        fromName: 'Robinhood',
        fromEmail: 'no-reply@rh-securealerts.com',
        replyTo: 'friend.test@outlook.com',
        auth: parseAuthenticationResults('mx.google.com; spf=pass smtp.mailfrom=rh-securealerts.com; dmarc=pass header.from=rh-securealerts.com'),
      }),
    );
    expect(c.level).toBe('danger');
    const signal = c.signals.find((s) => s.code === 'reply_to_elsewhere')!;
    expect(signal.level).toBe('danger');
    expect(signal.message).toContain('friend.test@outlook.com');
    expect(signal.message).toContain('which is not Robinhood');
    expect(signal.message).toContain("Don't reply, and don't share account details");
    expect(replyToWarning(c)).toMatchObject({ level: 'danger', confirmBeforeReply: true, address: 'friend.test@outlook.com' });
  });

  it('makes the Reply-To a danger warning when the provider could not confirm the sender', () => {
    const c = checkSender(
      base({
        fromName: 'Netflix',
        fromEmail: 'info@mailer.netflix.com',
        replyTo: 'netflix.help.desk@outlook.com',
        auth: parseAuthenticationResults('mx.google.com; spf=softfail smtp.mailfrom=mailer.netflix.com; dkim=none'),
      }),
    );
    expect(codes(c)).toContain('auth_weak');
    expect(replyToWarning(c)!.level).toBe('danger');
    expect(c.level).toBe('danger');
  });

  it('a person on Gmail with replies to Yahoo gets the gentle line, not a danger', () => {
    const c = checkSender(
      base({
        fromName: 'Ruth Chen',
        fromEmail: 'ruth.chen@gmail.com',
        replyTo: 'ruthc@yahoo.com',
        auth: parseAuthenticationResults('mx.google.com; dkim=pass header.i=@gmail.com; spf=pass; dmarc=pass header.from=gmail.com'),
      }),
    );
    expect(c.level).toBe('caution');
    expect(replyToWarning(c)).toMatchObject({ level: 'caution', confirmBeforeReply: false });
  });

  it('Reply-To on the same freemail provider is not a finding at all', () => {
    for (const domain of ['gmail.com', 'hotmail.com', 'yahoo.com']) {
      const c = checkSender(base({ fromName: 'Ruth', fromEmail: `ruth@${domain}`, replyTo: `ruth.c@${domain}` }));
      expect(replyToWarning(c)).toBeNull();
    }
  });

  it('names the sending domain when no brand is claimed', () => {
    const c = checkSender(
      base({ fromName: 'support@bank.com', fromEmail: 'x@random.biz', replyTo: 'helpdesk.team@gmail.com' }),
    );
    expect(replyToWarning(c)!.message).toContain('which is not random.biz');
  });

  it('has no Reply-To warning when Reply-To is the same organisation', () => {
    const c = checkSender(base({ fromName: 'Robinhood', fromEmail: 'a@rh-x.com', replyTo: 'b@rh-x.com' }));
    expect(replyToWarning(c)).toBeNull();
  });

  it('flags a display name that shows a different address', () => {
    const c = checkSender(base({ fromName: 'support@bank.com', fromEmail: 'x@random.biz' }));
    expect(codes(c)).toContain('name_shows_other_address');
  });

  it('flags links to raw IP addresses', () => {
    const hosts = linkHostsFromHtml('<a href="http://185.22.1.9/login">Sign in</a> <a href=\'https://ok.com/x\'>ok</a>');
    expect(hosts).toEqual(['185.22.1.9', 'ok.com']);
    expect(codes(checkSender(base({ fromEmail: 'a@ok.com', linkHosts: hosts })))).toContain('suspicious_link');
  });

  it('notes a first contact only as information', () => {
    const c = checkSender(base({ fromEmail: 'new@person.com', history: { received: 0, wrote: 0, inPeople: false } }));
    expect(c.level).toBe('info');
    expect(codes(c)).toEqual(['first_contact']);
  });

  it('notes mail not addressed to you, except mass mail', () => {
    const notYou = base({ fromEmail: 'a@b.com', toEmails: ['someone@else.com'] });
    expect(codes(checkSender(notYou))).toContain('not_addressed_to_you');
    expect(codes(checkSender({ ...notYou, bulk: true }))).not.toContain('not_addressed_to_you');
  });

  it('flags a saved person\'s name on an address the user does not have for them', () => {
    const c = checkSender(
      base({
        fromName: 'Alice Stone',
        fromEmail: 'spouse.urgent.help@gmail.com',
        contactNamed: { name: 'Alice Stone', addresses: ['spouse.test@gmail.com'] },
      }),
    );
    expect(codes(c)).toContain('impersonates_contact');
    expect(c.level).toBe('danger');
    const real = checkSender(
      base({
        fromName: 'Alice Stone',
        fromEmail: 'Spouse.tEst@gmail.com',
        contactNamed: { name: 'Alice Stone', addresses: ['spouse.test@gmail.com'] },
      }),
    );
    expect(codes(real)).not.toContain('impersonates_contact');
  });

  it('flags a name that mixes Latin and Cyrillic letters', () => {
    expect(codes(checkSender(base({ fromName: 'Pаypal Billing', fromEmail: 'a@b.com' })))).toContain(
      'mixed_script_name',
    );
    expect(codes(checkSender(base({ fromName: 'Анна', fromEmail: 'a@b.com' })))).not.toContain('mixed_script_name');
  });

  it('flags an attachment that runs code, not a document', () => {
    expect(codes(checkSender(base({ fromEmail: 'a@b.com', attachmentNames: ['Invoice.pdf.html'] })))).toContain(
      'risky_attachment',
    );
    expect(codes(checkSender(base({ fromEmail: 'a@b.com', attachmentNames: ['Invoice.pdf', 'photos.zip'] })))).not.toContain(
      'risky_attachment',
    );
  });

  it('checks nothing on the user\'s own message', () => {
    expect(checkSender(base({ fromName: 'Robinhood', fromEmail: 'me@evil.com', sent: true })).signals).toEqual([]);
  });

  it('lists no brand domain that anyone can open a mailbox on', () => {
    for (const b of BRANDS) for (const d of b.domains) expect(isFreemail(d), `${b.name}: ${d}`).toBe(false);
  });

  it('finds the registrable domain under a country code', () => {
    expect(registrableDomain('mail.shop.co.uk')).toBe('shop.co.uk');
    expect(registrableDomain('a.b.robinhood.com')).toBe('robinhood.com');
  });
});
