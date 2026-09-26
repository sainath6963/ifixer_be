// Local acceptance test: uses only test/setup-env.ts's isolated database.
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
const frontend = resolve(import.meta.dirname, '../../frontend');
const evidence = resolve(process.env.REPAIR_SMOKE_OUTPUT ?? '../.local/repair-browser-smoke');
await mkdir(evidence, { recursive: true });
const prefix = `repair-ui-${randomUUID().slice(0, 8)}`;
const email = `${prefix}@example.test`;
const password = `${randomUUID()}-Repair`;
const app = await NestFactory.create(AppModule, { logger: false });
configureApplication(app);
let preview;
let browser;
let owner;
const catalogIds = { DeviceBrand: [], DeviceModel: [], RepairService: [], RepairServiceOption: [] };
const bookingRefs = [];
try {
  await app.listen(4001, '127.0.0.1');
  owner = await app.get(getModelToken('AdminUser')).create({
    name: 'Repair Browser Staff',
    email,
    passwordHash: await app.get(PasswordService).hash(password),
    roles: ['STAFF'],
    status: 'ACTIVE',
  });
  preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', '4175', '--strictPort'],
    {
      cwd: frontend,
      env: { ...process.env, VITE_DEV_API_TARGET: 'http://127.0.0.1:4001' },
      stdio: 'ignore',
    },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:4175/api/v1/repair/catalog')).ok) break;
    } catch {
      /* Wait for the local preview. */
    }
    if (attempt >= 60 || preview.exitCode !== null)
      throw new Error('The local API proxy did not become ready');
    await delay(250);
  }
  browser = await chromium.launch();
  const staff = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const customer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const adminPage = await staff.newPage();
  const page = await customer.newPage();
  adminPage.on('pageerror', (error) => errors.push(error.message));
  page.on('pageerror', (error) => errors.push(error.message));
  // Real authentication and catalog API calls; no intercepted responses.
  const csrfResponse = await staff.request.get('http://127.0.0.1:4175/api/v1/admin/auth/csrf');
  const { csrfToken } = await csrfResponse.json();
  const auth = await staff.request.post('http://127.0.0.1:4175/api/v1/admin/auth/login', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: { email, password },
  });
  assert.equal(auth.status(), 200);
  async function createEntry(kind, model, data) {
    const response = await staff.request.post(
      `http://127.0.0.1:4175/api/v1/admin/repair/catalog/${kind}`,
      { headers: { 'X-CSRF-Token': csrfToken }, data },
    );
    assert.equal(response.status(), 201, await response.text());
    const { entry } = await response.json();
    catalogIds[model].push(entry.id);
    return entry;
  }
  const brand = await createEntry('brands', 'DeviceBrand', {
    name: 'Acceptance test brand',
    slug: prefix,
    active: true,
  });
  const model = await createEntry('models', 'DeviceModel', {
    name: 'Acceptance test phone',
    slug: prefix,
    brandId: brand.id,
    active: true,
  });
  const service = await createEntry('services', 'RepairService', {
    name: 'Acceptance screen repair',
    slug: prefix,
    description: 'Temporary acceptance test service.',
    active: true,
    pricingMode: 'DIAGNOSIS',
  });
  await createEntry('options', 'RepairServiceOption', {
    modelId: model.id,
    serviceId: service.id,
    active: true,
    pricingMode: 'INDICATIVE',
    priceInPaise: 159950,
  });
  await page.goto('http://127.0.0.1:4175/book-repair');
  await page.getByRole('combobox', { name: 'Brand', exact: true }).selectOption(brand.id);
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model.id);
  await page
    .getByRole('combobox', { name: 'Repair service', exact: true })
    .selectOption(service.id);
  await page
    .getByLabel('What’s happening with your phone?')
    .fill('The screen flickers after a fall. Acceptance test only.');
  await page.getByLabel('Your name', { exact: true }).fill(prefix);
  await page.getByLabel('Phone with country code').fill('+919876543210');
  await page.getByRole('button', { name: 'Request a repair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your next step is on its way.' })).toBeVisible();
  const accessCode = await page.getByLabel('Private access code').inputValue();
  await page.getByRole('link', { name: 'View booking' }).click();
  await expect(page).toHaveURL(/\/book-repair\/IFX-[A-F0-9]{16}$/);
  const reference = page.url().split('/').pop();
  bookingRefs.push(reference);
  await expect(page.getByRole('heading', { name: 'Booking details' })).toBeVisible();
  const modelBookings = app.get(getModelToken('RepairBooking'));
  const saved = await modelBookings.findOne({ reference }).orFail();
  assert.equal(saved.status, 'REQUESTED');
  assert.equal(saved.indicativePriceInPaise, 159950);
  assert.equal(await modelBookings.countDocuments({ customerName: prefix }), 1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(evidence, 'live-customer-request.png'), fullPage: true });
  await adminPage.goto(`http://127.0.0.1:4175/admin/repair/bookings?search=${reference}`);
  await expect(adminPage.getByRole('link', { name: `Open ${reference}` })).toBeVisible();
  await adminPage.getByRole('link', { name: `Open ${reference}` }).click();
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) + 'T14:30';
  await adminPage.getByLabel('New visit time (IST)').fill(future);
  await adminPage
    .getByLabel('Reason (visible to customer)')
    .fill('Appointment agreed with the customer.');
  await adminPage.getByRole('button', { name: 'Save visit update' }).click();
  await expect(adminPage.getByText('Booking updated.')).toBeVisible();
  await adminPage.evaluate(() => scrollTo(0, 0));
  await adminPage.screenshot({
    path: resolve(evidence, 'live-admin-confirmation.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByText('CONFIRMED', { exact: true }).first()).toBeVisible();
  const stranger = await browser.newContext();
  const denied = await stranger.request.get(
    `http://127.0.0.1:4175/api/v1/repair/bookings/${reference}`,
  );
  assert.equal(denied.status(), 404);
  assert.match(accessCode, /^[a-f0-9]{64}$/);
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('CANCEL');
  await page
    .getByLabel('Reason (visible to customer)')
    .fill('Acceptance test complete; cancel this request.');
  await page.getByRole('button', { name: 'Cancel this booking' }).click();
  await expect(page.getByText('CANCELLED', { exact: true }).first()).toBeVisible();
  const final = await modelBookings.findOne({ reference }).orFail();
  assert.equal(final.status, 'CANCELLED');
  assert.equal(final.history.length, 3);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      realApi: true,
      realDatabase: true,
      mobileWidth: 390,
      assertions: [
        'catalog compatibility',
        'mobile submission persists once',
        'staff queue',
        'staff confirmation',
        'customer sees confirmation',
        'reference alone denied',
        'customer cancellation persists',
      ],
      screenshotDirectory: evidence,
    }),
  );
} finally {
  await browser?.close();
  if (preview && preview.exitCode === null) {
    const stopped = new Promise((resolve) => preview.once('exit', resolve));
    preview.kill('SIGTERM');
    await stopped;
  }
  const modelBookings = app.get(getModelToken('RepairBooking'));
  const rows = await modelBookings.find({ customerName: prefix });
  const resources = [...rows.map((row) => row.id), ...Object.values(catalogIds).flat()];
  await modelBookings.deleteMany({ customerName: prefix });
  await app.get(getModelToken('AuditLog')).deleteMany({
    $or: [{ resourceId: { $in: resources } }, ...(owner ? [{ actorId: owner._id }] : [])],
  });
  for (const [model, ids] of Object.entries(catalogIds))
    if (ids.length) await app.get(getModelToken(model)).deleteMany({ _id: { $in: ids } });
  if (owner) {
    await app.get(getModelToken('AdminSession')).deleteMany({ adminUserId: owner._id });
    await app.get(getModelToken('AdminUser')).deleteOne({ _id: owner._id });
  }
  await app.close();
}
