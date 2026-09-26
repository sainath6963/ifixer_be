import { repairBillingMigration } from '../src/database/migrations/026-repair-billing';
import { repairInventoryMigration } from '../src/database/migrations/025-repair-inventory';
import { repairJobsMigration } from '../src/database/migrations/024-repair-jobs';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { repairCatalogBookingsMigration } from '../src/database/migrations/023-repair-catalog-bookings';
import {
  AdminUser,
  AdminSession,
  Customer,
  CustomerSession,
} from '../src/database/schemas/identity.schema';
import {
  DeviceBrand,
  DeviceModel,
  RepairService,
  RepairServiceOption,
  RepairBooking,
} from '../src/database/schemas/repair.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { AccountStatus, AdminRole } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import type { CreateRepairBookingDto } from '../src/modules/repair-bookings/repair-booking.dto';

interface Entry {
  id: string;
  version: number;
  active: boolean;
}
interface Booking {
  reference: string;
  version: number;
  status: string;
  requestedVisitAt?: string;
  confirmedVisitAt?: string;
  indicativePriceInPaise?: number;
  history: unknown[];
  customerId?: string;
}
const entryFrom = (response: request.Response): Entry => (response.body as { entry: Entry }).entry;
const bookingFrom = (response: request.Response): Booking =>
  (response.body as { booking: Booking }).booking;
const future = (days = 3): string => new Date(Date.now() + days * 86400000).toISOString();
const credentials = (): { idempotencyKey: string; manageToken: string } => ({
  idempotencyKey: randomUUID(),
  manageToken: randomBytes(32).toString('hex'),
});

