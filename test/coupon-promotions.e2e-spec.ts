import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Model, Types } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { Coupon, CouponRedemption } from '../src/database/schemas/coupon.schema';
import { AdminSession, AdminUser } from '../src/database/schemas/identity.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { AccountStatus, AdminRole, CouponDiscountType, CouponStatus } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';

interface CouponBody {
  coupon: {
    id: string;
    code: string;
    status: CouponStatus;
    availability: string;
    version: number;
  };
}

describe('Coupon promotion administration (e2e)', () => {
  const ownerEmail = 'phase16-owner@richculture.test';
  const staffEmail = 'phase16-staff@richculture.test';
  const password = 'Phase16-admin-password';
  const startedAt = new Date();
  let app: INestApplication;
  let httpServer: Server;
  let admins: Model<AdminUser>;
  let sessions: Model<AdminSession>;
  let coupons: Model<Coupon>;
  let redemptions: Model<CouponRedemption>;
  let audits: Model<AuditLog>;
  let adminIds: Types.ObjectId[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    admins = app.get(getModelToken(AdminUser.name));
    sessions = app.get(getModelToken(AdminSession.name));
    coupons = app.get(getModelToken(Coupon.name));
    redemptions = app.get(getModelToken(CouponRedemption.name));
    audits = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();
    await cleanup();

    const passwordHash = await app.get(PasswordService).hash(password);
    const created = await admins.create([
      {
        name: 'Phase 16 Owner',
        email: ownerEmail,
        passwordHash,
        roles: [AdminRole.Owner],
        status: AccountStatus.Active,
      },
      {
        name: 'Phase 16 Staff',
        email: staffEmail,
        passwordHash,
        roles: [AdminRole.Staff],
        status: AccountStatus.Active,
      },
    ]);
    adminIds = created.map((admin) => admin._id);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanup();
    await app.close();
  });

  it('creates strict coupon indexes and rejects invalid raw records', async () => {
    expect((await coupons.collection.indexes()).map((index) => index.name)).toEqual(
      expect.arrayContaining(['uq_coupons_code', 'ix_coupons_status_window']),
    );
    expect((await redemptions.collection.indexes()).map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'uq_coupon_redemptions_order',
        'uq_coupon_redemptions_customer_active',
        'ix_coupon_redemptions_expiry',
      ]),
    );
    await expect(
      coupons.collection.insertOne({
        code: 'invalid code',
        name: 'Invalid coupon',
        status: 'ACTIVE',
      }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it('allows OWNER management, STAFF read-only access, and optimistic updates', async () => {
    const owner = request.agent(httpServer);
    const staff = request.agent(httpServer);
    const ownerCsrfResponse = await owner.get('/api/v1/admin/auth/csrf').expect(200);
    const staffCsrfResponse = await staff.get('/api/v1/admin/auth/csrf').expect(200);
    const ownerCsrf = (ownerCsrfResponse.body as { csrfToken: string }).csrfToken;
    const staffCsrf = (staffCsrfResponse.body as { csrfToken: string }).csrfToken;
    await owner
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', ownerCsrf)
      .send({ email: ownerEmail, password })
      .expect(200);
    await staff
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', staffCsrf)
      .send({ email: staffEmail, password })
      .expect(200);

    const input = {
      code: 'phase16-welcome',
      name: 'Phase 16 welcome campaign',
      description: 'A controlled percentage promotion.',
      discountType: CouponDiscountType.Percentage,
      percentageOff: 15,
      maximumDiscountInPaise: 50_000,
      minimumSubtotalInPaise: 100_000,
      usageLimit: 3,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    await staff
      .post('/api/v1/admin/coupons')
      .set('x-csrf-token', staffCsrf)
      .send(input)
      .expect(403);
    await owner
      .post('/api/v1/admin/coupons')
      .set('x-csrf-token', ownerCsrf)
      .send({ ...input, code: 'PHASE16-INVALID', percentageOff: undefined })
      .expect(400)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'COUPON_DISCOUNT_INVALID' });
      });

    const createResponse = await owner
      .post('/api/v1/admin/coupons')
      .set('x-csrf-token', ownerCsrf)
      .send(input)
      .expect(201);
    const created = (createResponse.body as CouponBody).coupon;
    expect(created).toMatchObject({
      code: 'PHASE16-WELCOME',
      status: CouponStatus.Draft,
      availability: 'DRAFT',
      version: 0,
    });

    await owner
      .post('/api/v1/admin/coupons')
      .set('x-csrf-token', ownerCsrf)
      .send(input)
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'COUPON_CODE_CONFLICT' });
      });
    await staff
      .get('/api/v1/admin/coupons?search=welcome&status=DRAFT')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ total: 1, items: [{ id: created.id }] });
      });

    const edit = await owner
      .patch(`/api/v1/admin/coupons/${created.id}`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: 0,
        name: 'Updated Phase 16 welcome campaign',
        usageLimit: 4,
      })
      .expect(200);
    expect((edit.body as CouponBody).coupon.version).toBe(1);

    const activate = await owner
      .patch(`/api/v1/admin/coupons/${created.id}`)
      .set('x-csrf-token', ownerCsrf)
      .send({ expectedVersion: 1, status: CouponStatus.Active })
      .expect(200);
    expect((activate.body as CouponBody).coupon).toMatchObject({
      status: CouponStatus.Active,
      availability: 'LIVE',
      version: 2,
    });
    await owner
      .patch(`/api/v1/admin/coupons/${created.id}`)
      .set('x-csrf-token', ownerCsrf)
      .send({ expectedVersion: 1, status: CouponStatus.Paused })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'COUPON_VERSION_CONFLICT' });
      });

    expect(
      await audits.distinct('action', {
        actorId: adminIds[0],
        occurredAt: { $gte: startedAt },
      }),
    ).toEqual(expect.arrayContaining(['COUPON_CREATED', 'COUPON_UPDATED']));
  }, 60_000);

  async function cleanup(): Promise<void> {
    await redemptions?.deleteMany({ code: /^PHASE16-/ });
    await coupons?.deleteMany({ code: /^PHASE16-/ });
    if (adminIds.length) {
      await sessions?.deleteMany({ adminUserId: { $in: adminIds } });
      await admins?.deleteMany({ _id: { $in: adminIds } });
      await audits?.deleteMany({ actorId: { $in: adminIds }, occurredAt: { $gte: startedAt } });
    } else if (admins) {
      const existing = await admins
        .find({ email: { $in: [ownerEmail, staffEmail] } })
        .select('_id');
      const ids = existing.map((admin) => admin._id);
      await sessions?.deleteMany({ adminUserId: { $in: ids } });
      await admins.deleteMany({ _id: { $in: ids } });
    }
  }
});
