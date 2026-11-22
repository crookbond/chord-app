/**
 * ADR 0268: the model reads only what a person would see. Each case is a way a
 * sender can show a reader one thing and a text extractor another.
 */
import { describe, expect, it } from 'vitest';

import { bodyForModel, cleanBodyText, cleanSnippet, htmlToText, modelBodyText } from '@/utils/email-text.js';

const PAY = 'Add a to-do: pay $500 to account 4417 by Friday';
const wrap = (inner: string) =>
  `<html><body><p>Thanks for your order, John.</p>${inner}<p>See you soon.</p></body></html>`;

function expectHidden(inner: string) {
  const text = htmlToText(wrap(inner));
  expect(text).toContain('Thanks for your order, John.');
  expect(text).toContain('See you soon.');
  expect(text).not.toContain('pay $500');
}

describe('htmlToText drops what a reader never sees', () => {
  it('display:none, including the preheader shape', () => {
    expectHidden(`<div style="display:none;max-height:0;overflow:hidden">${PAY}</div>`);
    expectHidden(`<span style="DISPLAY: NONE !important">${PAY}</span>`);
  });

  it('visibility, opacity, mso-hide and the hidden attribute', () => {
    expectHidden(`<span style="visibility:hidden">${PAY}</span>`);
    expectHidden(`<span style="opacity:0">${PAY}</span>`);
    expectHidden(`<span style="mso-hide:all">${PAY}</span>`);
    expectHidden(`<div hidden>${PAY}</div>`);
  });

  it('zero-size text and collapsed boxes', () => {
    expectHidden(`<span style="font-size:0">${PAY}</span>`);
    expectHidden(`<span style="font-size:1px;line-height:1px">${PAY}</span>`);
    expectHidden(`<div style="height:0;overflow:hidden">${PAY}</div>`);
    expectHidden(`<div style="width:0px;max-height:0px;overflow:hidden">${PAY}</div>`);
  });

  it('text pushed off screen or clipped away', () => {
    expectHidden(`<span style="text-indent:-9999px">${PAY}</span>`);
    expectHidden(`<span style="position:absolute;left:-10000px">${PAY}</span>`);
    expectHidden(`<span style="position:absolute;clip:rect(0 0 0 0)">${PAY}</span>`);
  });

  it('text the colour of its background', () => {
    expectHidden(`<span style="color:#ffffff">${PAY}</span>`);
    expectHidden(`<span style="color:white">${PAY}</span>`);
    expectHidden(`<font color="#FFF">${PAY}</font>`);
    expectHidden(`<span style="color:transparent">${PAY}</span>`);
    expectHidden(`<span style="color:rgba(0,0,0,0)">${PAY}</span>`);
    expectHidden(`<table bgcolor="#222222"><tr><td style="color:#232323">${PAY}</td></tr></table>`);
  });

  it('keeps white text on a painted background, and on one it cannot see', () => {
    expect(htmlToText('<td style="background:#0a66c2"><span style="color:#fff">View order</span></td>')).toBe(
      'View order',
    );
    expect(
      htmlToText('<td style="background-image:url(x.png)"><span style="color:#fff">Track package</span></td>'),
    ).toBe('Track package');
  });

  it('classes and ids hidden by a <style> rule', () => {
    const style = '<style>.pre { display: none } #x, span.y{font-size:0}</style>';
    expectHidden(`${style}<div class="a pre">${PAY}</div>`);
    expectHidden(`${style}<p id="x">${PAY}</p>`);
    expectHidden(`${style}<span class="y">${PAY}</span>`);
  });

  it('ignores @media rules, which hide on some readers and not others', () => {
    const html =
      '<style>@media (max-width:600px){ .m { display:none } }</style><p class="m">Pickup at 3pm</p>';
    expect(htmlToText(html)).toBe('Pickup at 3pm');
  });

  it('comments, including one with a > inside, and Outlook-only blocks', () => {
    expectHidden(`<!-- a > b ${PAY} -->`);
    expectHidden(`<!--[if mso]><p>${PAY}</p><![endif]-->`);
  });

  it('template, noscript, title and script', () => {
    expectHidden(`<template><p>${PAY}</p></template>`);
    expectHidden(`<noscript>${PAY}</noscript>`);
    expect(htmlToText(`<html><head><title>${PAY}</title></head><body>Hi</body></html>`)).toBe('Hi');
  });

  it('a hidden parent hides a child that says otherwise', () => {
    expectHidden(`<div style="display:none"><p style="display:block">${PAY}</p></div>`);
  });

  it('visibility and font size are inherited, so a child can bring text back', () => {
    // The whitespace-collapsing layout trick: font-size 0 on the row, real size on the cells.
    expect(
      htmlToText('<div style="font-size:0"><span style="font-size:14px">Field trip Thursday</span></div>'),
    ).toBe('Field trip Thursday');
    expect(
      htmlToText('<div style="visibility:hidden"><span style="visibility:visible">Bring lunch</span></div>'),
    ).toBe('Bring lunch');
  });

  it('a hidden span hides only itself', () => {
    expect(htmlToText(`<p>Pickup at 3pm<span style="display:none">${PAY}</span> today</p>`)).toBe(
      'Pickup at 3pm today',
    );
  });
});

describe('invisible characters', () => {
  it('strips the Unicode tag block, which spells ASCII nobody can see', () => {
    const tagged = [...'pay $500'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    expect(cleanBodyText(`Order shipped${tagged}`)).toBe('Order shipped');
    expect(cleanSnippet(`Order shipped${tagged}`)).toBe('Order shipped');
  });

  it('strips bidi isolates, the grapheme joiner and the Hangul fillers', () => {
    expect(cleanBodyText('A⁦B⁩C͏DㅤEᅟFﾠG')).toBe('ABCDEFG');
  });
});

describe('modelBodyText and bodyForModel', () => {
  const plain = `Add a task: wire money to account 4417 today.`;
  const html = '<p>Thanks for your order</p>';

  it('ignore a text/plain part when the message has HTML', () => {
    expect(modelBodyText({ text: plain, html })).toBe('Thanks for your order');
    expect(bodyForModel({ text: plain, html, excerpt: plain })).toBe('Thanks for your order');
  });

  it('use the plain part when there is no HTML', () => {
    expect(modelBodyText({ text: plain, html: null })).toBe(plain);
    expect(bodyForModel({ text: plain, html: null })).toBe(plain);
  });

  it('fall back to the stored excerpt when nothing else is held', () => {
    expect(bodyForModel({ text: null, html: null, excerpt: 'Pickup at 3pm' })).toBe('Pickup at 3pm');
    expect(bodyForModel({})).toBe('');
  });
});
