// Local real-API acceptance only. Build both packages and migrate the isolated test database first.
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
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test');
const evidence = resolve(
  process.env.REPAIR_SMOKE_OUTPUT ?? '../.local/repair-billing-browser-smoke',
);
await mkdir(evidence, { recursive: true });
const base = 'http://127.0.0.1:4175';
const prefix = `BILL-UI-${randomUUID().slice(0, 8)}`;
const email = `${prefix}@example.test`;
const password = randomUUID() + '-Billing';
const app = await NestFactory.create(AppModule, { logger: false });
configureApplication(app);
const model = (name) => app.get(getModelToken(name));
let preview;
let browser;
let oldSettings;
const errors = [];
try {
  await app.listen(4001, '127.0.0.1');
  oldSettings = await model('RepairBillingSettings').findOne({ key: 'SHOP' }).lean();
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
      if ((await fetch(`${base}/api/v1/repair/catalog`)).ok) break;
    } catch {
      /* Starting preview. */
    }
    if (attempt >= 60 || preview.exitCode !== null) throw new Error('Preview failed to start');
    await delay(250);
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    reducedMotion: 'reduce',
  });
  const { csrfToken } = await (await context.request.get(`${base}/api/v1/admin/auth/csrf`)).json();
  const signed = await context.request.post(`${base}/api/v1/admin/auth/login`, {
    headers: { 'X-CSRF-Token': csrfToken },
    data: { email, password },
  });
  assert.equal(signed.status(), 200, await signed.text());
  async function post(path, data) {
    const response = await context.request.post(`${base}/api/v1/admin/repair/${path}`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data,
    });
    assert.equal(response.status(), 201, await response.text());
    return response.json();
  }
  let job = await post('jobs', {
    idempotencyKey: randomUUID(),
    customerName: prefix,
    phone: '+919876543210',
    deviceLabel: 'Billing acceptance phone',
    issue: 'Screen cracked and needs replacement',
    condition: 'Cracked front glass',
    accessories: 'Case only',
  });
  async function change(action, data) {
    job = await post(`jobs/${job.number}/${action}`, { expectedVersion: job.version, ...data });
  }
  await change('transitions', { status: 'DIAGNOSING', reason: 'Inspect phone' });
  await change('diagnosis', { text: 'Display assembly needs replacement' });
  await change('estimates', {
    lines: [{ description: 'Repair including taxes', quantity: 1, unitPriceInPaise: 200000 }],
    reason: 'Final total quoted',
  });
  await change('approval', {
    revision: 1,
    decision: 'APPROVED',
    method: 'PHONE',
    customerName: prefix,
    evidence: 'Customer confirmed maximum total on phone',
  });
  for (const status of ['REPAIRING', 'TESTING'])
    await change('transitions', { status, reason: 'Approved repair completed' });
  await change('tests', {
    tests: ['power', 'display', 'touch', 'charging', 'audio', 'cameras', 'connectivity'].map(
      (key) => ({ key, result: 'PASS' }),
    ),
  });
  await change('transitions', { status: 'READY', reason: 'All checks passed' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const form = (name) => page.getByRole('form', { name, exact: true });
  async function submit(section, button, endpoint) {
    const responsePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(endpoint),
    );
    await section.getByRole('button', { name: button, exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, await response.text());
    await expect(page.getByText('Saved. Billing and job details refreshed.')).toBeVisible();
    return response.json();
  }
  async function billing() {
    const response = await context.request.get(
      `${base}/api/v1/admin/repair/jobs/${job.number}/billing`,
    );
    assert.equal(response.status(), 200);
    return response.json();
  }
  await page.goto(`${base}/admin/repair/billing`);
  await page.getByRole('button', { name: 'Billing settings', exact: true }).click();
  let section = form('Shop billing settings');
  await section.getByLabel('Invoice business name').fill(prefix);
  await section.getByLabel('Business address').fill('Acceptance workshop, test address');
  await section.getByLabel('Business phone').fill('+919876543210');
  // An isolated test database may retain settings from another acceptance run.
  while (await section.getByRole('button', { name: /Remove tax/ }).count())
    await section
      .getByRole('button', { name: /Remove tax/ })
      .first()
      .click();
  await section.getByRole('button', { name: 'Add tax component' }).click();
  await section.getByLabel('Tax label 1').fill('Configured test tax');
  await section.getByLabel('Tax rate % 1').fill('10');
  await section.getByLabel('Warranty days').fill('30');
  await section
    .getByLabel('Warranty coverage', { exact: true })
    .fill('Replacement screen workmanship');
  await section
    .getByLabel('Warranty exclusions / conditions')
    .fill('Physical damage or liquid damage excluded');
  await submit(section, 'Save billing settings', '/billing/settings');
  await page.goto(`${base}/admin/repair/jobs/${job.number}?tab=billing`);
  section = form('Record advance');
  await section.getByLabel('Amount received ₹').fill('100');
  await section
    .getByLabel('Receipt note (shown to customer)')
    .fill('Cash advance received at counter');
  await section.getByRole('checkbox').check();
  let bill = await submit(
    section,
    'Record received payment',
    `/jobs/${job.number}/billing/payments`,
  );
  const advance = bill.entries[0];
  assert.equal(bill.summary.advanceInPaise, 10000);
  section = form('Issue repair invoice');
  await section.getByLabel('Unit price ₹ · line 1').fill('1000');
  await section.getByRole('combobox', { name: 'Line type', exact: true }).selectOption('PART');
  await section.getByRole('button', { name: 'Add invoice line' }).click();
  await section
    .getByRole('combobox', { name: 'Line type', exact: true })
    .nth(1)
    .selectOption('LABOUR');
  await section.getByLabel('description · line 2').fill('Fitting and testing');
  await section.getByLabel('Unit price ₹ · line 2').fill('100');
  await section.getByLabel('Discount ₹').fill('100');
  await section.getByLabel('Invoice issue note (internal)').fill('Final customer charges checked');
  await section.getByRole('checkbox').last().check();
  bill = await submit(section, 'Issue immutable invoice', `/jobs/${job.number}/billing/invoice`);
  assert.equal(bill.invoice.totalInPaise, 110000);
  assert.equal(bill.summary.dueInPaise, 100000);
  const invoiceNumber = bill.invoice.number;
  const calls = [];
  await page.route(`**/api/v1/admin/repair/jobs/${job.number}/billing/payments`, async (route) => {
    calls.push(route.request().postDataJSON());
    if (calls.length === 1) {
      const response = await route.fetch();
      assert.equal(response.status(), 201, await response.text());
      await route.abort('failed');
    } else if (calls.length === 2)
      await route.fulfill({ status: 429, json: { message: 'Simulated throttled retry' } });
    else await route.continue();
  });
  section = form('Record payment');
  await section.getByLabel('Amount received ₹').fill('900');
  await section.getByRole('combobox', { name: 'Payment method' }).selectOption('UPI');
  await section.getByLabel('Transaction reference').fill(prefix + '-UPI');
  await section
    .getByLabel('Receipt note (shown to customer)')
    .fill('UPI payment checked in bank account');
  await section.getByRole('checkbox').check();
  await section.getByRole('button', { name: 'Record received payment' }).click();
  await expect(page.getByRole('button', { name: 'Retry saved request' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Retry saved request' }).click();
  await expect(page.getByRole('alert')).toContainText('Simulated throttled retry');
  await page.getByRole('button', { name: 'Retry saved request' }).click();
  await expect(page.getByText('Saved. Billing and job details refreshed.')).toBeVisible();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], calls[2]);
  bill = await billing();
  assert.equal(bill.entries.filter((entry) => entry.kind === 'PAYMENT').length, 2);
  assert.equal(bill.summary.netPaidInPaise, 100000);
  assert.equal(bill.summary.dueInPaise, 10000);
  section = form('Owner delivery authorization');
  await section
    .getByLabel('Reason / reference')
    .fill('Owner authorizes customer balance collection later');
  await section.getByRole('checkbox').check();
  await submit(
    section,
    'Authorize delivery with balance due',
    `/jobs/${job.number}/billing/delivery-authorization`,
  );
  await page.getByRole('button', { name: 'Work & status', exact: true }).click();
  section = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Update repair status', exact: true }) });
  await section.getByRole('combobox', { name: 'Next status' }).selectOption('DELIVERED');
  await section
    .getByLabel('Reason / work performed')
    .fill('Device collected with owner balance authorization');
  await section.getByLabel('Collected by (required for delivery)').fill(prefix);
  const delivered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/transitions'),
  );
  await section.getByRole('button', { name: 'Update status', exact: true }).click();
  assert.equal((await delivered).status(), 201);
  await expect(page.locator('.repair-job-state .repair-status')).toHaveText('delivered');
  await page.getByRole('button', { name: 'Billing & warranty', exact: true }).click();
  bill = await billing();
  assert.equal(bill.warranty.active, true);
  assert.equal(
    Date.parse(bill.warranty.endsAt) - Date.parse(bill.warranty.startsAt),
    30 * 86400000,
  );
  await page.getByText('Reduce charges with a credit note', { exact: true }).click();
  section = form('Issue credit note');
  await section.getByLabel('Charge reduction ₹').fill('200');
  await section
    .getByLabel('Credit reason (shown to customer)')
    .fill('Owner goodwill reduction agreed');
  bill = await submit(section, 'Issue credit note', `/jobs/${job.number}/billing/credits`);
  assert.equal(bill.summary.refundDueInPaise, 10000);
  await page.getByText('Record money returned', { exact: true }).click();
  section = form('Record refund');
  await section.getByRole('combobox', { name: 'Original payment' }).selectOption(advance.id);
  await section.getByLabel('Amount returned ₹').fill('100');
  await section
    .getByLabel('Receipt note (shown to customer)')
    .fill('Cash advance returned after credit');
  await section.getByRole('checkbox').check();
  bill = await submit(section, 'Record paid refund', `/jobs/${job.number}/billing/refunds`);
  assert.equal(bill.summary.dueInPaise, 0);
  assert.equal(bill.summary.refundDueInPaise, 0);
  assert.equal(bill.summary.netPaidInPaise, 90000);
  const refund = bill.entries.find((entry) => entry.kind === 'REFUND');
  assert.equal(refund.paymentNumber, advance.number);
  await page.getByText('Receive a warranty follow-up', { exact: true }).click();
  section = form('Warranty follow-up intake');
  await section
    .getByLabel('Follow-up issue')
    .fill('Screen touch is intermittently unresponsive again');
  await section.getByLabel('Received condition').fill('No visible new damage');
  await section.getByLabel('Accessories received').fill('Case only');
  bill = await submit(
    section,
    'Create linked follow-up job',
    `/jobs/${job.number}/billing/followups`,
  );
  assert.equal(bill.followups.length, 1);
  const child = await model('RepairJob').findOne({ number: bill.followups[0].number });
  assert.equal(child.warrantySourceInvoiceNumber, invoiceNumber);
  assert.equal(child.status, 'RECEIVED');
  assert.equal(child.estimates.length, 0);
  // Changing current settings must not rewrite the issued document.
  await page.goto(`${base}/admin/repair/billing`);
  await page.getByRole('button', { name: 'Billing settings', exact: true }).click();
  section = form('Shop billing settings');
  await section.getByLabel('Warranty days').fill('90');
  await submit(section, 'Save billing settings', '/billing/settings');
  assert.equal((await billing()).invoice.warrantyDays, 30);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, path] of [
      ['billing', `/admin/repair/jobs/${job.number}?tab=billing`],
      ['invoices', '/admin/repair/billing'],
      ['invoice', `/admin/repair/jobs/${job.number}/billing/print`],
      ['refund', `/admin/repair/jobs/${job.number}/billing/print?receipt=${refund.id}`],
    ]) {
      await page.goto(base + path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${label} overflows at ${width}`,
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: resolve(evidence, `live-${label}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  await page.goto(`${base}/admin/repair/jobs/${job.number}/billing/print`);
  await expect(page.getByRole('heading', { name: 'Repair invoice', exact: true })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: resolve(evidence, 'repair-invoice.pdf'),
    format: 'A4',
    printBackground: true,
  });
  await expect(page.getByRole('navigation', { name: 'Admin navigation' })).toBeHidden();
  await page.goto(`${base}/admin/repair/jobs/${job.number}/billing/print?receipt=${refund.id}`);
  await expect(page.getByRole('heading', { name: 'Refund receipt', exact: true })).toBeVisible();
  await page.pdf({
    path: resolve(evidence, 'refund-receipt.pdf'),
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
        'owner edits tax and warranty settings',
        'advance allocated once',
        'invoice parts/labour/discount/tax arithmetic',
        'UPI committed response lost and exact replay after reload/throttling',
        'owner authorizes unpaid delivery',
        'warranty activates at handover',
        'credit and explicit refund settle customer balance',
        'linked warranty intake',
        'old invoice terms preserved after settings change',
        'responsive billing and private PDF documents',
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
  const jobs = await model('RepairJob').find({ customerName: prefix });
  const ids = jobs.map((job) => job._id);
  const actors = await model('AdminUser').find({ email: email.toLowerCase() });
  const actorIds = actors.map((user) => user._id);
  for (const name of ['RepairInvoice', 'RepairMoneyEntry', 'RepairWarranty'])
    await model(name).deleteMany({ jobId: { $in: ids } });
  await model('RepairJob').deleteMany({ _id: { $in: ids } });
  for (const name of ['RepairBillingOperation', 'AuditLog'])
    await model(name).deleteMany({ actorId: { $in: actorIds } });
  await model('AdminSession').deleteMany({ adminUserId: { $in: actorIds } });
  await model('AdminUser').deleteMany({ _id: { $in: actorIds } });
  if (oldSettings)
    await model('RepairBillingSettings').collection.replaceOne({ key: 'SHOP' }, oldSettings);
  else await model('RepairBillingSettings').deleteMany({ 'issuer.name': prefix });
  await app.close();
}
