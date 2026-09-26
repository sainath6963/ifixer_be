import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { repairInventoryMigration } from '../src/database/migrations/025-repair-inventory';
import { AdminUser } from '../src/database/schemas/identity.schema';
import { AccountStatus, AdminRole } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import type { RepairJobView } from '../src/modules/repair-jobs/repair-job.service';
import { CheckoutService } from '../src/modules/checkout/checkout.service';
import { ReturnRequestService } from '../src/modules/returns/return-request.service';
interface Actor {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: string;
}
interface Part {
  id: string;
  version: number;
  sku: string;
  productId: string;
  variantId: string;
  stock: {
    version: number;
    onHand: number;
    reserved: number;
    available: number;
    repairConsumed: number;
  };
}
interface Purchase {
  id: string;
  version: number;
  status: string;
  lines: Array<{ received: number }>;
  receipts: Array<{ id: string }>;
}
interface Usage {
  id: string;
  status: string;
  costInPaise?: number;
  unknownCostQuantity?: number;
  returnedUsable: number;
  returnedDamaged: number;
  allocations?: Array<{ quantity: number; unitCostInPaise?: number }>;
}
interface JobParts {
  jobVersion: number;
  items: Usage[];
}
const result = <T>(response: request.Response): T => response.body as T;
describe('Repair inventory and purchasing (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let connection: Connection;
  let users: Model<AdminUser>;
  let owner: Actor;
  let reception: Actor;
  let technician: Actor;
  let otherTech: Actor;
  const prefix = `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
  const password = 'Inventory-test-password-123';
  const root = '/api/v1/admin/repair/';
  const partBody = (): Record<string, unknown> => ({
    idempotencyKey: randomUUID(),
    sku: `${prefix}-${randomUUID().slice(0, 8)}`,
    name: `${prefix} display`,
    quality: 'Test premium',
    modelIds: [],
    customerPriceInPaise: 50000,
    referenceCostInPaise: 19000,
    reorderPoint: 2,
    active: true,
  });
  const post = (path: string, body: Record<string, unknown>, actor = owner): request.Test =>
    actor.agent
      .post(root + path)
      .set('x-csrf-token', actor.csrf)
      .send(body);
  const operation = (path: string, body: Record<string, unknown>, actor = owner): request.Test =>
    post(path, { idempotencyKey: randomUUID(), ...body }, actor);
  const getPart = async (id: string): Promise<Part> =>
    result<Part>(await owner.agent.get(`${root}inventory/parts/${id}`).expect(200));
  const createPart = async (quantity = 0, cost?: number): Promise<Part> => {
    let part = result<Part>(await post('inventory/parts', partBody()).expect(201));
    if (quantity)
      part = result<Part>(
        await operation(`inventory/parts/${part.id}/adjustments`, {
          expectedVersion: part.stock.version,
          action: 'OPENING',
          quantity,
          unitCostInPaise: cost,
          reason: 'Verified physical opening count',
        }).expect(201),
      );
    return part;
  };
  const getJob = async (number: string): Promise<RepairJobView> =>
    result<RepairJobView>(await owner.agent.get(root + 'jobs/' + number).expect(200));
  const change = (
    job: RepairJobView,
    action: string,
    body: Record<string, unknown>,
  ): request.Test =>
    post(`jobs/${job.number}/${action}`, { expectedVersion: job.version, ...body });
  const approvedJob = async (): Promise<RepairJobView> => {
    let job = result<RepairJobView>(
      await operation('jobs', {
        customerName: prefix,
        phone: '+919876543210',
        deviceLabel: 'Test phone',
        issue: 'Display flickering and broken',
        condition: 'Screen cracked',
        accessories: 'No accessories',
      }).expect(201),
    );
    job = result<RepairJobView>(
      await change(job, 'transitions', { status: 'DIAGNOSING', reason: 'Testing display' }).expect(
        201,
      ),
    );
    job = result<RepairJobView>(
      await change(job, 'diagnosis', { text: 'Replacement display needed' }).expect(201),
    );
    job = result<RepairJobView>(
      await change(job, 'estimates', {
        lines: [{ description: 'Display and labour', quantity: 1, unitPriceInPaise: 50000 }],
        reason: 'Initial estimate',
      }).expect(201),
    );
    job = result<RepairJobView>(
      await change(job, 'approval', {
        revision: 1,
        decision: 'APPROVED',
        method: 'PHONE',
        customerName: 'Test customer',
        evidence: 'Customer agreed to repair charges on phone',
      }).expect(201),
    );
    return result<RepairJobView>(
      await change(job, 'transitions', {
        status: 'REPAIRING',
        reason: 'Approved repair work',
      }).expect(201),
    );
  };
  const reserve = async (job: RepairJobView, part: Part, quantity = 1): Promise<JobParts> =>
    result<JobParts>(
      await operation(`jobs/${job.number}/parts`, {
        expectedJobVersion: job.version,
        partId: part.id,
        quantity,
        compatibilityNote: 'Model and connector checked',
        reason: 'Held for repair',
      }).expect(201),
    );
  const use = (
    job: RepairJobView,
    usage: Usage,
    body: Record<string, unknown>,
    actor = owner,
  ): request.Test =>
    operation(
      `jobs/${job.number}/parts/${usage.id}`,
      { expectedJobVersion: job.version, reason: 'Workshop parts operation', ...body },
      actor,
    );
  const supplier = async (): Promise<{ id: string; version: number }> =>
    result(
      await operation('inventory/suppliers', {
        name: `${prefix} supplier`,
        code: `${prefix}-${randomUUID().slice(0, 6)}`,
        active: true,
      }).expect(201),
    );
  const order = async (part: Part, quantity = 3): Promise<Purchase> =>
    result(
      await operation('inventory/purchases', {
        supplierId: (await supplier()).id,
        lines: [{ partId: part.id, quantity, unitCostInPaise: 25000 }],
        note: 'Test purchase order',
      }).expect(201),
    );
  const login = async (role: AdminRole): Promise<Actor> => {
    const email = `${prefix}-${randomUUID().slice(0, 6)}@example.test`;
    await users.create({
      name: `${prefix} ${role}`,
      email,
      passwordHash: await app.get(PasswordService).hash(password),
      roles: [role],
      status: AccountStatus.Active,
    });
    const agent = request.agent(server);
    const csrf = result<{ csrfToken: string }>(
      await agent.get('/api/v1/admin/auth/csrf'),
    ).csrfToken;
    const response = await agent
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    return { agent, csrf, id: result<{ admin: { id: string } }>(response).admin.id };
  };
  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule, MigrationModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60000,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    const express = fixture.createNestApplication<NestExpressApplication>();
    configureApplication(express);
    await express.listen(0, '127.0.0.1');
    app = express;
    server = app.getHttpServer() as Server;
    connection = app.get(getConnectionToken());
    users = app.get(getModelToken(AdminUser.name));
    await app.get(MigrationRunner).run();
    owner = await login(AdminRole.Owner);
    reception = await login(AdminRole.Reception);
    technician = await login(AdminRole.Technician);
    otherTech = await login(AdminRole.Technician);
  }, 60000);
  afterAll(async () => {
    if (!app) return;
    if (connection.db) {
      const db = connection.db;
      const parts = await db
        .collection('spare_part_profiles')
        .find({ sku: new RegExp('^' + prefix) })
        .toArray();
      const partIds = parts.map((p) => p._id);
      const accounts = await users.find({ name: new RegExp('^' + prefix) });
      const actorIds = accounts.map((a) => a._id);
      const jobs = await db.collection('repair_jobs').find({ customerName: prefix }).toArray();
      const jobIds = jobs.map((j) => j._id);
      const purchases = await db
        .collection('repair_purchases')
        .find({ createdBy: { $in: actorIds } })
        .toArray();
      for (const name of ['repair_stock_lots', 'repair_part_usages', 'inventory_movements'])
        await db.collection(name).deleteMany({ partId: { $in: partIds } });
      await db.collection('inventory_reservations').deleteMany({ repairJobId: { $in: jobIds } });
      await db
        .collection('inventory_levels')
        .deleteMany({ variantId: { $in: parts.map((p) => p.variantId as Types.ObjectId) } });
      await db
        .collection('products')
        .deleteMany({ _id: { $in: parts.map((p) => p.productId as Types.ObjectId) } });
      await db.collection('spare_part_profiles').deleteMany({ _id: { $in: partIds } });
      await db.collection('device_models').deleteMany({ name: new RegExp('^' + prefix) });
      await db.collection('device_brands').deleteMany({ name: prefix });
      await db.collection('repair_suppliers').deleteMany({ name: new RegExp('^' + prefix) });
      await db
        .collection('repair_goods_receipts')
        .deleteMany({ purchaseId: { $in: purchases.map((p) => p._id) } });
      await db
        .collection('repair_purchases')
        .deleteMany({ _id: { $in: purchases.map((p) => p._id) } });
      await db.collection('repair_stock_operations').deleteMany({ actorId: { $in: actorIds } });
      await db.collection('repair_jobs').deleteMany({ _id: { $in: jobIds } });
      await db.collection('admin_sessions').deleteMany({ adminUserId: { $in: actorIds } });
      await db.collection('audit_logs').deleteMany({ actorId: { $in: actorIds } });
      await users.deleteMany({ _id: { $in: actorIds } });
    }
    await app.close();
  });
  it('reserves 1 of 10 without reducing on hand, consumes once and keeps actual cost immutable', async () => {
    let part = await createPart(10, 12000);
    let job = await approvedJob();
    const held = await reserve(job, part);
    expect((await getPart(part.id)).stock).toMatchObject({ onHand: 10, reserved: 1, available: 9 });
    job = await getJob(job.number);
    const body = {
      idempotencyKey: randomUUID(),
      expectedJobVersion: job.version,
      action: 'CONSUME',
      reason: 'Display fitted successfully',
    };
    const responses = await Promise.all([
      post(`jobs/${job.number}/parts/${held.items[0].id}`, body),
      post(`jobs/${job.number}/parts/${held.items[0].id}`, body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(result<JobParts>(responses[0]).items[0]).toMatchObject({
      status: 'CONSUMED',
      costInPaise: 12000,
      unknownCostQuantity: 0,
    });
    part = await getPart(part.id);
    expect(part.stock).toMatchObject({ onHand: 9, reserved: 0, available: 9, repairConsumed: 1 });
    await operation(`inventory/parts/${part.id}/adjustments`, {
      expectedVersion: part.stock.version,
      action: 'ADJUST_IN',
      quantity: 2,
      unitCostInPaise: 99000,
      reason: 'New stock at different cost',
    }).expect(201);
    expect(
      result<JobParts>(await owner.agent.get(root + `jobs/${job.number}/parts`)).items[0]
        .costInPaise,
    ).toBe(12000);
    expect((await getJob(job.number)).estimates[0].totalInPaise).toBe(50000);
    await post(`jobs/${job.number}/parts/${held.items[0].id}`, {
      ...body,
      reason: 'Changed retry payload',
    }).expect(409);
  });
  it('releases unused parts on cancellation but never restores consumed parts automatically', async () => {
    const part = await createPart(10, 100);
    let job = await approvedJob();
    await reserve(job, part, 2);
    job = await getJob(job.number);
    const held = await reserve(job, part, 1);
    job = await getJob(job.number);
    await use(job, held.items[1], { action: 'CONSUME' }).expect(201);
    job = await getJob(job.number);
    await change(job, 'transitions', {
      status: 'CANCELLED',
      reason: 'Customer cancels further repair',
    }).expect(201);
    expect((await getPart(part.id)).stock).toMatchObject({
      onHand: 9,
      reserved: 0,
      available: 9,
      repairConsumed: 1,
    });
    const usages = result<JobParts>(await owner.agent.get(root + `jobs/${job.number}/parts`)).items;
    expect(usages.map((u) => u.status)).toEqual(['RELEASED', 'CONSUMED']);
  });
  it('releases reservations on estimate revision and prevents consumption under old approval', async () => {
    const part = await createPart(2);
    let job = await approvedJob();
    const held = await reserve(job, part);
    job = await getJob(job.number);
    job = result(
      await change(job, 'estimates', {
        lines: [{ description: 'Revised repair', quantity: 1, unitPriceInPaise: 60000 }],
        reason: 'Additional damage found',
      }).expect(201),
    );
    expect((await getPart(part.id)).stock.reserved).toBe(0);
    await use(job, held.items[0], { action: 'CONSUME' }).expect(409);
    await operation(`jobs/${job.number}/parts`, {
      expectedJobVersion: job.version,
      partId: part.id,
      quantity: 1,
      compatibilityNote: 'Checked model',
      reason: 'Old consent attempt',
    }).expect(409);
  });
  it('allows only one job to reserve the last unit and rejects stale stock changes', async () => {
    const part = await createPart(1);
    const jobs = await Promise.all([approvedJob(), approvedJob()]);
    const outcomes = await Promise.all(
      jobs.map((job) =>
        operation(`jobs/${job.number}/parts`, {
          expectedJobVersion: job.version,
          partId: part.id,
          quantity: 1,
          compatibilityNote: 'Checked model',
          reason: 'Last display requested',
        }),
      ),
    );
    expect(outcomes.map((r) => r.status).sort()).toEqual([201, 409]);
    await operation(`inventory/parts/${part.id}/adjustments`, {
      expectedVersion: part.stock.version,
      action: 'ADJUST_IN',
      quantity: 1,
      reason: 'Stale count attempt',
    }).expect(409);
    const fresh = await getPart(part.id);
    await operation(`inventory/parts/${part.id}/adjustments`, {
      expectedVersion: fresh.stock.version,
      action: 'DAMAGE',
      quantity: 1,
      reason: 'Reserved stock removal attempt',
    }).expect(409);
    expect((await getPart(part.id)).stock).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });
  it('adds purchase stock only on receipt, supports partial actual-cost receipts and replays without duplication', async () => {
    const part = await createPart();
    let purchase = await order(part, 4);
    expect((await getPart(part.id)).stock.onHand).toBe(0);
    const body = {
      idempotencyKey: randomUUID(),
      expectedVersion: purchase.version,
      reference: 'TEST-INVOICE-1',
      note: 'Two inspected units arrived',
      lines: [{ lineIndex: 0, quantity: 2, unitCostInPaise: 22000 }],
    };
    const responses = await Promise.all([
      post(`inventory/purchases/${purchase.id}/receipts`, body),
      post(`inventory/purchases/${purchase.id}/receipts`, body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    purchase = result(responses[0]);
    expect(purchase.status).toBe('PARTIAL');
    expect(purchase.receipts).toHaveLength(1);
    expect((await getPart(part.id)).stock.onHand).toBe(2);
    await post(`inventory/purchases/${purchase.id}/receipts`, {
      ...body,
      lines: [{ lineIndex: 0, quantity: 1, unitCostInPaise: 22000 }],
    }).expect(409);
    await operation(`inventory/purchases/${purchase.id}/receipts`, {
      ...body,
      idempotencyKey: randomUUID(),
      expectedVersion: purchase.version,
      lines: [{ lineIndex: 0, quantity: 3, unitCostInPaise: 22000 }],
    }).expect(409);
    purchase = result(
      await operation(`inventory/purchases/${purchase.id}/cancel`, {
        expectedVersion: purchase.version,
        reason: 'Cancel outstanding supply',
      }).expect(201),
    );
    expect(purchase.status).toBe('CANCELLED');
    expect((await getPart(part.id)).stock.onHand).toBe(2);
    await operation(`inventory/purchases/${purchase.id}/receipts`, {
      ...body,
      idempotencyKey: randomUUID(),
      expectedVersion: purchase.version,
    }).expect(409);
  });
  it('uses FIFO costs across lots, restores usable returns at original cost and keeps damaged returns unavailable', async () => {
    let part = await createPart(2, 10000);
    part = result(
      await operation(`inventory/parts/${part.id}/adjustments`, {
        expectedVersion: part.stock.version,
        action: 'ADJUST_IN',
        quantity: 2,
        unitCostInPaise: 20000,
        reason: 'Second counted batch',
      }).expect(201),
    );
    let job = await approvedJob();
    const held = await reserve(job, part, 3);
    job = await getJob(job.number);
    let used = result<JobParts>(await use(job, held.items[0], { action: 'CONSUME' }).expect(201));
    expect(used.items[0]).toMatchObject({
      costInPaise: 40000,
      allocations: [
        { quantity: 2, unitCostInPaise: 10000 },
        { quantity: 1, unitCostInPaise: 20000 },
      ],
    });
    job = await getJob(job.number);
    used = result(
      await use(job, used.items[0], { action: 'RETURN_USABLE', quantity: 1 }).expect(201),
    );
    expect(used.items[0]).toMatchObject({ costInPaise: 30000, returnedUsable: 1 });
    job = await getJob(job.number);
    used = result(
      await use(job, used.items[0], { action: 'RETURN_DAMAGED', quantity: 1 }).expect(201),
    );
    expect(used.items[0]).toMatchObject({ costInPaise: 30000, returnedDamaged: 1 });
    expect((await getPart(part.id)).stock).toMatchObject({
      onHand: 2,
      reserved: 0,
      repairConsumed: 2,
    });
    job = await getJob(job.number);
    await use(job, used.items[0], { action: 'RETURN_USABLE', quantity: 2 }).expect(409);
    const lots = result<{ items: Array<{ remaining: number }> }>(
      await owner.agent.get(root + `inventory/parts/${part.id}/lots`),
    );
    expect(lots.items.reduce((sum, l) => sum + l.remaining, 0)).toBe(2);
  });
  it('keeps unknown opening costs explicit and records damage and supplier returns against real lots', async () => {
    let part = await createPart(2);
    let job = await approvedJob();
    const held = await reserve(job, part);
    job = await getJob(job.number);
    const used = result<JobParts>(await use(job, held.items[0], { action: 'CONSUME' }).expect(201));
    expect(used.items[0]).toMatchObject({ costInPaise: 0, unknownCostQuantity: 1 });
    part = await getPart(part.id);
    part = result(
      await operation(`inventory/parts/${part.id}/adjustments`, {
        expectedVersion: part.stock.version,
        action: 'DAMAGE',
        quantity: 1,
        reason: 'Broken part on shelf',
      }).expect(201),
    );
    const purchase = await order(part, 2);
    await operation(`inventory/purchases/${purchase.id}/receipts`, {
      expectedVersion: purchase.version,
      reference: 'SUPPLIER-INVOICE',
      note: 'Parts received',
      lines: [{ lineIndex: 0, quantity: 2, unitCostInPaise: 20000 }],
    }).expect(201);
    const lots = result<{ items: Array<{ id: string; source: string }> }>(
      await owner.agent.get(root + `inventory/parts/${part.id}/lots`),
    );
    part = await getPart(part.id);
    await operation(`inventory/parts/${part.id}/adjustments`, {
      expectedVersion: part.stock.version,
      action: 'SUPPLIER_RETURN',
      quantity: 1,
      lotId: lots.items.find((l) => l.source === 'RECEIPT')!.id,
      reason: 'Wrong connector returned to supplier',
    }).expect(201);
    expect((await getPart(part.id)).stock.onHand).toBe(1);
    const movements = result<{ total: number; items: Array<{ action: string }> }>(
      await owner.agent.get(root + 'inventory/movements').query({ partId: part.id }),
    );
    expect(movements.items.some((m) => m.action === 'REPAIR_SUPPLIER_RETURN')).toBe(true);
  });
  it('protects supplier costs and job assignment, and blocks retail catalog mutations of repair parts', async () => {
    const part = await createPart(2, 12345);
    await request(server)
      .get(root + 'inventory/parts')
      .expect(401);
    await owner.agent
      .post(root + 'inventory/parts')
      .send(partBody())
      .expect(403);
    for (const actor of [reception, technician]) {
      const view = await actor.agent.get(root + `inventory/parts/${part.id}`).expect(200);
      expect(view.text).not.toMatch(/referenceCost|unitCost|supplierId|lots|productId|variantId/);
      for (const path of ['suppliers', 'purchases', 'movements', `parts/${part.id}/lots`])
        await actor.agent.get(root + 'inventory/' + path).expect(403);
      await post('inventory/parts', partBody(), actor).expect(403);
    }
    let job = await approvedJob();
    job = result(
      await owner.agent
        .patch(root + `jobs/${job.number}/assignment`)
        .set('x-csrf-token', owner.csrf)
        .send({
          expectedVersion: job.version,
          technicianId: technician.id,
          reason: 'Assigned for fitting',
        })
        .expect(200),
    );
    const held = await reserve(job, part);
    job = await getJob(job.number);
    await otherTech.agent.get(root + `jobs/${job.number}/parts`).expect(404);
    await use(job, held.items[0], { action: 'CONSUME' }, reception).expect(403);
    const used = await use(job, held.items[0], { action: 'CONSUME' }, technician).expect(201);
    expect(used.text).not.toMatch(/costInPaise|allocations|unknownCost/);
    job = await getJob(job.number);
    await use(job, held.items[0], { action: 'RETURN_USABLE', quantity: 1 }, technician).expect(403);
    await owner.agent.get(`/api/v1/admin/products/${part.productId}`).expect(404);
    await owner.agent
      .post(
        `/api/v1/admin/products/${part.productId}/variants/${part.variantId}/inventory-adjustments`,
      )
      .set('x-csrf-token', owner.csrf)
      .send({
        idempotencyKey: 'inventory:' + randomUUID(),
        deltaOnHand: 1,
        note: 'Cannot bypass part cost ledger',
      })
      .expect(404);
    const publicProducts = await request(server)
      .get('/api/v1/catalog/products')
      .query({ search: prefix })
      .expect(200);
    expect(publicProducts.text).not.toContain(part.sku);
  });
  it('never expires repair holds in retail checkout or exchange cleanup', async () => {
    const part = await createPart(2);
    const job = await approvedJob();
    await reserve(job, part);
    await app.get(CheckoutService).expirePendingOrders();
    await app.get(ReturnRequestService).expireExchangeReservations();
    expect((await getPart(part.id)).stock).toMatchObject({ onHand: 2, reserved: 1, available: 1 });
    const reservation = await connection
      .db!.collection('inventory_reservations')
      .findOne({ variantId: new Types.ObjectId(part.variantId) });
    expect(reservation?.status).toBe('ACTIVE');
    expect(reservation?.expiresAt).toBeUndefined();
  });

  it('enforces configured model compatibility and preserves catalog data on audited edits', async () => {
    const brand = result<{ entry: { id: string } }>(
      await post('catalog/brands', {
        name: prefix,
        slug: prefix.toLowerCase(),
        active: true,
        sortOrder: 0,
      }).expect(201),
    ).entry;
    const first = result<{ entry: { id: string } }>(
      await post('catalog/models', {
        name: prefix + ' Phone A',
        slug: prefix.toLowerCase() + '-a',
        brandId: brand.id,
        active: true,
        sortOrder: 0,
      }).expect(201),
    ).entry;
    const second = result<{ entry: { id: string } }>(
      await post('catalog/models', {
        name: prefix + ' Phone B',
        slug: prefix.toLowerCase() + '-b',
        brandId: brand.id,
        active: true,
        sortOrder: 0,
      }).expect(201),
    ).entry;
    const input = { ...partBody(), modelIds: [first.id] };
    const part = result<Part>(await post('inventory/parts', input).expect(201));
    await operation(`inventory/parts/${part.id}/adjustments`, {
      expectedVersion: part.stock.version,
      action: 'OPENING',
      quantity: 3,
      unitCostInPaise: 9000,
      reason: 'Count checked',
    }).expect(201);
    const job = await approvedJob();
    await connection
      .db!.collection('repair_jobs')
      .updateOne({ number: job.number }, { $set: { modelId: new Types.ObjectId(second.id) } });
    await operation(`jobs/${job.number}/parts`, {
      expectedJobVersion: job.version,
      partId: part.id,
      quantity: 1,
      compatibilityNote: 'Manual note cannot override known mismatch',
      reason: 'Wrong model attempt',
    }).expect(409);
    await connection
      .db!.collection('repair_jobs')
      .updateOne({ number: job.number }, { $set: { modelId: new Types.ObjectId(first.id) } });
    await reserve(job, part);
    const fresh = await getPart(part.id);
    await owner.agent
      .patch(root + `inventory/parts/${part.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({
        ...input,
        idempotencyKey: randomUUID(),
        expectedVersion: fresh.version,
        active: false,
      })
      .expect(409);
    const edited = await owner.agent
      .patch(root + `inventory/parts/${part.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({
        ...input,
        idempotencyKey: randomUUID(),
        expectedVersion: fresh.version,
        bin: 'Shelf B-2',
        referenceCostInPaise: 25000,
      })
      .expect(200);
    expect(edited.body as Record<string, unknown>).toMatchObject({
      bin: 'Shelf B-2',
      referenceCostInPaise: 25000,
      modelIds: [first.id],
    });
    const list = result<{ total: number }>(
      await owner.agent
        .get(root + 'inventory/parts')
        .query({ modelId: first.id, search: prefix })
        .expect(200),
    );
    expect(list.total).toBe(1);
  });
  it('creates one part across concurrent retries and completes multi-line receipts atomically', async () => {
    const input = partBody();
    const responses = await Promise.all([
      post('inventory/parts', input),
      post('inventory/parts', input),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const first = result<Part>(responses[0]);
    expect(result<Part>(responses[1]).id).toBe(first.id);
    const second = await createPart();
    const vendor = await supplier();
    const purchase = result<Purchase>(
      await operation('inventory/purchases', {
        supplierId: vendor.id,
        note: 'Two-part order',
        lines: [
          { partId: first.id, quantity: 2, unitCostInPaise: 1000 },
          { partId: second.id, quantity: 3, unitCostInPaise: 2000 },
        ],
      }).expect(201),
    );
    const body = {
      expectedVersion: purchase.version,
      reference: 'TWO-PART-DELIVERY',
      note: 'All parts received',
      lines: [
        { lineIndex: 0, quantity: 2, unitCostInPaise: 1100 },
        { lineIndex: 1, quantity: 4, unitCostInPaise: 2100 },
      ],
    };
    await operation(`inventory/purchases/${purchase.id}/receipts`, body).expect(409);
    expect((await getPart(first.id)).stock.onHand).toBe(0);
    expect((await getPart(second.id)).stock.onHand).toBe(0);
    body.lines[1].quantity = 3;
    const received = result<Purchase>(
      await operation(`inventory/purchases/${purchase.id}/receipts`, body).expect(201),
    );
    expect(received.status).toBe('RECEIVED');
    expect(received.receipts).toHaveLength(1);
    expect((await getPart(first.id)).stock.onHand).toBe(2);
    expect((await getPart(second.id)).stock.onHand).toBe(3);
    const count = await connection
      .db!.collection('repair_stock_lots')
      .countDocuments({ purchaseId: new Types.ObjectId(purchase.id) });
    expect(count).toBe(2);
  });
  it('rejects invalid direct database counters, preserves balances on migration reruns and filters low stock before pagination', async () => {
    const part = await createPart(3, 100);
    const db = connection.db!;
    for (const repairConsumed of [-1, 1.5])
      await expect(
        db
          .collection('inventory_levels')
          .updateOne(
            { variantId: new Types.ObjectId(part.variantId) },
            { $set: { repairConsumed } },
          ),
      ).rejects.toMatchObject({ code: 121 });
    await expect(
      db
        .collection('products')
        .updateOne({ _id: new Types.ObjectId(part.productId) }, { $set: { status: 'PUBLISHED' } }),
    ).rejects.toMatchObject({ code: 121 });
    const lot = await db
      .collection('repair_stock_lots')
      .findOne({ partId: new Types.ObjectId(part.id) });
    await expect(
      db.collection('repair_stock_lots').updateOne({ _id: lot!._id }, { $set: { remaining: 100 } }),
    ).rejects.toMatchObject({ code: 121 });
    await repairInventoryMigration.up({ connection, database: db });
    await repairInventoryMigration.up({ connection, database: db });
    expect((await getPart(part.id)).stock.onHand).toBe(3);
    const low = result<{ total: number; items: Part[] }>(
      await owner.agent
        .get(root + 'inventory/parts')
        .query({ search: prefix, lowStock: 'true', page: 1, limit: 1 })
        .expect(200),
    );
    expect(low.total).toBeGreaterThan(0);
    expect(low.items).toHaveLength(1);
    expect(low.items[0].stock.available).toBeLessThanOrEqual(2);
  });
});
