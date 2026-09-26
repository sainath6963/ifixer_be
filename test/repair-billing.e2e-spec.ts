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
import { repairBillingMigration } from '../src/database/migrations/026-repair-billing';
import { AdminUser } from '../src/database/schemas/identity.schema';
import { AdminRole, AccountStatus } from '../src/domain/enums';
import { repairTestKeys } from '../src/database/schemas/repair-job.schema';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import type { RepairJobView } from '../src/modules/repair-jobs/repair-job.service';
interface Actor {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: string;
}
interface Settings {
  configured: boolean;
  version: number;
  issuer: { name: string; address: string; phone: string };
  taxes: Array<{ label: string; rateBps: number }>;
  warrantyDays: number;
  warrantyCoverage: string;
  warrantyExclusions: string;
}
interface Bill {
  jobNumber: string;
  jobVersion: number;
  invoice: {
    id: string;
    number: string;
    totalInPaise: number;
    subtotalInPaise: number;
    discountInPaise: number;
    warrantyDays: number;
    warrantyCoverage: string;
    issuer: { name: string };
    taxes: Array<{ amountInPaise: number }>;
  } | null;
  entries: Array<{
    id: string;
    kind: string;
    number: string;
    amountInPaise: number;
    reference?: string;
  }>;
  summary: {
    dueInPaise: number;
    netPaidInPaise: number;
    advanceInPaise: number;
    refundedInPaise: number;
    refundDueInPaise: number;
    creditedInPaise: number;
  };
  warranty: { active: boolean; startsAt?: string; endsAt?: string };
  followups: Array<{ number: string }>;
}
const result = <T>(response: request.Response): T => response.body as T;
describe('Repair billing, payments and warranty (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let connection: Connection;
  let users: Model<AdminUser>;
  let owner: Actor;
  let reception: Actor;
  let tech: Actor;
  let settings: Settings;
  const prefix = `BILL-${randomUUID().slice(0, 8)}`;
  const password = 'Billing-fixture-password-123';
  const root = '/api/v1/admin/repair/';
  const defaults = {
    issuer: { name: prefix, address: 'Test workshop, test address', phone: '+919876543210' },
    taxes: [{ label: 'Configured test tax', rateBps: 1000 }],
    warrantyDays: 30,
    warrantyCoverage: 'Replacement component workmanship',
    warrantyExclusions: 'Physical or liquid damage excluded in this test',
  };
  const post = (path: string, body: Record<string, unknown>, actor = owner): request.Test =>
    actor.agent
      .post(root + path)
      .set('x-csrf-token', actor.csrf)
      .send(body);
  const op = (path: string, body: Record<string, unknown>, actor = owner): request.Test =>
    post(path, { idempotencyKey: randomUUID(), ...body }, actor);
  const get = async (number: string): Promise<Bill> =>
    result(await owner.agent.get(root + `jobs/${number}/billing`).expect(200));
  const job = async (number: string): Promise<RepairJobView> =>
    result(await owner.agent.get(root + `jobs/${number}`).expect(200));
  const change = (
    row: RepairJobView,
    action: string,
    body: Record<string, unknown>,
    actor = owner,
  ): request.Test =>
    post(`jobs/${row.number}/${action}`, { expectedVersion: row.version, ...body }, actor);
  const create = async (): Promise<RepairJobView> =>
    result(
      await op('jobs', {
        customerName: prefix,
        phone: '+919876543210',
        deviceLabel: 'Billing test phone',
        issue: 'Screen damaged and needs replacement',
        condition: 'Cracked display',
        accessories: 'Case only',
      }).expect(201),
    );
  const approved = async (): Promise<RepairJobView> => {
    let row = await create();
    row = result(
      await change(row, 'transitions', { status: 'DIAGNOSING', reason: 'Inspect device' }).expect(
        201,
      ),
    );
    row = result(await change(row, 'diagnosis', { text: 'Replacement screen needed' }).expect(201));
    row = result(
      await change(row, 'estimates', {
        lines: [
          {
            description: 'Repair including configured taxes',
            quantity: 1,
            unitPriceInPaise: 200000,
          },
        ],
        reason: 'Customer quote',
      }).expect(201),
    );
    row = result(
      await change(row, 'approval', {
        revision: 1,
        decision: 'APPROVED',
        method: 'PHONE',
        customerName: prefix,
        evidence: 'Customer accepted final total by phone',
      }).expect(201),
    );
    return row;
  };
  const invoiceInput = (row: RepairJobView): Record<string, unknown> => ({
    expectedJobVersion: row.version,
    expectedSettingsVersion: settings.version,
    estimateRevision: 1,
    lines: [
      { kind: 'PART', description: 'Replacement screen', quantity: 2, unitPriceInPaise: 50000 },
      { kind: 'LABOUR', description: 'Repair labour', quantity: 1, unitPriceInPaise: 10000 },
    ],
    discountInPaise: 10000,
    applyTax: true,
    expectedTotalInPaise: 110000,
    warrantyDays: defaults.warrantyDays,
    warrantyCoverage: defaults.warrantyCoverage,
    warrantyExclusions: defaults.warrantyExclusions,
    reason: 'Final repair invoice checked',
  });
  const issue = async (row: RepairJobView): Promise<Bill> =>
    result(await op(`jobs/${row.number}/billing/invoice`, invoiceInput(row)).expect(201));
  const money = (
    bill: Bill,
    path: string,
    values: Record<string, unknown>,
    actor = owner,
  ): request.Test =>
    op(
      `jobs/${bill.jobNumber}/billing/${path}`,
      { expectedJobVersion: bill.jobVersion, reason: 'Customer transaction checked', ...values },
      actor,
    );
  const ready = async (number: string): Promise<RepairJobView> => {
    let row = await job(number);
    for (const status of ['REPAIRING', 'TESTING'])
      row = result(
        await change(row, 'transitions', { status, reason: 'Approved work completed' }).expect(201),
      );
    row = result(
      await change(row, 'tests', {
        tests: repairTestKeys.map((key) => ({ key, result: 'PASS' })),
      }).expect(201),
    );
    return result(
      await change(row, 'transitions', { status: 'READY', reason: 'All tests passed' }).expect(201),
    );
  };
  const login = async (role: AdminRole): Promise<Actor> => {
    const email = `${prefix}-${role}@example.test`;
    await users.create({
      name: `${prefix}-${role}`,
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
    tech = await login(AdminRole.Technician);
    const existing = result<Settings>(await owner.agent.get(root + 'billing/settings'));
    settings = result(
      await op('billing/settings', { ...defaults, expectedVersion: existing.version }).expect(201),
    );
  }, 60000);
  afterAll(async () => {
    if (!app) return;
    const db = connection.db!;
    const jobs = await db.collection('repair_jobs').find({ customerName: prefix }).toArray();
    const ids = jobs.map((j) => j._id);
    const actors = await users.find({ name: new RegExp('^' + prefix) });
    const actorIds = actors.map((a) => a._id);
    for (const name of ['repair_invoices', 'repair_money_entries', 'repair_warranties'])
      await db.collection(name).deleteMany({ jobId: { $in: ids } });
    await db.collection('repair_jobs').deleteMany({ _id: { $in: ids } });
    await db
      .collection('repair_billing_settings')
      .deleteMany({ 'issuer.name': new RegExp('^' + prefix) });
    for (const name of ['repair_billing_operations', 'audit_logs'])
      await db.collection(name).deleteMany({ actorId: { $in: actorIds } });
    await db.collection('admin_sessions').deleteMany({ adminUserId: { $in: actorIds } });
    await users.deleteMany({ _id: { $in: actorIds } });
    await app.close();
  });
  it('allocates advances once, calculates integer taxes/discounts and accepts partial cash/UPI payments', async () => {
    let row = await approved();
    let bill = await get(row.number);
    bill = result(
      await money(bill, 'payments', { amountInPaise: 30000, method: 'CASH' }, reception).expect(
        201,
      ),
    );
    expect(bill.summary).toMatchObject({
      advanceInPaise: 30000,
      netPaidInPaise: 30000,
      dueInPaise: 0,
    });
    row = await job(row.number);
    bill = await issue(row);
    expect(bill.invoice).toMatchObject({
      subtotalInPaise: 110000,
      discountInPaise: 10000,
      totalInPaise: 110000,
      taxes: [{ amountInPaise: 10000 }],
    });
    expect(bill.summary.dueInPaise).toBe(80000);
    bill = result(
      await money(
        bill,
        'payments',
        { amountInPaise: 20000, method: 'UPI', reference: `UPI-${randomUUID()}` },
        reception,
      ).expect(201),
    );
    expect(bill.summary.dueInPaise).toBe(60000);
    bill = result(
      await money(bill, 'payments', { amountInPaise: 60000, method: 'CASH' }).expect(201),
    );
    expect(bill.summary).toMatchObject({ dueInPaise: 0, netPaidInPaise: 110000 });
    expect(bill.entries).toHaveLength(3);
  });
  it('replays concurrent payment retries once, rejects changed payload and duplicate UPI references', async () => {
    let bill = await issue(await approved());
    const body = {
      idempotencyKey: randomUUID(),
      expectedJobVersion: bill.jobVersion,
      amountInPaise: 10000,
      method: 'UPI',
      reference: `UPI-${randomUUID()}`,
      reason: 'Checked bank transaction',
    };
    const outcomes = await Promise.all([
      post(`jobs/${bill.jobNumber}/billing/payments`, body),
      post(`jobs/${bill.jobNumber}/billing/payments`, body),
    ]);
    expect(outcomes.map((r) => r.status)).toEqual([201, 201]);
    bill = await get(bill.jobNumber);
    expect(bill.entries).toHaveLength(1);
    expect(bill.summary.netPaidInPaise).toBe(10000);
    await post(`jobs/${bill.jobNumber}/billing/payments`, { ...body, amountInPaise: 20000 }).expect(
      409,
    );
    await money(bill, 'payments', {
      amountInPaise: 10000,
      method: 'UPI',
      reference: body.reference,
    }).expect(409);
    expect((await get(bill.jobNumber)).entries).toHaveLength(1);
  });
  it('prevents concurrent overpayment and requires a UPI reference', async () => {
    const bill = await issue(await approved());
    await money(bill, 'payments', { amountInPaise: 1, method: 'UPI' }).expect(400);
    const outcomes = await Promise.all([
      money(bill, 'payments', { amountInPaise: 110000, method: 'CASH' }),
      money(bill, 'payments', { amountInPaise: 110000, method: 'CASH' }),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([201, 409]);
    const fresh = await get(bill.jobNumber);
    await money(fresh, 'payments', { amountInPaise: 1, method: 'CASH' }).expect(409);
    expect(fresh.summary.netPaidInPaise).toBe(110000);
  });
  it('keeps issued prices, issuer and warranty immutable across settings changes and blocks requoting', async () => {
    const row = await approved();
    const bill = await issue(row);
    const original = bill.invoice;
    settings = result(
      await op('billing/settings', {
        ...defaults,
        issuer: { ...defaults.issuer, name: prefix + ' new identity' },
        warrantyDays: 90,
        expectedVersion: settings.version,
      }).expect(201),
    );
    expect((await get(row.number)).invoice).toEqual(original);
    await op(`jobs/${row.number}/billing/invoice`, {
      ...invoiceInput(await job(row.number)),
      expectedSettingsVersion: settings.version,
    }).expect(409);
    await change(await job(row.number), 'estimates', {
      lines: [{ description: 'Changed price', quantity: 1, unitPriceInPaise: 1 }],
      reason: 'Cannot rewrite issued invoice',
    }).expect(409);
    settings = result(
      await op('billing/settings', { ...defaults, expectedVersion: settings.version }).expect(201),
    );
  });
  it('rejects unapproved and above-approved invoices, stale settings and fractional money', async () => {
    const initial = await create();
    await op(`jobs/${initial.number}/billing/invoice`, invoiceInput(initial)).expect(409);
    const row = await approved();
    await op(`jobs/${row.number}/billing/invoice`, {
      ...invoiceInput(row),
      expectedSettingsVersion: settings.version + 1,
    }).expect(409);
    await op(`jobs/${row.number}/billing/invoice`, {
      ...invoiceInput(row),
      lines: [
        { kind: 'SERVICE', description: 'Excessive charge', quantity: 1, unitPriceInPaise: 300000 },
      ],
      discountInPaise: 0,
      expectedTotalInPaise: 330000,
    }).expect(409);
    const bill = await issue(row);
    await money(bill, 'payments', { amountInPaise: 1.5, method: 'CASH' }).expect(400);
  });
  it('separates credits from refunds, limits refunds per payment and replays refunds once', async () => {
    let bill = await issue(await approved());
    bill = result(
      await money(bill, 'payments', { amountInPaise: 110000, method: 'CASH' }).expect(201),
    );
    const payment = bill.entries[0];
    bill = result(await money(bill, 'credits', { amountInPaise: 20000 }).expect(201));
    expect(bill.summary).toMatchObject({
      creditedInPaise: 20000,
      refundDueInPaise: 20000,
      netPaidInPaise: 110000,
    });
    const body = {
      idempotencyKey: randomUUID(),
      expectedJobVersion: bill.jobVersion,
      paymentId: payment.id,
      amountInPaise: 20000,
      method: 'CASH',
      reason: 'Cash refund handed to customer',
    };
    await post(`jobs/${bill.jobNumber}/billing/refunds`, body).expect(201);
    await post(`jobs/${bill.jobNumber}/billing/refunds`, body).expect(201);
    bill = await get(bill.jobNumber);
    expect(bill.summary).toMatchObject({
      refundedInPaise: 20000,
      refundDueInPaise: 0,
      dueInPaise: 0,
    });
    await money(bill, 'refunds', {
      paymentId: payment.id,
      amountInPaise: 100000,
      method: 'CASH',
    }).expect(409);
    expect(bill.entries.filter((e) => e.kind === 'REFUND')).toHaveLength(1);
  });
  it('requires a paid invoice or owner authorization, revokes authorization on new money events and starts warranty on delivery', async () => {
    const initial = await approved();
    let row = await ready(initial.number);
    await change(row, 'transitions', {
      status: 'DELIVERED',
      recipient: prefix,
      reason: 'Cannot skip billing',
    }).expect(409);
    let bill = await issue(row);
    row = await job(row.number);
    await change(row, 'transitions', {
      status: 'DELIVERED',
      recipient: prefix,
      reason: 'Unpaid attempt',
    }).expect(409);
    await money(
      bill,
      'delivery-authorization',
      { allow: true, expectedDueInPaise: 110000 },
      reception,
    ).expect(403);
    bill = result(
      await money(bill, 'delivery-authorization', {
        allow: true,
        expectedDueInPaise: 110000,
      }).expect(201),
    );
    bill = result(
      await money(bill, 'payments', { amountInPaise: 10000, method: 'CASH' }).expect(201),
    );
    row = await job(row.number);
    await change(row, 'transitions', {
      status: 'DELIVERED',
      recipient: prefix,
      reason: 'Old approval invalidated',
    }).expect(409);
    bill = result(
      await money(bill, 'delivery-authorization', {
        allow: true,
        expectedDueInPaise: 100000,
      }).expect(201),
    );
    row = await job(row.number);
    await change(
      row,
      'transitions',
      { status: 'DELIVERED', recipient: prefix, reason: 'Owner approved balance handover' },
      reception,
    ).expect(201);
    bill = await get(row.number);
    expect(bill.warranty.active).toBe(true);
    expect(Date.parse(bill.warranty.endsAt!) - Date.parse(bill.warranty.startsAt!)).toBe(
      30 * 86400000,
    );
  });
  it('retains a cancelled device until remaining advances are explicitly refunded', async () => {
    let row = await create();
    let bill = await get(row.number);
    bill = result(
      await money(bill, 'payments', { amountInPaise: 5000, method: 'CASH' }).expect(201),
    );
    row = await job(row.number);
    row = result(
      await change(row, 'transitions', {
        status: 'CANCELLED',
        reason: 'Customer cancelled repair',
      }).expect(201),
    );
    await change(row, 'handover', { recipient: prefix, reason: 'Refund still owed' }).expect(409);
    bill = await get(row.number);
    result(
      await money(bill, 'refunds', {
        paymentId: bill.entries[0].id,
        amountInPaise: 5000,
        method: 'CASH',
      }).expect(201),
    );
    row = await job(row.number);
    await change(row, 'handover', {
      recipient: prefix,
      reason: 'Advance refunded and phone collected',
    }).expect(201);
  });
  it('links a repeat intake to the original delivered invoice without approving free work', async () => {
    let bill = await issue(await approved());
    bill = result(
      await money(bill, 'payments', { amountInPaise: 110000, method: 'CASH' }).expect(201),
    );
    const row = await ready(bill.jobNumber);
    await change(row, 'transitions', {
      status: 'DELIVERED',
      recipient: prefix,
      reason: 'Collected after payment',
    }).expect(201);
    bill = await get(row.number);
    const body = {
      idempotencyKey: randomUUID(),
      expectedJobVersion: bill.jobVersion,
      issue: 'Touch stopped responding again',
      condition: 'No visible new damage',
      accessories: 'Case only',
    };
    await post(`jobs/${row.number}/billing/followups`, body, reception).expect(201);
    await post(`jobs/${row.number}/billing/followups`, body, reception).expect(201);
    bill = await get(row.number);
    expect(bill.followups).toHaveLength(1);
    const followup = await job(bill.followups[0].number);
    expect(followup).toMatchObject({
      warrantySourceJobNumber: row.number,
      warrantySourceInvoiceNumber: bill.invoice!.number,
      status: 'RECEIVED',
      customerName: prefix,
      deviceLabel: row.deviceLabel,
      estimates: [],
    });
  });
  it('enforces financial role boundaries and hides billing history from technicians', async () => {
    await request(server)
      .get(root + 'billing/invoices')
      .expect(401);
    await tech.agent.get(root + 'billing/settings').expect(403);
    await op(
      'billing/settings',
      { ...defaults, expectedVersion: settings.version },
      reception,
    ).expect(403);
    let row = await approved();
    row = result(
      await owner.agent
        .patch(root + `jobs/${row.number}/assignment`)
        .set('x-csrf-token', owner.csrf)
        .send({ expectedVersion: row.version, technicianId: tech.id, reason: 'Assigned for test' })
        .expect(200),
    );
    for (const override of [{ warrantyDays: 90 }, { applyTax: false }]) {
      await op(
        `jobs/${row.number}/billing/invoice`,
        { ...invoiceInput(row), ...override },
        reception,
      ).expect(403);
    }
    let bill = result<Bill>(
      await op(`jobs/${row.number}/billing/invoice`, invoiceInput(row), reception).expect(201),
    );
    await tech.agent.get(root + `jobs/${row.number}/billing`).expect(403);
    bill = result(
      await money(bill, 'payments', { amountInPaise: 10000, method: 'CASH' }, reception).expect(
        201,
      ),
    );
    await money(bill, 'credits', { amountInPaise: 100 }, reception).expect(403);
    await money(
      bill,
      'refunds',
      { amountInPaise: 100, method: 'CASH', paymentId: bill.entries[0].id },
      reception,
    ).expect(403);
    const visible = result<RepairJobView>(
      await tech.agent.get(root + `jobs/${row.number}`).expect(200),
    );
    expect(visible.history.some((event) => event.action === 'BILLING')).toBe(false);
    await reception.agent
      .post(root + `jobs/${row.number}/billing/payments`)
      .send({})
      .expect(403);
  });
  it('validates invoice arithmetic and money records in MongoDB, and preserves records on migration reruns', async () => {
    const bill = await issue(await approved());
    const db = connection.db!;
    await expect(
      db
        .collection('repair_invoices')
        .updateOne({ _id: new Types.ObjectId(bill.invoice!.id) }, { $set: { totalInPaise: 1 } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      db
        .collection('repair_warranties')
        .updateOne(
          { invoiceId: new Types.ObjectId(bill.invoice!.id) },
          { $set: { endsAt: new Date() } },
        ),
    ).rejects.toMatchObject({ code: 121 });
    await repairBillingMigration.up({ connection, database: db });
    await repairBillingMigration.up({ connection, database: db });
    expect((await get(bill.jobNumber)).invoice).toEqual(bill.invoice);
    const list = result<{ total: number }>(
      await owner.agent
        .get(root + 'billing/invoices')
        .query({ search: bill.invoice!.number })
        .expect(200),
    );
    expect(list.total).toBe(1);
  });
});
