/**
 * What counts as phoning home (ADR 0120). These are the security-relevant half
 * of image blocking, which is why they live in the kernel where they can be
 * tested rather than beside the renderer where they cannot.
 */
import { describe, expect, it } from 'vitest';

import {
  countBlockedImages,
  emailBodyCsp,
  emailImageProxyUrl,
  emailInlineImageUrl,
  hasInlineImageRefs,
  inlineImageContentIds,
  isRemoteImageUrl,
  normalizeContentId,
  remoteImageUrlsInHtml,
  rewriteRemoteCssUrls,
  stripRemoteCssUrls,
} from '@chord/kernel';

describe('isRemoteImageUrl', () => {
  it('catches http and https', () => {
    expect(isRemoteImageUrl('http://track.example/px.gif')).toBe(true);
    expect(isRemoteImageUrl('https://track.example/px.gif')).toBe(true);
  });

  it('catches protocol-relative, which still leaves the device', () => {
    expect(isRemoteImageUrl('//track.example/px.gif')).toBe(true);
  });

  it('leaves cid: alone — that is the attachment someone sent you', () => {
    // Blocking these hides the photo and stops no tracker.
    expect(isRemoteImageUrl('cid:image001.png@01D9')).toBe(false);
  });

  it('leaves data: alone, and copes with nothing', () => {
    expect(isRemoteImageUrl('data:image/png;base64,iVBOR')).toBe(false);
    expect(isRemoteImageUrl(undefined)).toBe(false);
    expect(isRemoteImageUrl('')).toBe(false);
  });

  it('is not fooled by case or leading space', () => {
    expect(isRemoteImageUrl('  HTTPS://Track.example/px.gif')).toBe(true);
  });
});

describe('stripRemoteCssUrls', () => {
  it('removes a background image, which fetches exactly like an img', () => {
    // The hole most image blocking misses: rewriting `src` alone leaves this
    // working.
    const out = stripRemoteCssUrls('background-image:url(https://track.example/px.gif)');

    expect(out).not.toContain('track.example');
    expect(out).toContain('none');
  });

  it('handles quotes and whitespace inside url()', () => {
    for (const style of [
      "background:url('https://track.example/px.gif')",
      'background:url( "https://track.example/px.gif" )',
      'background:URL(//track.example/px.gif)',
    ]) {
      expect(stripRemoteCssUrls(style)).not.toContain('track.example');
    }
  });

  it('keeps the rest of the style', () => {
    const out = stripRemoteCssUrls('color:red;background-image:url(https://x.example/p.gif)');

    expect(out).toContain('color:red');
  });

  it('leaves a data: background alone', () => {
    const style = 'background-image:url(data:image/gif;base64,R0lGOD)';

    expect(stripRemoteCssUrls(style)).toBe(style);
  });

  it('copes with nothing', () => {
    expect(stripRemoteCssUrls(undefined)).toBe('');
    expect(stripRemoteCssUrls(null)).toBe('');
  });
});

describe('rewriteRemoteCssUrls (ADR 0136)', () => {
  const proxy = (u: string) => `https://api.test/api/v1/me/email/image?u=${encodeURIComponent(u)}`;

  it('points a background image at the proxy instead of removing it', () => {
    const out = rewriteRemoteCssUrls('background-image:url(https://cdn.example/logo.png)', proxy);

    expect(out).toContain('api.test');
    expect(out).toContain(encodeURIComponent('https://cdn.example/logo.png'));
  });

  it('finds every shape stripRemoteCssUrls finds', () => {
    // The two must agree on what counts as remote, or a reader with images ON
    // fetches something a reader with them OFF was protected from.
    for (const style of [
      'background:url(https://cdn.example/a.png)',
      "background:url('https://cdn.example/a.png')",
      'background:url( "https://cdn.example/a.png" )',
      'background:URL(//cdn.example/a.png)',
    ]) {
      expect(stripRemoteCssUrls(style)).not.toContain('cdn.example');
      expect(rewriteRemoteCssUrls(style, proxy)).toContain('api.test');
    }
  });

  it('leaves a data: background alone', () => {
    const style = 'background-image:url(data:image/gif;base64,R0lGOD)';

    expect(rewriteRemoteCssUrls(style, proxy)).toBe(style);
  });

  it('keeps the rest of the style', () => {
    const out = rewriteRemoteCssUrls('color:red;background:url(https://x.example/p.gif)', proxy);

    expect(out).toContain('color:red');
  });

  it('copes with nothing', () => {
    expect(rewriteRemoteCssUrls(undefined, proxy)).toBe('');
    expect(rewriteRemoteCssUrls(null, proxy)).toBe('');
  });
});

