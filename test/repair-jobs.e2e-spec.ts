import { repairBillingMigration } from '../src/database/migrations/026-repair-billing';
import { repairInventoryMigration } from '../src/database/migrations/025-repair-inventory';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { repairJobsMigration } from '../src/database/migrations/024-repair-jobs';
import { AdminUser, AdminSession } from '../src/database/schemas/identity.schema';
import {
  RepairJob,
  RepairJobPhoto,
  RepairJobStatus as Status,
  repairTestKeys,
} from '../src/database/schemas/repair-job.schema';
import { RepairBooking } from '../src/database/schemas/repair.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { AccountStatus, AdminRole } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import type { RepairJobView } from '../src/modules/repair-jobs/repair-job.service';
import type { CreateJobDto } from '../src/modules/repair-jobs/repair-job.dto';

interface Actor {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: string;
}
const jobFrom = (response: request.Response): RepairJobView => response.body as RepairJobView;
const decision = {
  revision: 1,
  decision: 'APPROVED',
  method: 'PHONE',
  customerName: 'Device owner',
  evidence: 'Customer agreed to the quoted display replacement during the call.',
};
describe('Repair jobs, permissions and private intake (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let connection: Connection;
  let owner: Actor;
  let reception: Actor;
  let technician: Actor;
  let otherTech: Actor;
  let jobs: Model<RepairJob>;
  let users: Model<AdminUser>;
  const prefix = `job-${randomUUID().slice(0, 8)}`;
  const password = 'Repair-job-test-password-123';
  const intake = (extra: Partial<CreateJobDto> = {}): CreateJobDto => ({
    idempotencyKey: randomUUID(),
    customerName: prefix,
    phone: '+919876543210',
    email: `${prefix}-customer@example.test`,
    deviceLabel: 'Test phone',
    issue: 'The display stopped responding to touch.',
    condition: `${prefix} cracked front glass, powers on`,
    accessories: 'Blue case only',
    imei: '123456789012345',
    serial: 'TEST-SERIAL',
    ...extra,
  });
  const change = (
    job: RepairJobView,
    action: string,
    body: Record<string, unknown>,
    actor = owner,
  ): request.Test =>
    actor.agent
      .post(`/api/v1/admin/repair/jobs/${job.number}/${action}`)
      .set('x-csrf-token', actor.csrf)
      .send({ expectedVersion: job.version, ...body });
  const create = async (actor = reception, input = intake()): Promise<RepairJobView> =>
    jobFrom(
      await actor.agent
        .post('/api/v1/admin/repair/jobs')
        .set('x-csrf-token', actor.csrf)
        .send(input)
        .expect(201),
    );
  const transition = async (
    job: RepairJobView,
    status: Status,
    actor = owner,
  ): Promise<RepairJobView> =>
    jobFrom(
      await change(
        job,
        'transitions',
        { status, reason: 'Workshop progression recorded' },
        actor,
      ).expect(201),
    );
  const estimate = async (): Promise<RepairJobView> => {
    let job = await transition(await create(), Status.Diagnosing);
    job = jobFrom(
      await change(job, 'diagnosis', { text: 'Display flex damaged; replacement needed.' }).expect(
        201,
      ),
    );
    return jobFrom(
      await change(job, 'estimates', {
        lines: [
          { description: 'Display replacement', quantity: 1, unitPriceInPaise: 249950 },
          { description: 'Labour', quantity: 1, unitPriceInPaise: 50000 },
        ],
        reason: 'Initial diagnosis and quote',
      }).expect(201),
    );
  };
  const login = async (email: string): Promise<Actor> => {
    const agent = request.agent(server);
    const csrf = ((await agent.get('/api/v1/admin/auth/csrf')).body as { csrfToken: string })
      .csrfToken;
    const response = await agent
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    return { agent, csrf, id: (response.body as { admin: { id: string } }).admin.id };
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
    await express.init();
    app = express;
    server = app.getHttpServer() as Server;
    connection = app.get(getConnectionToken());
    jobs = app.get(getModelToken(RepairJob.name));
    users = app.get(getModelToken(AdminUser.name));
    await app.get(MigrationRunner).run();
    if (!connection.db) throw new Error('Test database unavailable');
    await repairJobsMigration.up({ connection, database: connection.db });
    await repairInventoryMigration.up({ connection, database: connection.db });
    await repairBillingMigration.up({ connection, database: connection.db });
    await users.create({
      name: 'Job owner',
      email: `${prefix}-owner@example.test`,
      passwordHash: await app.get(PasswordService).hash(password),
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    owner = await login(`${prefix}-owner@example.test`);
    for (const [suffix, role] of [
      ['reception', 'RECEPTION'],
      ['technician', 'TECHNICIAN'],
      ['other', 'TECHNICIAN'],
    ])
      await owner.agent
        .post('/api/v1/admin/repair/team')
        .set('x-csrf-token', owner.csrf)
        .send({
          name: `${prefix}-${suffix}`,
          email: `${prefix}-${suffix}@example.test`,
          password,
          role,
        })
        .expect(204);
    reception = await login(`${prefix}-reception@example.test`);
    technician = await login(`${prefix}-technician@example.test`);
    otherTech = await login(`${prefix}-other@example.test`);
  }, 60000);
  afterAll(async () => {
    if (!app) return;
    const ids = (await jobs.find({ customerName: prefix })).map((job) => job._id);
    await connection.model(RepairJobPhoto.name).deleteMany({ jobId: { $in: ids } });
    for (const name of ['RepairInvoice', 'RepairMoneyEntry', 'RepairWarranty'])
      await connection.model(name).deleteMany({ jobId: { $in: ids } });
    await connection.model('RepairBillingSettings').deleteMany({ 'issuer.name': prefix });
    await jobs.deleteMany({ _id: { $in: ids } });
    await connection.model(RepairBooking.name).deleteMany({ customerName: prefix });
    const accounts = await users.find({ email: new RegExp(`^${prefix}-`) });
    await connection
      .model(AdminSession.name)
      .deleteMany({ adminUserId: { $in: accounts.map((user) => user._id) } });
    await connection
      .model(AuditLog.name)
      .deleteMany({ actorId: { $in: accounts.map((user) => user._id) } });
    await connection
      .model('RepairBillingOperation')
      .deleteMany({ actorId: { $in: accounts.map((user) => user._id) } });
    await users.deleteMany({ _id: { $in: accounts.map((user) => user._id) } });
    await app.close();
  });

  it('opens one direct walk-in job across concurrent retries and rejects a reused key', async () => {
    const input = intake();
    const results = await Promise.all([
      create(reception, input),
      create(reception, input),
      create(reception, input),
    ]);
    expect(new Set(results.map((job) => job.number)).size).toBe(1);
    expect(results[0]).toMatchObject({
      version: 0,
      status: 'RECEIVED',
      custody: 'IN_SHOP',
      imei: input.imei,
    });
    expect(
      await jobs.countDocuments({ operationKey: `${reception.id}:${input.idempotencyKey}` }),
    ).toBe(1);
    await reception.agent
      .post('/api/v1/admin/repair/jobs')
      .set('x-csrf-token', reception.csrf)
      .send({ ...input, condition: 'Different intake condition' })
      .expect(409);
  });
  it('converts a booking atomically once, preserves the snapshot and closes booking edits', async () => {
    const bookingResponse = await reception.agent
      .post('/api/v1/admin/repair/bookings')
      .set('x-csrf-token', reception.csrf)
      .send({
        idempotencyKey: randomUUID(),
        manageToken: randomBytes(32).toString('hex'),
        customerName: prefix,
        phone: '+919876543210',
        deviceDescription: 'Booked phone',
        issue: 'Phone screen is cracked and flickering.',
      })
      .expect(201);
    const booking = (bookingResponse.body as { booking: { reference: string; version: number } })
      .booking;
    const input: CreateJobDto = {
      idempotencyKey: randomUUID(),
      bookingReference: booking.reference,
      expectedBookingVersion: booking.version,
      condition: `${prefix} cracked screen`,
      accessories: 'None',
    };
    const results = await Promise.all([
      create(reception, input),
      create(owner, { ...input, idempotencyKey: randomUUID() }),
    ]);
    expect(results[0].number).toBe(results[1].number);
    expect(results[0].deviceLabel).toBe('Booked phone');
    expect(await jobs.countDocuments({ bookingReference: booking.reference })).toBe(1);
    const saved = await connection
      .model<RepairBooking>(RepairBooking.name)
      .findOne({ reference: booking.reference })
      .orFail();
    expect(saved.status).toBe('CONVERTED');
    expect(saved.jobNumber).toBe(results[0].number);
    expect(saved.history).toHaveLength(2);
    await reception.agent
      .patch(`/api/v1/admin/repair/bookings/${booking.reference}`)
      .set('x-csrf-token', reception.csrf)
      .send({ expectedVersion: 1, action: 'CANCEL', reason: 'Cannot cancel converted booking' })
      .expect(409);
  });
  it('requires CSRF, validates intake fields and rejects skipped diagnosis/status steps', async () => {
    await request(server).get('/api/v1/admin/repair/jobs').expect(401);
    await reception.agent.post('/api/v1/admin/repair/jobs').send(intake()).expect(403);
    for (const extra of [
      { imei: '123' },
      { phone: 'abc' },
      { targetAt: '2020-01-01T10:00:00Z' },
      { customerName: undefined },
      { status: 'DELIVERED' },
    ])
      await reception.agent
        .post('/api/v1/admin/repair/jobs')
        .set('x-csrf-token', reception.csrf)
        .send({ ...intake(), ...extra })
        .expect(400);
    const job = await create();
    await change(job, 'transitions', { status: 'READY', reason: 'Skip all repair work' }).expect(
      409,
    );
    await change(job, 'estimates', {
      lines: [{ description: 'No diagnosis yet', quantity: 1, unitPriceInPaise: 100 }],
      reason: 'Invalid early estimate',
    }).expect(409);
    await change(job, 'diagnosis', { text: 'Cannot diagnose before starting' }).expect(409);
  });
  it('limits technicians to assigned jobs and keeps reception out of repair work and role administration', async () => {
    let job = await create();
    await technician.agent.get(`/api/v1/admin/repair/jobs/${job.number}`).expect(404);
    await technician.agent.get('/api/v1/admin/repair/bookings').expect(403);
    await technician.agent.get('/api/v1/admin/customers').expect(403);
    await technician.agent.get('/api/v1/admin/auth/me').expect(200);
    await reception.agent.get('/api/v1/admin/auth/me').expect(200);
    await reception.agent
      .post('/api/v1/admin/repair/team')
      .set('x-csrf-token', reception.csrf)
      .send({
        name: 'Forbidden team member',
        email: `${prefix}-forbidden@example.test`,
        password,
        role: 'TECHNICIAN',
      })
      .expect(403);
    await technician.agent
      .post('/api/v1/admin/repair/jobs')
      .set('x-csrf-token', technician.csrf)
      .send(intake())
      .expect(403);
    job = jobFrom(
      await reception.agent
        .patch(`/api/v1/admin/repair/jobs/${job.number}/assignment`)
        .set('x-csrf-token', reception.csrf)
        .send({
          expectedVersion: job.version,
          technicianId: technician.id,
          reason: 'Assigned for diagnosis',
        })
        .expect(200),
    );
    const visible = await technician.agent
      .get(`/api/v1/admin/repair/jobs/${job.number}`)
      .expect(200);
    expect(visible.text).not.toContain(job.phone);
    expect(visible.text).not.toContain('customer@example.test');
    const list = (
      await technician.agent
        .get('/api/v1/admin/repair/jobs')
        .query({ search: job.number })
        .expect(200)
    ).body as { total: number };
    expect(list.total).toBe(1);
    await change(
      job,
      'transitions',
      { status: 'DIAGNOSING', reason: 'Reception attempting repair' },
      reception,
    ).expect(403);
    job = await transition(job, Status.Diagnosing, technician);
    job = jobFrom(
      await change(job, 'diagnosis', { text: 'Assigned technician findings' }, technician).expect(
        201,
      ),
    );
    await change(
      job,
      'estimates',
      {
        lines: [{ description: 'Technician price edit', quantity: 1, unitPriceInPaise: 100 }],
        reason: 'Forbidden technician pricing',
      },
      technician,
    ).expect(403);
    await otherTech.agent.get(`/api/v1/admin/repair/jobs/${job.number}`).expect(404);
    job = jobFrom(
      await owner.agent
        .patch(`/api/v1/admin/repair/jobs/${job.number}/assignment`)
        .set('x-csrf-token', owner.csrf)
        .send({
          expectedVersion: job.version,
          technicianId: otherTech.id,
          reason: 'Reassigned to another technician',
        })
        .expect(200),
    );
    await change(job, 'notes', { text: 'Old technician access attempt' }, technician).expect(404);
  });
  it('ties decisions to the latest immutable estimate, recalculates paise and invalidates earlier approval on revision', async () => {
    let job = await estimate();
    expect(job.estimates[0].totalInPaise).toBe(299950);
    await change(job, 'transitions', {
      status: 'REPAIRING',
      reason: 'Try work before consent',
    }).expect(409);
    await change(job, 'approval', { ...decision, revision: 2 }).expect(409);
    await change(job, 'approval', { ...decision, evidence: 'x' }).expect(400);
    job = jobFrom(await change(job, 'approval', decision, reception).expect(201));
    const first = job.estimates[0];
    await change(job, 'approval', decision).expect(409);
    job = await transition(job, Status.Repairing);
    job = jobFrom(
      await change(job, 'estimates', {
        lines: [
          { description: 'Replacement display plus flex', quantity: 2, unitPriceInPaise: 200050 },
        ],
        reason: 'Additional damage found, requote before work',
      }).expect(201),
    );
    expect(job.status).toBe('AWAITING_APPROVAL');
    expect(job.estimates[0]).toEqual(first);
    expect(job.estimates[1]).toMatchObject({ revision: 2, totalInPaise: 400100 });
    await change(job, 'approval', decision).expect(409);
    await change(job, 'transitions', {
      status: 'REPAIRING',
      reason: 'Old approval is insufficient',
    }).expect(409);
    job = jobFrom(
      await change(job, 'approval', { ...decision, revision: 2, decision: 'DECLINED' }).expect(201),
    );
    await change(job, 'transitions', {
      status: 'REPAIRING',
      reason: 'Declined quote cannot proceed',
    }).expect(409);
    await change(job, 'estimates', {
      lines: [{ description: 'Fractional paise', quantity: 1, unitPriceInPaise: 1.5 }],
      reason: 'Invalid amount',
    }).expect(400);
    await change(job, 'estimates', {
      lines: [{ description: 'Overflow quote', quantity: 100, unitPriceInPaise: 1000000000 }],
      reason: 'Invalid total',
    }).expect(400);
  });
  it('permits only one concurrent update and preserves a single winning audit/history event', async () => {
    const job = await create();
    const results = await Promise.all([
      change(job, 'transitions', { status: 'DIAGNOSING', reason: 'First change' }),
      change(job, 'transitions', { status: 'CANCELLED', reason: 'Second change' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const saved = await jobs.findOne({ number: job.number }).orFail();
    expect(saved.history).toHaveLength(2);
    expect(saved.get('version')).toBe(1);
    expect(
      await connection
        .model(AuditLog.name)
        .countDocuments({ resourceId: saved.id, action: 'REPAIR_JOB_STATUS' }),
    ).toBe(1);
  });
  it('requires a complete testing checklist, supports failed-test rework and records handover', async () => {
    let job = await estimate();
    job = jobFrom(await change(job, 'approval', decision).expect(201));
    job = await transition(job, Status.Repairing);
    job = await transition(job, Status.AwaitingParts);
    job = await transition(job, Status.Repairing);
    job = await transition(job, Status.Testing);
    await change(job, 'transitions', { status: 'READY', reason: 'No tests recorded' }).expect(409);
    const checks = repairTestKeys.map((key) => ({ key, result: 'PASS' }));
    await change(job, 'tests', { tests: checks.slice(1) }).expect(400);
    await change(job, 'tests', { tests: checks.map(() => checks[0]) }).expect(400);
    await change(job, 'tests', {
      tests: [{ key: 'power', result: 'NA' }, ...checks.slice(1)],
    }).expect(400);
    job = jobFrom(
      await change(job, 'tests', {
        tests: [
          { key: 'power', result: 'FAIL', notes: 'Battery not holding charge' },
          ...checks.slice(1),
        ],
      }).expect(201),
    );
    await change(job, 'transitions', { status: 'READY', reason: 'Failed test remains' }).expect(
      409,
    );
    job = await transition(job, Status.Repairing);
    expect(job.tests).toEqual([]);
    job = await transition(job, Status.Testing);
    job = jobFrom(await change(job, 'tests', { tests: checks }).expect(201));
    job = await transition(job, Status.Ready);
    await change(
      job,
      'transitions',
      { status: 'DELIVERED', reason: 'Missing recipient' },
      reception,
    ).expect(400);
    // Phase 6: a completed repair must be invoiced and settled before handover.
    const existingSettings = await owner.agent.get('/api/v1/admin/repair/billing/settings');
    let settings = existingSettings.body as { configured: boolean; version: number };
    if (!settings.configured) {
      settings = (
        await owner.agent
          .post('/api/v1/admin/repair/billing/settings')
          .set('x-csrf-token', owner.csrf)
          .send({
            idempotencyKey: randomUUID(),
            expectedVersion: -1,
            issuer: { name: prefix, address: 'Test workshop address', phone: '+919876543210' },
            taxes: [],
            warrantyDays: 0,
            warrantyCoverage: 'No warranty in this test fixture',
            warrantyExclusions: 'Test fixture only',
          })
          .expect(201)
      ).body as { configured: boolean; version: number };
    }
    const invoiced = await owner.agent
      .post(`/api/v1/admin/repair/jobs/${job.number}/billing/invoice`)
      .set('x-csrf-token', owner.csrf)
      .send({
        idempotencyKey: randomUUID(),
        expectedJobVersion: job.version,
        expectedSettingsVersion: settings.version,
        estimateRevision: 1,
        lines: job.estimates[0].lines.map((line) => ({ ...line, kind: 'SERVICE' })),
        discountInPaise: 0,
        applyTax: false,
        expectedTotalInPaise: 299950,
        warrantyDays: 0,
        warrantyCoverage: 'No warranty in this test fixture',
        warrantyExclusions: 'Test fixture only',
        reason: 'Issue test invoice',
      })
      .expect(201);
    await owner.agent
      .post(`/api/v1/admin/repair/jobs/${job.number}/billing/payments`)
      .set('x-csrf-token', owner.csrf)
      .send({
        idempotencyKey: randomUUID(),
        expectedJobVersion: (invoiced.body as { jobVersion: number }).jobVersion,
        amountInPaise: 299950,
        method: 'CASH',
        reason: 'Test customer payment received',
      })
      .expect(201);
    job = jobFrom(await owner.agent.get(`/api/v1/admin/repair/jobs/${job.number}`).expect(200));
    job = jobFrom(
      await change(
        job,
        'transitions',
        { status: 'DELIVERED', reason: 'Device and case collected', recipient: 'Device owner' },
        reception,
      ).expect(201),
    );
    expect(job).toMatchObject({
      status: 'DELIVERED',
      custody: 'RETURNED',
      returnedTo: 'Device owner',
    });
    expect(job.returnedAt).toBeDefined();
    await change(job, 'transitions', {
      status: 'REPAIRING',
      reason: 'Cannot reopen closed repair',
    }).expect(409);
  });
  it('retains cancelled and unrepairable devices in custody until an explicit return', async () => {
    for (const status of [Status.Cancelled, Status.Unrepairable]) {
      let job = await transition(await create(), status, reception);
      expect(job.custody).toBe('IN_SHOP');
      const queue = (
        await reception.agent
          .get('/api/v1/admin/repair/jobs')
          .query({ search: job.number, custody: 'IN_SHOP' })
      ).body as { total: number };
      expect(queue.total).toBe(1);
      job = jobFrom(
        await change(
          job,
          'handover',
          { recipient: 'Device owner', reason: 'Unrepaired device returned with case' },
          reception,
        ).expect(201),
      );
      expect(job).toMatchObject({ status, custody: 'RETURNED' });
      await change(
        job,
        'handover',
        { recipient: 'Another person', reason: 'Duplicate handover attempt' },
        reception,
      ).expect(409);
    }
  });
  it('normalizes private photos, rejects non-images, guards delivery and removes bytes atomically', async () => {
    let job = await create();
    job = jobFrom(
      await owner.agent
        .patch(`/api/v1/admin/repair/jobs/${job.number}/assignment`)
        .set('x-csrf-token', owner.csrf)
        .send({
          expectedVersion: job.version,
          technicianId: technician.id,
          reason: 'Assigned photo intake',
        })
        .expect(200),
    );
    const url = `/api/v1/admin/repair/jobs/${job.number}/photos`;
    await reception.agent
      .post(url)
      .set('x-csrf-token', reception.csrf)
      .field('expectedVersion', job.version)
      .attach('file', Buffer.from('<svg><script>bad</script></svg>'), 'fake.png')
      .expect(400);
    const bytes = await sharp({
      create: { width: 2500, height: 500, channels: 3, background: '#10483f' },
    })
      .jpeg()
      .toBuffer();
    job = jobFrom(
      await technician.agent
        .post(url)
        .set('x-csrf-token', technician.csrf)
        .field('expectedVersion', job.version)
        .attach('file', bytes, 'intake.jpg')
        .expect(201),
    );
    expect(job.photos).toHaveLength(1);
    expect(job.photos[0].width).toBe(2000);
    const content = `/api/v1/${job.photos[0].url}`;
    await request(server).get(content).expect(401);
    await otherTech.agent.get(content).expect(404);
    const delivered = await technician.agent.get(content).expect(200);
    expect(delivered.headers['cache-control']).toBe('private, no-store');
    expect(delivered.headers['content-type']).toContain('image/webp');
    const metadata = await sharp(delivered.body as Buffer).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.format).toBe('webp');
    await technician.agent
      .post(url)
      .set('x-csrf-token', technician.csrf)
      .field('expectedVersion', job.version)
      .attach('file', bytes, 'duplicate.jpg')
      .expect(409);
    const id = job.photos[0].id;
    job = jobFrom(
      await reception.agent
        .delete(`${url}/${id}`)
        .set('x-csrf-token', reception.csrf)
        .send({ expectedVersion: job.version })
        .expect(200),
    );
    expect(job.photos).toEqual([]);
    expect(
      await connection.model(RepairJobPhoto.name).exists({ _id: new Types.ObjectId(id) }),
    ).toBeNull();
    await owner.agent.get(content).expect(404);
  });
  it('rejects invalid direct database amounts/custody and reruns migration without changing jobs', async () => {
    const job = await estimate();
    await expect(
      connection
        .collection('repair_jobs')
        .updateOne({ number: job.number }, { $set: { 'estimates.0.totalInPaise': 1.5 } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      connection
        .collection('repair_jobs')
        .updateOne({ number: job.number }, { $set: { 'estimates.0.totalInPaise': 1 } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      connection
        .collection('repair_jobs')
        .updateOne({ number: job.number }, { $set: { status: 'DELIVERED' } }),
    ).rejects.toMatchObject({ code: 121 });
    const count = await jobs.countDocuments();
    if (!connection.db) throw new Error('Missing database');
    await repairJobsMigration.up({ connection, database: connection.db });
    await repairInventoryMigration.up({ connection, database: connection.db });
    await repairBillingMigration.up({ connection, database: connection.db });
    expect(await jobs.countDocuments()).toBe(count);
    expect((await jobs.collection.indexes()).map((index) => index.name)).toContain(
      'uq_repair_job_booking',
    );
  });
  it('lets only the owner disable repair accounts and immediately revokes active sessions', async () => {
    const member = await users.findById(otherTech.id).orFail();
    await reception.agent
      .patch(`/api/v1/admin/repair/team/${otherTech.id}`)
      .set('x-csrf-token', reception.csrf)
      .send({ expectedVersion: member.get('version') as number, status: 'DISABLED' })
      .expect(403);
    await owner.agent
      .patch(`/api/v1/admin/repair/team/${otherTech.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({ expectedVersion: member.get('version') as number, status: 'DISABLED' })
      .expect(204);
    await otherTech.agent.get('/api/v1/admin/auth/me').expect(401);
    expect(
      await connection.model(AdminSession.name).countDocuments({
        adminUserId: new Types.ObjectId(otherTech.id),
        revokedAt: { $exists: false },
      }),
    ).toBe(0);
  });
});
