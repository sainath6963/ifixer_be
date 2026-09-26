import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Model } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { Customer, CustomerSession } from '../src/database/schemas/identity.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';

interface AddressBookBody {
  version: number;
  limit: number;
  addresses: Array<{
    id: string;
    label: string;
    fullName: string;
    phone: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode: 'IN';
    isDefault: boolean;
  }>;
}

const homeAddress = {
  label: 'Home',
  fullName: 'Address Book Customer',
  phone: '+919999999999',
  line1: '12 Culture Lane',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  countryCode: 'IN',
} as const;

describe('Customer saved addresses (e2e)', () => {
  const email = 'phase11-addresses@richculture.test';
  const password = 'Phase11-address-password';
  const startedAt = new Date();
  let app: INestApplication;
  let httpServer: Server;
  let customers: Model<Customer>;
  let sessions: Model<CustomerSession>;
  let auditLogs: Model<AuditLog>;

  async function cleanFixtures(): Promise<void> {
    const customer = await customers.findOne({ email }).select('_id');
    if (customer) {
      await sessions.deleteMany({ customerId: customer._id });
      await auditLogs.deleteMany({ actorId: customer._id, occurredAt: { $gte: startedAt } });
      await customers.deleteOne({ _id: customer._id });
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    customers = app.get(getModelToken(Customer.name));
    sessions = app.get(getModelToken(CustomerSession.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();
    await cleanFixtures();
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('enforces authentication, CSRF, versions, one default, and deletion promotion', async () => {
    await request(httpServer).get('/api/v1/customer/addresses').expect(401);

    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    const csrf = (csrfResponse.body as { csrfToken: string }).csrfToken;
    await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrf)
      .send({ name: 'Address Book Customer', email, password })
      .expect(201);

    const emptyResponse = await browser.get('/api/v1/customer/addresses').expect(200);
    expect(emptyResponse.headers['cache-control']).toBe('no-store');
    expect(emptyResponse.body).toEqual({ version: 0, limit: 10, addresses: [] });

    await browser
      .post('/api/v1/customer/addresses')
      .send({ ...homeAddress, expectedVersion: 0 })
      .expect(403);

    const createdHome = await browser
      .post('/api/v1/customer/addresses')
      .set('x-csrf-token', csrf)
      .send({ ...homeAddress, expectedVersion: 0 })
      .expect(201);
    const firstBook = createdHome.body as AddressBookBody;
    expect(firstBook).toMatchObject({
      version: 1,
      limit: 10,
      addresses: [{ label: 'Home', isDefault: true, countryCode: 'IN' }],
    });
    const homeId = firstBook.addresses[0].id;

    await browser
      .post('/api/v1/customer/addresses')
      .set('x-csrf-token', csrf)
      .send({ ...homeAddress, label: 'Stale', expectedVersion: 0 })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'ADDRESS_BOOK_VERSION_CONFLICT' });
      });

    const createdWork = await browser
      .post('/api/v1/customer/addresses')
      .set('x-csrf-token', csrf)
      .send({
        ...homeAddress,
        label: 'Work',
        line1: '44 Studio Road',
        expectedVersion: firstBook.version,
      })
      .expect(201);
    const secondBook = createdWork.body as AddressBookBody;
    expect(secondBook.version).toBe(2);
    expect(secondBook.addresses).toHaveLength(2);
    expect(secondBook.addresses.filter((address) => address.isDefault)).toHaveLength(1);
    const workId = secondBook.addresses.find((address) => address.label === 'Work')?.id;
    expect(workId).toEqual(expect.any(String));
    if (!workId) throw new Error('Expected work address ID');

    const updatedHome = await browser
      .put(`/api/v1/customer/addresses/${homeId}`)
      .set('x-csrf-token', csrf)
      .send({
        ...homeAddress,
        label: 'Primary home',
        line2: 'Near the old library',
        expectedVersion: secondBook.version,
      })
      .expect(200);
    const thirdBook = updatedHome.body as AddressBookBody;
    expect(thirdBook.addresses.find((address) => address.id === homeId)).toMatchObject({
      label: 'Primary home',
      line2: 'Near the old library',
      isDefault: true,
    });

    const defaultedWork = await browser
      .post(`/api/v1/customer/addresses/${workId}/default`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: thirdBook.version })
      .expect(201);
    const fourthBook = defaultedWork.body as AddressBookBody;
    expect(fourthBook.addresses.find((address) => address.id === workId)?.isDefault).toBe(true);
    expect(fourthBook.addresses.find((address) => address.id === homeId)?.isDefault).toBe(false);

    const removedWork = await browser
      .delete(`/api/v1/customer/addresses/${workId}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: fourthBook.version })
      .expect(200);
    const finalBook = removedWork.body as AddressBookBody;
    expect(finalBook.addresses).toEqual([
      expect.objectContaining({ id: homeId, label: 'Primary home', isDefault: true }),
    ]);

    await browser
      .put('/api/v1/customer/addresses/not-an-object-id')
      .set('x-csrf-token', csrf)
      .send({ ...homeAddress, expectedVersion: finalBook.version })
      .expect(400);

    const customer = await customers.findOne({ email }).orFail();
    const actions = await auditLogs.distinct('action', {
      actorId: customer._id,
      occurredAt: { $gte: startedAt },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        'CUSTOMER_ADDRESS_CREATED',
        'CUSTOMER_ADDRESS_UPDATED',
        'CUSTOMER_ADDRESS_DEFAULTED',
        'CUSTOMER_ADDRESS_DELETED',
      ]),
    );
  }, 60_000);
});