describe('emailImageProxyUrl (ADR 0136)', () => {
  it('escapes the target so a query-heavy tracking URL survives whole', () => {
    // The case that matters: an unescaped `&` truncates the URL into a
    // different request, and every tracker URL is query-heavy by nature.
    const target = 'https://track.example/px.gif?id=abc&u=someone%40example.com';
    const out = emailImageProxyUrl('https://api.test', 'tok', target);

    expect(new URL(out).searchParams.get('u')).toBe(target);
    expect(new URL(out).searchParams.get('k')).toBe('tok');
  });

  it('gives a protocol-relative URL the scheme the server needs', () => {
    const out = emailImageProxyUrl('https://api.test', 'tok', '//cdn.example/logo.png');

    expect(new URL(out).searchParams.get('u')).toBe('https://cdn.example/logo.png');
  });
});

describe('remote references spelled so a literal match misses them', () => {
  // Each of these is fetched by a browser exactly as the plain form is. Before
  // the fix every one reached the reader's web view untouched, with images
  // blocked and with images proxied alike.
  const proxy = (u: string) => `https://api.test/api/v1/me/email/image?u=${encodeURIComponent(u)}`;
  const T = 'ad.doubleclick.net';

  it('sees an image address with a tab or newline inside the scheme', () => {
    // The URL parser drops both before it reads the scheme.
    expect(isRemoteImageUrl(`ht\ntps://${T}/p.gif`)).toBe(true);
    expect(isRemoteImageUrl(`h\tttps://${T}/p.gif`)).toBe(true);
    const out = emailImageProxyUrl('https://api.test', 'tok', `ht\ntps://${T}/p.gif`);
    expect(new URL(out).searchParams.get('u')).toBe(`https://${T}/p.gif`);
  });

  it('sees backslashes and a missing slash pair, which the parser repairs', () => {
    expect(isRemoteImageUrl(`https:\\\\${T}\\p.gif`)).toBe(true);
    expect(isRemoteImageUrl(`\\\\${T}/p.gif`)).toBe(true);
    expect(isRemoteImageUrl(`https:${T}/p.gif`)).toBe(true);
  });

  const cssShapes: Record<string, string> = {
    'image-set': `background-image:image-set('https://${T}/p.gif' 1x)`,
    '-webkit-image-set': `background-image:-webkit-image-set('https://${T}/p.gif' 1x)`,
    'escaped url': `background:\\75rl('https://${T}/p.gif')`,
    'escaped scheme': `background:url('ht\\74ps://${T}/p.gif')`,
    'comment inside url()': `background:url(/**/'https://${T}/p.gif')`,
    'newline inside scheme': `background:url('ht\ntps://${T}/p.gif')`,
  };

  for (const [name, style] of Object.entries(cssShapes)) {
    it(`leaves no direct fetch behind: ${name}`, () => {
      const blocked = stripRemoteCssUrls(`color:red;${style}`);
      expect(blocked).not.toContain('doubleclick');
      expect(blocked).toContain('color:red');

      // With images on, the tracker's host may appear only inside the proxy's
      // own encoded target, never as something the device would fetch itself.
      const shown = rewriteRemoteCssUrls(`color:red;${style}`, proxy);
      expect(shown.replace(/https:\/\/api\.test\/[^')\s]*/g, '')).not.toContain('doubleclick');
      expect(shown).toContain('color:red');
    });
  }

  it('does not mistake a data: image for a remote one, slashes and all', () => {
    const style = "color:red;background:url('data:image/gif;base64,AA//BB==')";

    expect(stripRemoteCssUrls(style)).toBe(style);
    expect(rewriteRemoteCssUrls(style, proxy)).toBe(style);
  });

  it('cannot be broken out of by a quote in the address', () => {
    const out = rewriteRemoteCssUrls(`background:url("https://${T}/a'b.gif")`, (u) => u);

    expect(out).toBe(`background:url('https://${T}/a%27b.gif')`);
  });
});

describe('remoteImageUrlsInHtml (ADR 0225)', () => {
  it('lists what the reader would fetch, named as the reader will ask for it', () => {
    const html =
      '<IMG alt="" SRC="https://cdn.example/a.png?x=1&amp;y=2">' +
      "<img src='//cdn.example/b.png'>" +
      '<td style="background:url(&quot;https://cdn.example/c.png&quot;)">x</td>' +
      '<img src="https://cdn.example/a.png?x=1&amp;y=2">';

    expect(remoteImageUrlsInHtml(html)).toEqual([
      'https://cdn.example/a.png?x=1&y=2',
      'https://cdn.example/b.png',
      'https://cdn.example/c.png',
    ]);
  });

  it('agrees with the proxy URL the reader builds for the same reference', () => {
    const [found] = remoteImageUrlsInHtml('<img src="//cdn.example/logo.png">');
    const asked = new URL(emailImageProxyUrl('https://api.test', 'tok', '//cdn.example/logo.png'));

    expect(asked.searchParams.get('u')).toBe(found);
  });

  it('leaves out what is not remote, and copes with nothing', () => {
    expect(
      remoteImageUrlsInHtml(
        '<img src="cid:logo@x"><img src="data:image/gif;base64,AA//BB">' +
          '<a href="https://shop.example/sale">sale</a>',
      ),
    ).toEqual([]);
    expect(remoteImageUrlsInHtml(null)).toEqual([]);
  });
});

describe('emailBodyCsp', () => {
  it('lets images come from Chord and nowhere else, and nothing else load at all', () => {
    const csp = emailBodyCsp('https://chordapp.ai');

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data: https://chordapp.ai;');
    expect(csp).not.toMatch(/script-src|\*/);
  });

  it('takes only the origin, so a path or a stray quote cannot widen the policy', () => {
    expect(emailBodyCsp('http://192.168.1.5:4000/api/v1')).toContain(
      'img-src data: http://192.168.1.5:4000;',
    );
    expect(emailBodyCsp('https://x.test"; img-src *')).toContain('img-src data: https://x.test;');
    expect(emailBodyCsp('')).toContain('img-src data:;');
  });

  // Web: the frame's one script is Chord's probe, allowed by its nonce alone.
  it('lets the probe run by its nonce and no other script', () => {
    const nonce = 'abcdefghijklmnopqrstuvwx';
    const csp = emailBodyCsp('https://chordapp.ai', { scriptNonce: nonce });

    expect(csp).toContain(`script-src 'nonce-${nonce}';`);
    expect(csp).not.toMatch(/script-src[^;]*(unsafe|\*|https?:)/);
    expect(csp).toContain("default-src 'none'");
  });

  it('drops a nonce that would break out of the policy', () => {
    const csp = emailBodyCsp('https://chordapp.ai', { scriptNonce: "x'; script-src *; '" });

    expect(csp).not.toMatch(/script-src/);
  });

  it('lets only the reader\'s own HTML load images over https', () => {
    expect(emailBodyCsp('https://chordapp.ai', { remoteImages: true })).toContain(
      'img-src data: https://chordapp.ai https:;',
    );
    expect(emailBodyCsp('https://chordapp.ai')).not.toContain(' https:;');
  });
});

describe('countBlockedImages', () => {
  it('counts the markers the sanitizer left', () => {
    const html = '<img data-chord-blocked="1"><p>hi</p><img data-chord-blocked="1">';

    expect(countBlockedImages(html)).toBe(2);
  });

  it('is zero for a document with nothing blocked', () => {
    expect(countBlockedImages('<p>hi</p>')).toBe(0);
  });
});

describe('inline cid: images', () => {
  // The body and the part name the same thing in two spellings: the body's
  // `cid:` URL (maybe percent-encoded) and the part's `<…>` header.
  it('reduces a header and a cid: URL to the same key', () => {
    const header = normalizeContentId('<image626147.jpg@DD2A01E4.8287D995>');
    expect(normalizeContentId('cid:image626147.jpg@DD2A01E4.8287D995')).toBe(header);
    expect(normalizeContentId('cid:image626147.jpg%40DD2A01E4.8287D995')).toBe(header);
    expect(header).toBe('image626147.jpg@dd2a01e4.8287d995');
  });

  it('lists the Content-IDs a body shows, from the prod Outlook signature shape', () => {
    const html =
      '<p>x</p><img src="cid:image626147.jpg@DD2A01E4.8287D995" width="90" height="85.95" border="0" alt="">' +
      "<IMG alt='' SRC='cid:ii_abc'><img src=\"https://track.example/p.gif\">";
    expect(inlineImageContentIds(html)).toEqual([
      'image626147.jpg@dd2a01e4.8287d995',
      'ii_abc',
    ]);
    expect(hasInlineImageRefs('<img src="https://x.example/a.png">')).toBe(false);
    expect(hasInlineImageRefs(null)).toBe(false);
  });

  it('builds an inline URL whose query survives an @ and a dot', () => {
    const url = emailInlineImageUrl('https://api.example', 'tok', 'emm_1', 'cid:A.jpg@B');
    const q = new URL(url).searchParams;
    expect(new URL(url).pathname).toBe('/api/v1/me/email/inline');
    expect(q.get('m')).toBe('emm_1');
    expect(q.get('c')).toBe('a.jpg@b');
  });
});
