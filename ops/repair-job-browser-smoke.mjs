// Real browser acceptance against local test services only. Build both packages first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
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
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test');
const sharp = require('sharp');
const evidence = resolve(process.env.REPAIR_SMOKE_OUTPUT ?? '../.local/repair-job-browser-smoke');
await mkdir(evidence, { recursive: true });
const base = 'http://127.0.0.1:4175';
const prefix = `job-ui-${randomUUID().slice(0, 8)}`;
const password = `${randomUUID()}-Repair`;
const email = `${prefix}-owner@example.test`;
const app = await NestFactory.create(AppModule, { logger: false });
configureApplication(app);
let preview;
let browser;
const errors = [];
try {
  await app.listen(4001, '127.0.0.1');
  await app.get(getModelToken('AdminUser')).create({
    name: `${prefix}-owner`,
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
      if ((await fetch(`${base}/api/v1/repair/catalog`)).ok) break;
    } catch {
      /* Preview is starting. */
    }
    if (attempt >= 60 || preview.exitCode !== null) throw new Error('Preview did not start');
    await delay(250);
  }
  browser = await chromium.launch();
  async function signIn(address, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { csrfToken } = await (
      await context.request.get(`${base}/api/v1/admin/auth/csrf`)
    ).json();
    const response = await context.request.post(`${base}/api/v1/admin/auth/login`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { email: address, password },
    });
    assert.equal(response.status(), 200, await response.text());
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    return { context, page, csrfToken };
  }
  const staff = await signIn(email, 390);
  const page = staff.page;
  const bookingResponse = await staff.context.request.post(`${base}/api/v1/admin/repair/bookings`, {
    headers: { 'X-CSRF-Token': staff.csrfToken },
    data: {
      idempotencyKey: randomUUID(),
      manageToken: randomBytes(32).toString('hex'),
      customerName: prefix,
      phone: '+919876543210',
      deviceDescription: 'Acceptance phone',
      issue: 'Cracked screen, touch is intermittently unresponsive.',
    },
  });
  assert.equal(bookingResponse.status(), 201, await bookingResponse.text());
  const { booking } = await bookingResponse.json();
  async function submit(targetPage, button, endpoint) {
    const responsePromise = targetPage.waitForResponse(
      (response) => response.request().method() !== 'GET' && response.url().endsWith(endpoint),
    );
    await button.click();
    const response = await responsePromise;
    assert.ok([200, 201, 204].includes(response.status()), await response.text());
    if (await button.count()) await expect(button).toBeEnabled();
    return response;
  }
  const form = (targetPage, heading) =>
    targetPage
      .locator('form')
      .filter({ has: targetPage.getByRole('heading', { name: heading, exact: true }) });
  async function move(targetPage, status, recipient) {
    const section = form(targetPage, 'Update repair status');
    await section.getByRole('combobox', { name: 'Next status' }).selectOption(status);
    await section.getByLabel('Reason / work performed').fill(`Acceptance workflow: ${status}`);
    if (recipient) await section.getByLabel('Collected by (required for delivery)').fill(recipient);
    await submit(
      targetPage,
      section.getByRole('button', { name: 'Update status', exact: true }),
      '/transitions',
    );
    await expect(targetPage.locator('.repair-job-state .repair-status')).toHaveText(
      status.toLowerCase().replaceAll('_', ' '),
    );
  }
  // Owner provisions a real technician through the UI.
  await page.goto(`${base}/admin/repair/team`);
  await page.getByLabel('Name', { exact: true }).fill(`${prefix}-technician`);
  await page.getByLabel('Email', { exact: true }).fill(`${prefix}-technician@example.test`);
  await page.getByLabel('Initial password').fill(password);
  await submit(page, page.getByRole('button', { name: 'Create account' }), '/admin/repair/team');
  await expect(
    page.getByRole('heading', { name: `${prefix}-technician`, exact: true }),
  ).toBeVisible();
  const technician = await app
    .get(getModelToken('AdminUser'))
    .findOne({ email: `${prefix}-technician@example.test` })
    .orFail();
  await page.goto(`${base}/admin/repair/bookings/${booking.reference}`);
  await page.getByRole('link', { name: 'Receive device & open job card' }).click();
  await page
    .getByLabel('Received condition')
    .fill('Cracked front glass, powers on, case scratched.');
  await page.getByLabel('Accessories received').fill('Blue case, SIM removed by customer.');
  await page.getByLabel('IMEI (optional, 15 digits)').fill('123456789012345');
  await page.getByRole('button', { name: 'Receive device & create job' }).click();
  await expect(page).toHaveURL(/\/admin\/repair\/jobs\/JOB-[A-F0-9]{16}$/);
  const number = page.url().split('/').pop();
  const jobs = app.get(getModelToken('RepairJob'));
  assert.equal(await jobs.countDocuments({ bookingReference: booking.reference }), 1);
  assert.equal(
    (
      await app
        .get(getModelToken('RepairBooking'))
        .findOne({ reference: booking.reference })
        .orFail()
    ).status,
    'CONVERTED',
  );
  const assignment = form(page, 'Assign technician');
  await assignment
    .getByRole('combobox', { name: 'Technician', exact: true })
    .selectOption(technician.id);
  await assignment.getByLabel('Reason / work performed').fill('Assigned for screen diagnosis.');
  await submit(page, assignment.getByRole('button', { name: 'Save assignment' }), '/assignment');
  // Private photo upload uses multipart, CSRF and real image normalization.
  await page.getByRole('button', { name: 'Private photos', exact: true }).click();
  await page.getByLabel('Intake photo', { exact: true }).setInputFiles({
    name: 'device-intake.png',
    mimeType: 'image/png',
    buffer: await sharp({ create: { width: 640, height: 480, channels: 3, background: '#10483f' } })
      .png()
      .toBuffer(),
  });
  await submit(page, page.getByRole('button', { name: 'Upload private photo' }), '/photos');
  await expect(page.getByRole('img', { name: /Intake photo 1/ })).toBeVisible();
  const imageUrl = await page.getByRole('img', { name: /Intake photo 1/ }).getAttribute('src');
  const stranger = await browser.newContext();
  assert.equal((await stranger.request.get(`${base}${imageUrl}`)).status(), 401);
  const tech = await signIn(`${prefix}-technician@example.test`, 360);
  await tech.page.goto(`${base}/admin`);
  await expect(tech.page).toHaveURL(/\/admin\/repair\/jobs$/);
  await tech.page.getByRole('link', { name: new RegExp(number) }).click();
  await move(tech.page, 'DIAGNOSING');
  await tech.page
    .getByLabel('Diagnosis findings')
    .fill('Display and touch assembly damaged. Replacement required.');
  await submit(
    tech.page,
    tech.page.getByRole('button', { name: 'Save diagnosis', exact: true }),
    '/diagnosis',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Estimates & approval' }).click();
  await page.getByLabel('description · line 1').fill('Display and touch replacement');
  await page.getByLabel('Unit price ₹ · line 1').fill('2499.50');
  await page.getByLabel('Reason / work performed').fill('Repair quote after diagnosis.');
  await submit(
    page,
    page.getByRole('button', { name: 'Save new estimate revision' }),
    '/estimates',
  );
  const approval = form(page, 'Customer decision for estimate 1');
  await approval
    .getByRole('combobox', { name: 'How was the decision received?' })
    .selectOption('PHONE');
  await approval
    .getByLabel('Decision evidence / conversation details')
    .fill('Customer confirmed the complete quoted work by phone. Test fixture.');
  await approval.getByRole('checkbox').check();
  await submit(
    page,
    approval.getByRole('button', { name: 'Record customer decision' }),
    '/approval',
  );
  await tech.page.reload();
  await move(tech.page, 'REPAIRING');
  await move(tech.page, 'TESTING');
  const testing = form(tech.page, 'Testing checklist');
  for (const key of ['power', 'display', 'touch', 'charging', 'audio', 'cameras', 'connectivity'])
    await testing.getByRole('combobox', { name: key, exact: true }).selectOption('PASS');
  await submit(tech.page, testing.getByRole('button', { name: 'Save testing results' }), '/tests');
  await move(tech.page, 'READY');
  await tech.page.evaluate(() => scrollTo(0, 0));
  await tech.page.screenshot({
    path: resolve(evidence, 'live-technician-ready-360.png'),
    fullPage: true,
  });
  // Phase 6 handover requires a settled invoice. The dedicated billing smoke exercises its UI.
  const {
    RepairBillingService,
  } = require('../dist/modules/repair-billing/repair-billing.service.js');
  const billing = app.get(RepairBillingService);
  const billingOwner = await app.get(getModelToken('AdminUser')).findOne({ email }).orFail();
  const actor = {
    id: billingOwner.id,
    name: billingOwner.name,
    email: billingOwner.email,
    roles: billingOwner.roles,
  };
  let billingSettings = await billing.getSettings();
  if (!billingSettings.configured)
    billingSettings = await billing.saveSettings(
      {
        idempotencyKey: randomUUID(),
        expectedVersion: -1,
        issuer: {
          name: prefix,
          address: 'Acceptance workshop test address',
          phone: '+919876543210',
        },
        taxes: [],
        warrantyDays: 0,
        warrantyCoverage: 'No warranty in this test fixture',
        warrantyExclusions: 'Test fixture only',
      },
      actor,
    );
  const readyJob = await jobs.findOne({ number }).orFail();
  let bill = await billing.issue(
    number,
    {
      idempotencyKey: randomUUID(),
      expectedJobVersion: readyJob.get('version'),
      expectedSettingsVersion: billingSettings.version,
      estimateRevision: 1,
      lines: readyJob.estimates[0].lines.map((line) => ({
        kind: 'SERVICE',
        description: line.description,
        quantity: line.quantity,
        unitPriceInPaise: line.unitPriceInPaise,
      })),
      discountInPaise: 0,
      applyTax: false,
      expectedTotalInPaise: 249950,
      warrantyDays: 0,
      warrantyCoverage: 'No warranty in this test fixture',
      warrantyExclusions: 'Test fixture only',
      reason: 'Acceptance test invoice',
    },
    actor,
  );
  await billing.payment(
    number,
    {
      idempotencyKey: randomUUID(),
      expectedJobVersion: bill.jobVersion,
      amountInPaise: 249950,
      method: 'CASH',
      reason: 'Test payment received',
    },
    actor,
  );
  await page.reload();
  await move(page, 'DELIVERED', prefix);
  const saved = await jobs.findOne({ number }).orFail();
  assert.equal(saved.status, 'DELIVERED');
  assert.equal(saved.custody, 'RETURNED');
  assert.equal(saved.estimates[0].totalInPaise, 249950);
  assert.equal(saved.estimates[0].approval.decision, 'APPROVED');
  assert.equal(saved.tests.length, 7);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of [
      'Work & status',
      'Estimates & approval',
      'Private photos',
      'History & notes',
    ]) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${tab} overflows at ${width}`,
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: resolve(evidence, `live-${tab.split(' ')[0]}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('heading', { name: 'Device intake / job receipt' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Internal note' })).toBeHidden();
  await page.pdf({
    path: resolve(evidence, 'live-job-receipt.pdf'),
    format: 'A4',
    printBackground: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      realApi: true,
      realDatabase: true,
      widths: [360, 390, 768, 1440],
      assertions: [
        'owner creates technician',
        'booking conversion persists once',
        'private photo upload and access denial',
        'assigned technician access',
        'diagnosis',
        'integer-paise estimate and customer approval',
        'repair, seven tests, ready',
        'handover persists',
        'responsive job tabs',
        'private-note-free printed receipt',
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
  const jobs = app.get(getModelToken('RepairJob'));
  const rows = await jobs.find({ customerName: prefix });
  await app
    .get(getModelToken('RepairJobPhoto'))
    .deleteMany({ jobId: { $in: rows.map((row) => row._id) } });
  for (const name of ['RepairInvoice', 'RepairMoneyEntry', 'RepairWarranty'])
    await app.get(getModelToken(name)).deleteMany({ jobId: { $in: rows.map((row) => row._id) } });
  await app.get(getModelToken('RepairBillingSettings')).deleteMany({ 'issuer.name': prefix });
  await jobs.deleteMany({ customerName: prefix });
  await app.get(getModelToken('RepairBooking')).deleteMany({ customerName: prefix });
  const users = app.get(getModelToken('AdminUser'));
  const accounts = await users.find({ email: new RegExp(`^${prefix}-`) });
  await app
    .get(getModelToken('AuditLog'))
    .deleteMany({ actorId: { $in: accounts.map((user) => user._id) } });
  await app
    .get(getModelToken('AdminSession'))
    .deleteMany({ adminUserId: { $in: accounts.map((user) => user._id) } });
  await app
    .get(getModelToken('RepairBillingOperation'))
    .deleteMany({ actorId: { $in: accounts.map((user) => user._id) } });
  await users.deleteMany({ _id: { $in: accounts.map((user) => user._id) } });
  await app.close();
}
