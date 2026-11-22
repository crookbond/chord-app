// Composer intake/output — paste, +upload, circular send, copy-out (ADR 0054).
// Each `check(...)` is one assertion; failures are isolated so the rest run.

const h = require('./harness');

// Runs in the page: synthesize a clipboard image-paste. Chromium honours a
// DataTransfer passed to the ClipboardEvent constructor, so this exercises the
// real document `paste` listener (composer must be focused first).
function pasteSyntheticImage() {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const x = c.getContext('2d');
  x.fillStyle = '#5B4FCF';
  x.fillRect(0, 0, 48, 48);
  return new Promise((resolve) => {
    c.toBlob((blob) => {
      const dt = new DataTransfer();
      dt.items.add(new File([blob], '', { type: 'image/png' }));
      document.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      resolve();
    }, 'image/png');
  });
}

async function run(check) {
  const browser = await h.launch();
  try {
    // --- desktop context: send / paste / +upload ---
    const ctx = await h.newContext(browser);
    const page = await ctx.newPage();
    await h.loginAndOpenChat(page, h.uniqueUser('e2e'));

    const msg = 'hello from e2e ' + Date.now();
    await check('circular send posts a message', async () => {
      await page.getByPlaceholder('Message or @Chord').fill(msg);
      await page.getByLabel('Send').click();
      await page.getByText(msg).first().waitFor({ timeout: 10000 });
    });

    await check('pasting an image opens the UploadConfirm guard', async () => {
      await page.getByPlaceholder('Message or @Chord').click(); // focus → composerFocused
      await page.waitForTimeout(150);
      await page.evaluate(pasteSyntheticImage);
      await page.getByText('Send this file?').waitFor({ timeout: 8000 });
    });
    await h.shot(page, 'paste-confirm');

    await check('confirming a pasted image uploads + posts it', async () => {
      await page.getByText('Upload', { exact: true }).click();
      await page.getByText(/📎/).first().waitFor({ timeout: 12000 });
    });

    await check('+ button uploads a chosen file', async () => {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        page.getByLabel('Add a file or photo').click(),
      ]);
      await chooser.setFiles(h.tinyPngPath());
      await page.getByText('Send this file?').waitFor({ timeout: 8000 });
      await page.getByText('Upload', { exact: true }).click();
      await page.getByText(/upload-fixture\.png/).first().waitFor({ timeout: 12000 });
    });
    await ctx.close();

    // --- touch context: copy-out is a long-press gesture ---
    const tctx = await h.newContext(browser, {
      hasTouch: true,
      viewport: { width: 412, height: 900 },
    });
    const tpage = await tctx.newPage();
    await h.loginAndOpenChat(tpage, h.uniqueUser('e2ec'));

    const cmsg = 'copy me ' + Date.now();
    await tpage.getByPlaceholder('Message or @Chord').fill(cmsg);
    await tpage.getByLabel('Send').click();
    await tpage.getByText(cmsg).first().waitFor({ timeout: 10000 });
    await tpage.evaluate(() => navigator.clipboard.writeText('__not_copied__').catch(() => {}));

    await check('long-press a bubble copies its text', async () => {
      const box = await tpage.getByText(cmsg).first().boundingBox();
      const cdp = await tctx.newCDPSession(tpage);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await tpage.waitForTimeout(700); // hold > delayLongPress (350ms)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const clip = await tpage.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      if (clip !== cmsg) throw new Error(`clipboard="${clip}" expected="${cmsg}"`);
    });
    await h.shot(tpage, 'copy-touch');
    await tctx.close();
  } finally {
    await browser.close();
  }
}

module.exports = { name: 'composer intake — paste / +upload / send / copy-out', run };
