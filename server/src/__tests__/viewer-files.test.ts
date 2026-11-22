import { describe, expect, it } from 'vitest';

import { createViewerFileRegistry, isDeletableViewerFile } from '@chord/kernel';

const CACHE = 'file:///data/user/0/ai.chord/cache/';

describe('viewer file registry', () => {
  it('gives a registered file back by its id only', () => {
    const reg = createViewerFileRegistry();
    const id = reg.register({ uri: `${CACHE}email-m1-a.pdf`, name: 'a.pdf', mime: 'application/pdf', owned: true });
    expect(reg.get(id)?.uri).toBe(`${CACHE}email-m1-a.pdf`);
    expect(reg.release(id)?.name).toBe('a.pdf');
    expect(reg.get(id)).toBeNull();
  });

  // The route used to read `uri` from its own params, so a link like
  // chord://file-viewer?uri=https://evil.example framed any site and
  // ?uri=<cache>email-store/ had the viewer delete the sealed mail store.
  it('knows nothing a link can name', () => {
    const reg = createViewerFileRegistry();
    reg.register({ uri: `${CACHE}x.pdf`, name: 'x.pdf', mime: '', owned: true });
    expect(reg.get('https://evil.example/')).toBeNull();
    expect(reg.get(`${CACHE}email-store/`)).toBeNull();
    expect(reg.get('vf999-zzz')).toBeNull();
    expect(reg.release(`${CACHE}email-store/`)).toBeNull();
    expect(reg.get(undefined)).toBeNull();
  });

  it('forgets the oldest past its cap', () => {
    const reg = createViewerFileRegistry({ max: 2 });
    const a = reg.register({ uri: 'blob:a', name: 'a', mime: '', owned: true });
    reg.register({ uri: 'blob:b', name: 'b', mime: '', owned: true });
    reg.register({ uri: 'blob:c', name: 'c', mime: '', owned: true });
    expect(reg.size()).toBe(2);
    expect(reg.get(a)).toBeNull();
  });
});

describe('isDeletableViewerFile', () => {
  it('allows a download directly in the cache', () => {
    expect(isDeletableViewerFile(`${CACHE}email-m1-Report.pdf`, CACHE)).toBe(true);
    expect(isDeletableViewerFile(`${CACHE}att1-notes..txt`, CACHE)).toBe(true);
  });

  it('refuses the sealed store, escapes and other folders', () => {
    expect(isDeletableViewerFile(`${CACHE}email-store/`, CACHE)).toBe(false);
    expect(isDeletableViewerFile(`${CACHE}email-store/u1/index.json`, CACHE)).toBe(false);
    expect(isDeletableViewerFile(`${CACHE}../files/secret`, CACHE)).toBe(false);
    expect(isDeletableViewerFile(`${CACHE}%2e%2e/files/secret`, CACHE)).toBe(false);
    expect(isDeletableViewerFile(`${CACHE}`, CACHE)).toBe(false);
    expect(isDeletableViewerFile(`${CACHE}sub/file.pdf`, CACHE)).toBe(false);
    expect(isDeletableViewerFile('file:///data/user/0/ai.chord/files/a.pdf', CACHE)).toBe(false);
    expect(isDeletableViewerFile(`${CACHE}a.pdf`, null)).toBe(false);
  });
});
