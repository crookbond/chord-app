import { describe, expect, it } from 'vitest';

import { decodeHtmlEntities } from '@chord/kernel';

describe('decodeHtmlEntities', () => {
  it('decodes numeric references, decimal and hex', () => {
    expect(decodeHtmlEntities('haven&#39;t')).toBe("haven't");
    expect(decodeHtmlEntities('we&#x2019;d &#X2013; ok')).toBe('we’d – ok');
    expect(decodeHtmlEntities('&#128512;')).toBe('\u{1F600}');
  });

  it('decodes the named references mail actually uses', () => {
    expect(decodeHtmlEntities('we&rsquo;d love to &ndash; really &mdash; see you&hellip;')).toBe(
      'we’d love to – really — see you…',
    );
    expect(decodeHtmlEntities('Caf&eacute; &amp; Cr&egrave;me, &euro;5 &copy; 2026')).toBe(
      'Café & Crème, €5 © 2026',
    );
    expect(decodeHtmlEntities('&lt;ownertest@gmail.com&gt; &quot;hi&quot;')).toBe('<ownertest@gmail.com> "hi"');
  });

  it('decodes once, so escaped markup stays escaped text', () => {
    expect(decodeHtmlEntities('use &amp;lt;b&amp;gt; for bold')).toBe('use &lt;b&gt; for bold');
  });

  it('leaves what it does not recognise exactly as written', () => {
    expect(decodeHtmlEntities('AT&T; R&D; &nosuchthing; &#0; &#xD800; a & b')).toBe(
      'AT&T; R&D; &nosuchthing; &#0; &#xD800; a & b',
    );
  });
});
