// Local acceptance: build both packages and migrate the isolated test database first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
require('ts-node/register');
require('../test/setup-env.ts');
process.env.PORT = '4001';
process.env.CORS_ORIGINS = 'http://127.0.0.1:4175';
process.env.PUBLIC_STOREFRONT_URL = 'http://127.0.0.1:4175';
assert.match(process.env.MONGODB_URI, /127\.0\.0\.1:27017\/rich_culture_test\?/);
const { NestFactory } = require('@nestjs/core');
const { getModelToken } = require('@nestjs/mongoose');
const { AppModule } = require('../dist/app.module.js');
const { configureApplication } = require('../dist/bootstrap.js');
const { PasswordService } = require('../dist/modules/admin-auth/password.service.js');
const { canonicalReelUrl } = require('../dist/modules/instagram-reels/instagram-reels.service.js');
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test');
const evidence = resolve(
  process.env.REPAIR_SMOKE_OUTPUT ?? '../.local/instagram-reels-browser-smoke',
);
await mkdir(evidence, { recursive: true });
const base = 'http://127.0.0.1:4175';
const prefix = `REEL-UI-${randomUUID().slice(0, 8)}`;
const email = `${prefix}@example.test`;
const password = randomUUID() + '-Reels';
const reelUrl = canonicalReelUrl(
  process.env.INSTAGRAM_REEL_SMOKE_URL ?? `https://www.instagram.com/reel/${prefix}/`,
);
const app = await NestFactory.create(AppModule, { logger: false });
configureApplication(app);
const model = (name) => app.get(getModelToken(name));
let preview;
let browser;
let reelId;
const providerResponses = [];
try {
  await app.listen(4001, '127.0.0.1');
  await model('AdminUser').create({
    name: prefix,
    email,
    passwordHash: await app.get(PasswordService).hash(password),
    roles: ['OWNER'],
    status: 'ACTIVE',
  });
  preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', '4175', '--strictPort'],
    {
      cwd: resolve(import.meta.dirname, '../../frontend'),
      env: { ...process.env, VITE_DEV_API_TARGET: 'http://127.0.0.1:4001' },
      stdio: 'ignore',
    },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${base}/api/v1/repair/reels`)).ok) break;
    } catch {
      /* Preview starting. */
    }
    if (attempt >= 60 || preview.exitCode !== null) throw new Error('Preview failed to start');
    await delay(250);
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    reducedMotion: 'reduce',
  });
  const csrf = await (await context.request.get(`${base}/api/v1/admin/auth/csrf`)).json();
  const login = await context.request.post(`${base}/api/v1/admin/auth/login`, {
    headers: { 'X-CSRF-Token': csrf.csrfToken },
    data: { email, password },
  });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  if (!process.env.INSTAGRAM_REEL_SMOKE_URL)
    await page.route('https://www.instagram.com/reel/**/embed/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><body>Instagram embed fixture</body></html>',
      }),
    );
  page.on('response', (response) => {
    if (response.url() === reelUrl + 'embed/') providerResponses.push(response.status());
  });
  await page.goto(`${base}/admin/repair/reels`);
  await page.getByLabel('Instagram Reel link').fill(reelUrl + '?igsh=acceptance');
  await page.getByLabel('Title (optional)').fill(prefix);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/admin/repair/reels'),
  );
  await page.getByRole('button', { name: 'Save reel', exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  const reel = await response.json();
  reelId = reel.id;
  assert.equal(reel.url, reelUrl);
  await expect(page.getByRole('status')).toHaveText('Reel saved and shown on the homepage.');
  assert.equal((await model('InstagramReel').findById(reelId)).active, true);
  await page.goto(`${base}/#workshop-reels`);
  const section = page.getByRole('region', { name: 'From our workshop.' });
  await expect(section).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator('iframe')).toHaveAttribute('src', reelUrl + 'embed/');
  await expect(section.getByRole('link', { name: /Watch on Instagram/ })).toHaveAttribute(
    'href',
    reelUrl,
  );
  if (process.env.INSTAGRAM_REEL_SMOKE_URL) await delay(6000);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await section.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await section.screenshot({
      path: resolve(evidence, `live-workshop-${width}.png`),
      animations: 'disabled',
    });
  }
  const providerFrame = page.frames().find((frame) => frame.url().startsWith(reelUrl));
  const providerText = providerFrame
    ? (
        await providerFrame
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 1500)
    : '';
  await page.goto(`${base}/admin/repair/reels`);
  await page.getByRole('button', { name: `Edit ${prefix}`, exact: true }).click();
  await page.getByLabel('Show on website').uncheck();
  await page.getByLabel('Display order').fill('5');
  await page.getByRole('button', { name: 'Save reel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Reel saved and hidden from the homepage.');
  assert.equal((await model('InstagramReel').findById(reelId)).active, false);
  await page.goto(base);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'From our workshop.' })).toHaveCount(0);
  await page.goto(`${base}/admin/repair/reels`);
  await page.getByRole('button', { name: `Edit ${prefix}`, exact: true }).click();
  await page.getByLabel('Show on website').check();
  await page.getByRole('button', { name: 'Save reel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Reel saved and shown on the homepage.');
  const publicRows = await (await context.request.get(`${base}/api/v1/repair/reels`)).json();
  assert.equal(publicRows.items[0].id, reelId);
  assert.equal(publicRows.items[0].sortOrder, 5);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: resolve(evidence, `live-admin-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  console.log(
    JSON.stringify({
      passed: true,
      realApi: true,
      realDatabase: true,
      realInstagramRequested: !!process.env.INSTAGRAM_REEL_SMOKE_URL,
      providerResponses,
      providerText,
      assertions: [
        'link saved through owner UI',
        'canonical URL persisted',
        'homepage iframe and fallback link',
        'mobile and desktop layouts',
        'hide removes public Reel',
        'republish and reorder persist',
      ],
      evidenceDirectory: evidence,
    }),
  );
} finally {
  await browser?.close();
  if (preview && preview.exitCode === null) {
    const stopped = new Promise((done) => preview.once('exit', done));
    preview.kill('SIGTERM');
    await stopped;
  }
  if (reelId) await model('InstagramReel').deleteOne({ _id: reelId });
  const users = await model('AdminUser').find({ email: email.toLowerCase() });
  const ids = users.map((user) => user._id);
  await model('AuditLog').deleteMany({ actorId: { $in: ids } });
  await model('AdminSession').deleteMany({ adminUserId: { $in: ids } });
  await model('AdminUser').deleteMany({ _id: { $in: ids } });
  await app.close();
}