describe('Repair catalog and private bookings (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let connection: Connection;
  let admin: ReturnType<typeof request.agent>;
  let guest: ReturnType<typeof request.agent>;
  let adminCsrf: string;
  let guestCsrf: string;
  let adminId: Types.ObjectId;
  let brand: Entry;
  let model: Entry;
  let service: Entry;
  let option: Entry;
  let bookings: Model<RepairBooking>;
  const prefix = `repair-${randomUUID().slice(0, 8)}`;
  const password = 'Repair-test-password-123';
  const input = (extra: Partial<CreateRepairBookingDto> = {}): CreateRepairBookingDto => ({
    ...credentials(),
    customerName: 'Repair Test Customer',
    phone: '+919876543210',
    deviceDescription: 'Unlisted phone',
    issue: 'The display flickers after a fall.',
    requestedVisitAt: future(),
    ...extra,
  });
  const create = (body: CreateRepairBookingDto): request.Test =>
    guest.post('/api/v1/repair/bookings').set('x-csrf-token', guestCsrf).send(body);

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
    bookings = app.get(getModelToken(RepairBooking.name));
    await app.get(MigrationRunner).run();
    const users = app.get<Model<AdminUser>>(getModelToken(AdminUser.name));
    const owner = await users.create({
      name: 'Repair Staff',
      email: `${prefix}@example.test`,
      passwordHash: await app.get(PasswordService).hash(password),
      roles: [AdminRole.Staff],
      status: AccountStatus.Active,
    });
    adminId = owner._id;
    admin = request.agent(server);
    guest = request.agent(server);
    adminCsrf = ((await admin.get('/api/v1/admin/auth/csrf')).body as { csrfToken: string })
      .csrfToken;
    guestCsrf = ((await guest.get('/api/v1/customer/auth/csrf')).body as { csrfToken: string })
      .csrfToken;
    await admin
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', adminCsrf)
      .send({ email: `${prefix}@example.test`, password })
      .expect(200);
    brand = entryFrom(
      await admin
        .post('/api/v1/admin/repair/catalog/brands')
        .set('x-csrf-token', adminCsrf)
        .send({ name: 'Test Devices', slug: prefix, active: true })
        .expect(201),
    );
    model = entryFrom(
      await admin
        .post('/api/v1/admin/repair/catalog/models')
        .set('x-csrf-token', adminCsrf)
        .send({ name: 'Test Model', slug: 'model', brandId: brand.id, active: true })
        .expect(201),
    );
    service = entryFrom(
      await admin
        .post('/api/v1/admin/repair/catalog/services')
        .set('x-csrf-token', adminCsrf)
        .send({
          name: 'Display repair',
          slug: prefix,
          description: 'Display assessment and repair.',
          active: true,
          pricingMode: 'DIAGNOSIS',
        })
        .expect(201),
    );
    option = entryFrom(
      await admin
        .post('/api/v1/admin/repair/catalog/options')
        .set('x-csrf-token', adminCsrf)
        .send({
          modelId: model.id,
          serviceId: service.id,
          active: true,
          pricingMode: 'INDICATIVE',
          priceInPaise: 249950,
        })
        .expect(201),
    );
  }, 60000);

  afterAll(async () => {
    if (!app) return;
    await bookings.deleteMany({ customerName: 'Repair Test Customer' });
    for (const [name, filter] of [
      [DeviceBrand.name, { slug: prefix }],
      [DeviceModel.name, { brandId: new Types.ObjectId(brand?.id) }],
      [RepairService.name, { slug: prefix }],
      [RepairServiceOption.name, { serviceId: new Types.ObjectId(service?.id) }],
    ] as const)
      await connection.model(name).deleteMany(filter);
    await app
      .get<Model<AdminSession>>(getModelToken(AdminSession.name))
      .deleteMany({ adminUserId: adminId });
    await app.get<Model<AdminUser>>(getModelToken(AdminUser.name)).deleteOne({ _id: adminId });
    const customers = app.get<Model<Customer>>(getModelToken(Customer.name));
    const customerRows = await customers.find({ email: new RegExp(`^${prefix}`) });
    await app
      .get<Model<CustomerSession>>(getModelToken(CustomerSession.name))
      .deleteMany({ customerId: { $in: customerRows.map((row) => row._id) } });
    await customers.deleteMany({ _id: { $in: customerRows.map((row) => row._id) } });
    await app
      .get<Model<AuditLog>>(getModelToken(AuditLog.name))
      .deleteMany({ resourceType: { $in: ['REPAIR_BOOKING', 'REPAIR_CATALOG'] } });
    await app.close();
  });

  it('persists a compatible request, snapshots the indicative estimate and exposes it in the staff queue', async () => {
    const body = input({
      brandId: brand.id,
      modelId: model.id,
      serviceId: service.id,
      deviceDescription: undefined,
    });
    const response = await create(body).expect(201);
    const booking = bookingFrom(response);
    expect(booking).toMatchObject({
      status: 'REQUESTED',
      version: 0,
      requestedVisitAt: body.requestedVisitAt,
      indicativePriceInPaise: 249950,
    });
    expect(booking.confirmedVisitAt).toBeUndefined();
    const saved = await bookings
      .findOne({ reference: booking.reference })
      .select('+manageTokenHash')
      .orFail();
    expect(saved.manageTokenHash).not.toBe(body.manageToken);
    expect(saved.customerId).toBeUndefined();
    expect(response.text).not.toContain('manageTokenHash');
    expect(response.text).not.toContain('requestHash');
    expect(response.text).not.toContain('actorId');
    const queue = await admin
      .get('/api/v1/admin/repair/bookings')
      .query({ search: booking.reference, status: 'REQUESTED' })
      .expect(200);
    expect((queue.body as { total: number }).total).toBe(1);
    const audit = app.get<Model<AuditLog>>(getModelToken(AuditLog.name));
    expect(
      await audit.countDocuments({ resourceId: saved.id, action: 'REPAIR_BOOKING_CREATED' }),
    ).toBe(1);
  });

  it('collapses simultaneous retries and rejects a reused key with different content or credentials', async () => {
    const body = input();
    const results = await Promise.all([create(body), create(body), create(body)]);
    expect(results.map((row) => row.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((row) => bookingFrom(row).reference)).size).toBe(1);
    expect(await bookings.countDocuments({ operationKey: `online:${body.idempotencyKey}` })).toBe(
      1,
    );
    await create({ ...body, issue: 'A different issue for this reused key.' }).expect(409);
    await create({ ...body, manageToken: randomBytes(32).toString('hex') }).expect(409);
  });

  it('requires private access, never uses phone matching as account ownership and enforces CSRF/admin guards', async () => {
    const body = input();
    const booking = bookingFrom(await create(body).expect(201));
    await request(server).get(`/api/v1/repair/bookings/${booking.reference}`).expect(404);
    await request(server)
      .get(`/api/v1/repair/bookings/${booking.reference}`)
      .set('x-repair-token', randomBytes(32).toString('hex'))
      .expect(404);
    await guest
      .get(`/api/v1/repair/bookings/${booking.reference}`)
      .set('x-repair-token', body.manageToken)
      .expect(200);
    await guest
      .patch(`/api/v1/repair/bookings/${booking.reference}`)
      .set('x-repair-token', body.manageToken)
      .send({ expectedVersion: 0, action: 'CANCEL', reason: 'No longer needed' })
      .expect(403);
    await request(server).post('/api/v1/repair/bookings').send(input()).expect(403);
    await request(server).get('/api/v1/admin/repair/bookings').expect(401);
    await guest.get('/api/v1/admin/repair/catalog').expect(401);
    await guest
      .patch(`/api/v1/repair/bookings/${booking.reference}`)
      .set('x-repair-token', body.manageToken)
      .set('x-csrf-token', guestCsrf)
      .send({
        expectedVersion: 0,
        action: 'CONFIRM',
        visitAt: future(),
        reason: 'Confirm without staff',
      })
      .expect(400);
  });

  it('confirms, reschedules, reconfirms and cancels with version checks and a complete history', async () => {
    const body = input();
    const booking = bookingFrom(await create(body).expect(201));
    const url = `/api/v1/admin/repair/bookings/${booking.reference}`;
    const confirmed = bookingFrom(
      await admin
        .patch(url)
        .set('x-csrf-token', adminCsrf)
        .send({
          expectedVersion: 0,
          action: 'CONFIRM',
          visitAt: future(4),
          reason: 'Time agreed with customer',
        })
        .expect(200),
    );
    expect(confirmed).toMatchObject({
      status: 'CONFIRMED',
      version: 1,
      requestedVisitAt: body.requestedVisitAt,
    });
    expect(confirmed.confirmedVisitAt).toBeDefined();
    await admin
      .patch(url)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 0, action: 'CANCEL', reason: 'Stale client update' })
      .expect(409);
    const rescheduled = bookingFrom(
      await guest
        .patch(`/api/v1/repair/bookings/${booking.reference}`)
        .set('x-csrf-token', guestCsrf)
        .set('x-repair-token', body.manageToken)
        .send({
          expectedVersion: 1,
          action: 'RESCHEDULE',
          visitAt: future(5),
          reason: 'Need a later visit',
        })
        .expect(200),
    );
    expect(rescheduled).toMatchObject({ status: 'REQUESTED', version: 2 });
    expect(rescheduled.confirmedVisitAt).toBeUndefined();
    await admin
      .patch(url)
      .set('x-csrf-token', adminCsrf)
      .send({
        expectedVersion: 2,
        action: 'CONFIRM',
        visitAt: future(5),
        reason: 'New time agreed',
      })
      .expect(200);
    const cancelled = bookingFrom(
      await guest
        .patch(`/api/v1/repair/bookings/${booking.reference}`)
        .set('x-csrf-token', guestCsrf)
        .set('x-repair-token', body.manageToken)
        .send({ expectedVersion: 3, action: 'CANCEL', reason: 'Phone no longer needs repair' })
        .expect(200),
    );
    expect(cancelled).toMatchObject({ status: 'CANCELLED', version: 4 });
    expect(cancelled.history).toHaveLength(5);
    await admin
      .patch(url)
      .set('x-csrf-token', adminCsrf)
      .send({
        expectedVersion: 4,
        action: 'CONFIRM',
        visitAt: future(5),
        reason: 'Attempt reopening',
      })
      .expect(409);
  });

  it('allows only one concurrent visit change and records only its winning history event', async () => {
    const booking = bookingFrom(await create(input()).expect(201));
    const url = `/api/v1/admin/repair/bookings/${booking.reference}`;
    const results = await Promise.all(
      ['First cancellation', 'Second cancellation'].map((reason) =>
        admin
          .patch(url)
          .set('x-csrf-token', adminCsrf)
          .send({ expectedVersion: 0, action: 'CANCEL', reason }),
      ),
    );
    expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
    expect(
      (await bookings.findOne({ reference: booking.reference }).orFail()).history,
    ).toHaveLength(2);
  });

  it('rejects bad dates, unsupported model/service pairs, missing device details and privileged input fields', async () => {
    await create(input({ requestedVisitAt: '2020-01-01T12:00:00Z' })).expect(400);
    await create(input({ requestedVisitAt: future(200) })).expect(400);
    await create(input({ deviceDescription: undefined })).expect(400);
    await create(input({ modelId: model.id, brandId: undefined })).expect(409);
    await create(input({ modelId: new Types.ObjectId().toHexString(), brandId: brand.id })).expect(
      409,
    );
    await guest
      .post('/api/v1/repair/bookings')
      .set('x-csrf-token', guestCsrf)
      .send({ ...input(), status: 'CONFIRMED', customerId: new Types.ObjectId().toHexString() })
      .expect(400);
    await admin
      .patch(`/api/v1/admin/repair/catalog/options/${option.id}`)
      .set('x-csrf-token', adminCsrf)
      .send({
        expectedVersion: 0,
        modelId: model.id,
        serviceId: service.id,
        active: false,
        pricingMode: 'INDICATIVE',
        priceInPaise: 249950,
      })
      .expect(200);
    await create(input({ brandId: brand.id, modelId: model.id, serviceId: service.id })).expect(
      409,
    );
    await admin
      .patch(`/api/v1/admin/repair/catalog/options/${option.id}`)
      .set('x-csrf-token', adminCsrf)
      .send({
        expectedVersion: 1,
        modelId: model.id,
        serviceId: service.id,
        active: true,
        pricingMode: 'INDICATIVE',
        priceInPaise: 249950,
      })
      .expect(200);
  });

  it('archives catalogs without deleting snapshots, rejects stale edits and validates pricing at database level', async () => {
    const booking = bookingFrom(
      await create(input({ brandId: brand.id, modelId: model.id, serviceId: service.id })).expect(
        201,
      ),
    );
    await admin
      .patch(`/api/v1/admin/repair/catalog/brands/${brand.id}`)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 0, name: 'Renamed brand', slug: prefix, active: false })
      .expect(200);
    const catalog = (await request(server).get('/api/v1/repair/catalog').expect(200)).body as {
      brands: Entry[];
      models: Entry[];
      options: Entry[];
    };
    expect(catalog.brands.some((row) => row.id === brand.id)).toBe(false);
    expect(catalog.models.some((row) => row.id === model.id)).toBe(false);
    expect(catalog.options.some((row) => row.id === option.id)).toBe(false);
    expect(
      (await admin.get(`/api/v1/admin/repair/bookings/${booking.reference}`).expect(200)).text,
    ).toContain('Test Devices Test Model');
    await admin
      .patch(`/api/v1/admin/repair/catalog/brands/${brand.id}`)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 0, name: 'Stale', slug: prefix, active: true })
      .expect(409);
    await admin
      .post('/api/v1/admin/repair/catalog/services')
      .set('x-csrf-token', adminCsrf)
      .send({
        name: 'Invalid',
        slug: prefix,
        description: 'Invalid pricing example',
        active: true,
        pricingMode: 'INDICATIVE',
      })
      .expect(400);
    await expect(
      connection
        .collection('repair_service_options')
        .updateOne({ _id: new Types.ObjectId(option.id) }, { $set: { priceInPaise: 1.5 } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      connection
        .collection('repair_bookings')
        .updateOne({ reference: booking.reference }, { $set: { status: 'CONFIRMED' } }),
    ).rejects.toMatchObject({ code: 121 });
    await admin
      .patch(`/api/v1/admin/repair/catalog/brands/${brand.id}`)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 1, name: 'Test Devices', slug: prefix, active: true })
      .expect(200);
  });

  it('records walk-ins and links online bookings only to the authenticated customer', async () => {
    const walkIn = bookingFrom(
      await admin
        .post('/api/v1/admin/repair/bookings')
        .set('x-csrf-token', adminCsrf)
        .send(input())
        .expect(201),
    );
    expect((await admin.get(`/api/v1/admin/repair/bookings/${walkIn.reference}`)).text).toContain(
      'WALK_IN',
    );
    const browser = request.agent(server);
    const csrf = ((await browser.get('/api/v1/customer/auth/csrf')).body as { csrfToken: string })
      .csrfToken;
    await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrf)
      .send({ name: 'Repair account', email: `${prefix}-customer@example.test`, password })
      .expect(201);
    const body = input();
    const linked = bookingFrom(
      await browser
        .post('/api/v1/repair/bookings')
        .set('x-csrf-token', csrf)
        .send(body)
        .expect(201),
    );
    expect(
      (await bookings.findOne({ reference: linked.reference }).orFail()).customerId,
    ).toBeDefined();
    await browser.get(`/api/v1/repair/bookings/${linked.reference}`).expect(200);
    const anonymous = bookingFrom(await create(input({ phone: body.phone })).expect(201));
    await browser.get(`/api/v1/repair/bookings/${anonymous.reference}`).expect(404);
    await guest.get(`/api/v1/repair/bookings/${linked.reference}`).expect(404);
  });

  it('reruns the additive migration without changing existing bookings or dropping indexes', async () => {
    const count = await bookings.countDocuments();
    if (!connection.db) throw new Error('Database not available');
    await repairCatalogBookingsMigration.up({ connection, database: connection.db });
    await repairJobsMigration.up({ connection, database: connection.db });
    await repairInventoryMigration.up({ connection, database: connection.db });
    await repairBillingMigration.up({ connection, database: connection.db });
    expect(await bookings.countDocuments()).toBe(count);
    expect((await bookings.collection.indexes()).map((index) => index.name)).toContain(
      'uq_repair_booking_operation',
    );
  });
});
