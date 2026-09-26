// Real inventory acceptance on the isolated local test database only. Build both packages first.
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
  process.env.REPAIR_SMOKE_OUTPUT ?? '../.local/repair-inventory-browser-smoke',
);
await mkdir(evidence, { recursive: true });
const base = 'http://127.0.0.1:4175';
const prefix = `STOCK-UI-${randomUUID().slice(0, 8).toUpperCase()}`;
const password = randomUUID() + '-Inventory';
const email = `${prefix}@example.test`;
const app = await NestFactory.create(AppModule, { logger: false });
configureApplication(app);
let preview;
let browser;
const errors = [];
const model = (name) => app.get(getModelToken(name));
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
      if ((await fetch(`${base}/api/v1/repair/catalog`)).ok) break;
    } catch {
      /* Starting preview. */
    }
    if (attempt >= 60 || preview.exitCode !== null) throw new Error('Preview did not start');
    await delay(250);
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    reducedMotion: 'reduce',
  });
  const { csrfToken } = await (await context.request.get(`${base}/api/v1/admin/auth/csrf`)).json();
  const login = await context.request.post(`${base}/api/v1/admin/auth/login`, {
    headers: { 'X-CSRF-Token': csrfToken },
    data: { email, password },
  });
  assert.equal(login.status(), 200, await login.text());
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
    deviceLabel: 'Acceptance repair phone',
    issue: 'Screen cracked and flickering',
    condition: 'Front glass cracked',
    accessories: 'None',
  });
  async function change(action, data) {
    job = await post(`jobs/${job.number}/${action}`, { expectedVersion: job.version, ...data });
  }
  await change('transitions', { status: 'DIAGNOSING', reason: 'Inspect screen' });
  await change('diagnosis', { text: 'Display assembly requires replacement' });
  await change('estimates', {
    lines: [
      { description: 'Replacement display and labour', quantity: 1, unitPriceInPaise: 50000 },
    ],
    reason: 'Screen repair quote',
  });
  await change('approval', {
    revision: 1,
    decision: 'APPROVED',
    method: 'PHONE',
    customerName: prefix,
    evidence: 'Customer accepted screen repair quote on phone',
  });
  await change('transitions', { status: 'REPAIRING', reason: 'Begin approved repair' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  async function submit(form, buttonName, endpoint) {
    const responsePromise = page.waitForResponse(
      (r) => r.request().method() !== 'GET' && r.url().endsWith(endpoint),
    );
    await form.getByRole('button', { name: buttonName, exact: true }).click();
    const response = await responsePromise;
    assert.ok([200, 201].includes(response.status()), await response.text());
    await expect(page.getByText('Saved. Stock and job details refreshed.')).toBeVisible();
    return response.json();
  }
  await page.goto(`${base}/admin/repair/inventory?tab=suppliers`);
  await page.getByText('Add supplier', { exact: true }).first().click();
  let form = page.getByRole('form', { name: 'Add supplier', exact: true });
  await form.getByLabel('Supplier name').fill(prefix + ' supplier');
  await form.getByLabel('Supplier code').fill(prefix);
  const supplier = await submit(form, 'Save supplier', '/inventory/suppliers');
  await page.getByRole('button', { name: 'Spare parts', exact: true }).click();
  await page.getByRole('button', { name: 'Add spare part', exact: true }).click();
  form = page.getByRole('form', { name: 'Add spare part', exact: true });
  await form.getByLabel('Part name').fill(prefix + ' display');
  await form.getByLabel('SKU', { exact: true }).fill(prefix + '-DISPLAY');
  await form.getByLabel('Quality / grade').fill('Inspected premium');
  await form.getByRole('combobox', { name: 'Supplier', exact: true }).selectOption(supplier.id);
  await form.getByLabel('Storage bin').fill('A-1');
  await form.getByLabel('Customer price ₹', { exact: true }).fill('500');
  await form.getByLabel('Low stock threshold').fill('3');
  const part = await submit(form, 'Create part', '/inventory/parts');
  await page.getByRole('link', { name: prefix + ' display', exact: true }).click();
  form = page.getByRole('form', { name: 'Record stock change' });
  await form.getByRole('combobox', { name: 'Stock action' }).selectOption('OPENING');
  await form.getByLabel('Quantity', { exact: true }).fill('10');
  await form.getByLabel('Actual unit cost ₹ (optional)').fill('100');
  await form.getByLabel('Reason / reference').fill('Verified initial physical count');
  await submit(form, 'Record stock change', `/parts/${part.id}/adjustments`);
  await page.goto(`${base}/admin/repair/inventory?tab=purchases`);
  await page.getByText('New purchase order', { exact: true }).click();
  form = page.getByRole('form', { name: 'Create purchase order' });
  await form.getByRole('combobox', { name: 'Supplier', exact: true }).selectOption(supplier.id);
  await form.getByRole('combobox', { name: 'Part', exact: true }).selectOption(part.id);
  await form.getByLabel('Ordered quantity · line 1').fill('3');
  await form.getByLabel('Quoted unit cost ₹ · line 1').fill('190');
  await form.getByLabel('Purchase note').fill('Order three replacement displays');
  const purchase = await submit(form, 'Create purchase order', '/inventory/purchases');
  let stock = await model('InventoryLevel').findOne({ variantId: part.variantId });
  assert.equal(stock.onHand, 10);
  await page.getByRole('link', { name: purchase.number, exact: true }).click();
  form = page.getByRole('form', { name: 'Receive goods' });
  await form.getByLabel('Supplier invoice / delivery reference').fill(prefix + '-INV');
  await form.getByLabel('Received quantity · line 1').fill('2');
  await form.getByLabel('Actual unit cost ₹ · line 1').fill('200');
  await form.getByLabel('Receipt note').fill('Two inspected screens received');
  await submit(form, 'Record goods receipt', `/purchases/${purchase.id}/receipts`);
  assert.equal((await model('RepairPurchase').findById(purchase.id)).status, 'PARTIAL');
  assert.equal((await model('InventoryLevel').findOne({ variantId: part.variantId })).onHand, 12);
  await page.goto(`${base}/admin/repair/jobs/${job.number}`);
  await page.getByRole('button', { name: 'Parts & stock', exact: true }).click();
  form = page.getByRole('form', { name: 'Reserve a part', exact: true });
  await form.getByRole('combobox', { name: 'Part', exact: true }).selectOption(part.id);
  await form.getByLabel('Compatibility checked').fill('Model and connector verified');
  await form.getByLabel('Reason / reference').fill('Reserve for fitting');
  await submit(form, 'Reserve part', `/jobs/${job.number}/parts`);
  stock = await model('InventoryLevel').findOne({ variantId: part.variantId });
  assert.equal(stock.reserved, 1);
  assert.equal(stock.onHand, 12);
  const usage = await model('RepairPartUsage').findOne({ partId: part.id });
  const calls = [];
  let drop = true;
  await page.route(`**/api/v1/admin/repair/jobs/${job.number}/parts/${usage.id}`, async (route) => {
    calls.push(route.request().postDataJSON());
    if (drop) {
      drop = false;
      const response = await route.fetch();
      assert.equal(response.status(), 201, await response.text());
      await route.abort('failed');
    } else await route.continue();
  });
  form = page.getByRole('form', { name: `Use or release ${part.sku}`, exact: true });
  await form.getByRole('combobox', { name: 'Part action' }).selectOption('CONSUME');
  await form.getByLabel('Reason / reference').fill('Display fitted successfully');
  await form.getByRole('button', { name: 'Update reserved part' }).click();
  await expect(page.getByRole('button', { name: 'Retry saved request' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Parts & stock', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saved request' }).click();
  await expect(page.getByText('Saved. Stock and job details refreshed.')).toBeVisible();
  assert.deepEqual(calls[1], calls[0]);
  stock = await model('InventoryLevel').findOne({ variantId: part.variantId });
  assert.equal(stock.onHand, 11);
  assert.equal(stock.reserved, 0);
  assert.equal(stock.repairConsumed, 1);
  const used = await model('RepairPartUsage').findById(usage.id);
  assert.equal(used.allocations[0].unitCostInPaise, 10000);
  assert.equal(
    await model('InventoryMovement').countDocuments({
      partId: part.id,
      referenceType: 'REPAIR_CONSUME',
    }),
    1,
  );
  assert.equal(
    (await model('RepairJob').findOne({ number: job.number })).estimates[0].totalInPaise,
    50000,
  );
  form = page.getByRole('form', { name: `Return ${part.sku}`, exact: true });
  await form.getByRole('combobox', { name: 'Return condition' }).selectOption('RETURN_USABLE');
  await form.getByLabel('Reason / reference').fill('Removed intact and inspected reusable');
  await submit(form, 'Record part return', `/jobs/${job.number}/parts/${usage.id}`);
  assert.equal((await model('InventoryLevel').findOne({ variantId: part.variantId })).onHand, 12);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, path] of [
      ['job-parts', `/admin/repair/jobs/${job.number}`],
      ['parts', '/admin/repair/inventory'],
      ['part', `/admin/repair/inventory/parts/${part.id}`],
      ['purchase', `/admin/repair/inventory/purchases/${purchase.id}`],
      ['movements', `/admin/repair/inventory?tab=movements&partId=${part.id}`],
    ]) {
      await page.goto(base + path);
      if (label === 'job-parts')
        await page.getByRole('button', { name: 'Parts & stock', exact: true }).click();
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
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      realApi: true,
      realDatabase: true,
      widths: [360, 390, 768, 1440],
      assertions: [
        'supplier and spare part creation',
        'opening stock',
        'purchase has no stock effect',
        'partial receipt at actual cost',
        'job reservation',
        'FIFO consumption',
        'lost committed response replayed exactly once after reload',
        'original estimate preserved',
        'usable return restores stock',
        'responsive inventory and movement history',
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
  const users = await model('AdminUser').find({ email: email.toLowerCase() });
  const actorIds = users.map((u) => u._id);
  const parts = await model('SparePartProfile').find({ sku: new RegExp('^' + prefix) });
  const partIds = parts.map((p) => p._id);
  const jobs = await model('RepairJob').find({ customerName: prefix });
  const jobIds = jobs.map((j) => j._id);
  const purchases = await model('RepairPurchase').find({ createdBy: { $in: actorIds } });
  for (const name of ['RepairStockLot', 'RepairPartUsage', 'InventoryMovement'])
    await model(name).deleteMany({ partId: { $in: partIds } });
  await model('InventoryReservation').deleteMany({ repairJobId: { $in: jobIds } });
  await model('InventoryLevel').deleteMany({ variantId: { $in: parts.map((p) => p.variantId) } });
  await model('Product').deleteMany({ _id: { $in: parts.map((p) => p.productId) } });
  await model('SparePartProfile').deleteMany({ _id: { $in: partIds } });
  await model('RepairSupplier').deleteMany({ code: prefix });
  await model('RepairGoodsReceipt').deleteMany({
    purchaseId: { $in: purchases.map((p) => p._id) },
  });
  await model('RepairPurchase').deleteMany({ _id: { $in: purchases.map((p) => p._id) } });
  await model('RepairStockOperation').deleteMany({ actorId: { $in: actorIds } });
  await model('RepairJob').deleteMany({ _id: { $in: jobIds } });
  await model('AuditLog').deleteMany({ actorId: { $in: actorIds } });
  await model('AdminSession').deleteMany({ adminUserId: { $in: actorIds } });
  await model('AdminUser').deleteMany({ _id: { $in: actorIds } });
  await app.close();
}
