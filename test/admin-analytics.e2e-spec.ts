import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Model, Types } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { AdminSession, AdminUser, Customer } from '../src/database/schemas/identity.schema';
import { PaymentAttempt, Refund } from '../src/database/schemas/payment.schema';
import {
  AccountStatus,
  AdminRole,
  PaymentAttemptStatus,
  PaymentProvider,
  RefundStatus,
} from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';

describe('Admin business analytics (e2e)', () => {
  const email = 'phase20-owner@richculture.test';
  const password = 'Phase20-owner-password';
  const capturedAt = new Date('2024-02-10T06:30:00.000Z');
  const orderId = new Types.ObjectId();
  let app: INestApplication;
  let httpServer: Server;
  let adminUsers: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let customers: Model<Customer>;
  let payments: Model<PaymentAttempt>;
  let refunds: Model<Refund>;
  let adminId: Types.ObjectId;
  let customerId: Types.ObjectId;
  let paymentId: Types.ObjectId;
  let refundId: Types.ObjectId;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    await app.get(MigrationRunner).run();
    adminUsers = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    customers = app.get(getModelToken(Customer.name));
    payments = app.get(getModelToken(PaymentAttempt.name));
    refunds = app.get(getModelToken(Refund.name));

    const passwordHash = await app.get(PasswordService).hash(password);
    const admin = await adminUsers.create({
      name: 'Phase 20 Owner',
      email,
      passwordHash,
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    adminId = admin._id;
    const customer = await customers.create({
      name: 'Phase 20 Customer',
      email: 'phase20-customer@richculture.test',
      status: AccountStatus.Active,
      addresses: [],
    });
    customerId = customer._id;
    await customers.collection.updateOne(
      { _id: customerId },
      { $set: { createdAt: capturedAt, updatedAt: capturedAt } },
    );
    const payment = await payments.create({
      orderId,
      orderNumber: 'RC-PHASE20-0001',
      attemptNumber: 1,
      idempotencyKey: 'phase20-analytics-payment-0001',
      idempotencyRequestHash: 'a'.repeat(64),
      provider: PaymentProvider.Razorpay,
      amountInPaise: 100_000,
      currency: 'INR',
      status: PaymentAttemptStatus.Captured,
      providerReceipt: 'RC-PHASE20-0001',
      providerOrderId: 'order_PHASE20ANALYTICS0001',
      providerPaymentId: 'pay_PHASE20ANALYTICS000001',
      capturedAt,
    });
    paymentId = payment._id;
    const refund = await refunds.create({
      refundNumber: 'RCR-PHASE20-0001',
      orderId,
      paymentAttemptId: payment._id,
      idempotencyKey: 'phase20-analytics-refund-0001',
      idempotencyRequestHash: 'b'.repeat(64),
      provider: PaymentProvider.Razorpay,
      providerReceipt: 'RCR-PHASE20-0001',
      providerPaymentId: payment.providerPaymentId,
      amountInPaise: 25_000,
      providerFeeInPaise: 0,
      currency: 'INR',
      status: RefundStatus.Succeeded,
      providerRefundId: 'rfnd_PHASE20ANALYTICS0001',
      reason: 'Phase 20 analytics verification refund',
      requestedBy: admin._id,
      processedAt: capturedAt,
    });
    refundId = refund._id;
  }, 60_000);

  afterAll(async () => {
    if (refundId) await refunds.deleteOne({ _id: refundId });
    if (paymentId) await payments.deleteOne({ _id: paymentId });
    if (customerId) await customers.deleteOne({ _id: customerId });
    if (adminId) {
      await adminSessions.deleteMany({ adminUserId: adminId });
      await adminUsers.deleteOne({ _id: adminId });
    }
    await app.close();
  });

  it('protects reports and returns provider-backed KPIs plus a safe CSV', async () => {
    await request(httpServer).get('/api/v1/admin/analytics').expect(401);
    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/admin/auth/csrf').expect(200);
    const csrf = (csrfResponse.body as { csrfToken: string }).csrfToken;
    await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);

    await browser
      .get('/api/v1/admin/analytics?dateFrom=2024-02-10&dateTo=2024-02-10')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          period: { dateFrom: '2024-02-10', dateTo: '2024-02-10', days: 1 },
          kpis: {
            grossSalesInPaise: { value: 100_000 },
            refundsInPaise: { value: 25_000 },
            netRevenueInPaise: { value: 75_000 },
            paidOrders: { value: 1 },
            averageOrderValueInPaise: { value: 100_000 },
            newCustomers: { value: 1 },
          },
          trend: [
            {
              key: '2024-02-10',
              grossSalesInPaise: 100_000,
              refundsInPaise: 25_000,
              netRevenueInPaise: 75_000,
            },
          ],
        });
      });

    await browser
      .get('/api/v1/admin/analytics/export.csv?dateFrom=2024-02-10&dateTo=2024-02-10')
      .expect('Content-Type', /text\/csv/)
      .expect('Content-Disposition', /ifixer-analytics-2024-02-10-to-2024-02-10\.csv/)
      .expect(200)
      .expect(({ text }: request.Response) => {
        expect(text).toContain('"2024-02-10","1000.00","250.00","750.00"');
        expect(text).not.toContain(email);
      });
  });
});
