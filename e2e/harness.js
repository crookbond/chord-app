// Shared plumbing for the Chord web e2e suites.
//
// We drive the locally-installed Chrome through playwright-core (channel:'chrome')
// so there is no bundled-browser download and the tests hit the same engine users
// run. The app is exercised over the real dev stack — server, web bundle, and
// Postgres must already be up (see README). `localhost` is required: the web app
// hard-codes its API at 127.0.0.1:4000 and WebCrypto is restricted to secure
// origins, so this can only run against a host browser, not a sandboxed one.

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error(
    "playwright-core is not installed. Run `npm install` in e2e/ (the root `npm run test:e2e` does this for you).",
  );
  process.exit(1);
}

const fs = require('fs');
const path = require('path');

const BASE = process.env.CHORD_WEB || 'http://localhost:8081';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// 1x1 PNG — a minimal valid image for the file-upload path.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function launch() {
  return chromium.launch({ channel: 'chrome', headless: !process.env.HEADED });
}

function newContext(browser, opts = {}) {
  return browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    ...opts,
  });
}

// Demo-mode login (a username is the whole sign-up) → open the personal
// "My Chord" group → wait for the composer.
async function loginAndOpenChat(page, user) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const username = page.getByPlaceholder('username');
  await username.waitFor({ timeout: 15000 });
  await username.fill(user);
  await username.press('Enter');
  const chat = page.getByText('My Chord').first();
  await chat.waitFor({ timeout: 15000 });
  await chat.click();
  await page.getByPlaceholder('Message or @Chord').waitFor({ timeout: 15000 });
}

function uniqueUser(prefix) {
  return prefix + Date.now().toString().slice(-6);
}

function tinyPngPath() {
  const p = path.join(SHOTS, 'upload-fixture.png');
  fs.writeFileSync(p, Buffer.from(PNG_1PX, 'base64'));
  return p;
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

module.exports = { BASE, SHOTS, launch, newContext, loginAndOpenChat, uniqueUser, tinyPngPath, shot };
