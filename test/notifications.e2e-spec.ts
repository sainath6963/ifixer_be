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
import {
  AdminSession,
  AdminUser,
  Customer,
  CustomerMobileChallenge,
} from '../src/database/schemas/identity.schema';
import { OutboxEvent } from '../src/database/schemas/integration.schema';
import { Notification } from '../src/database/schemas/notification.schema';
import { Order } from '../src/database/schemas/order.schema';
import { Refund } from '../src/database/schemas/payment.schema';
import { ReturnRequest } from '../src/database/schemas/return-request.schema';
import {
  AccountStatus,
  AdminRole,
  AuditActorType,
  NotificationChannel,
  NotificationStatus,
  OutboxStatus,
  PaymentProvider,
  RefundStatus,
  ReturnReason,
  ReturnRequestStatus,
  ReturnRequestType,
  ShipmentStatus,
  ShippingProvider,
} from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import { EmailGatewayService } from '../src/modules/notifications/email-gateway.service';
import { MessageGatewayService } from '../src/modules/notifications/message-gateway.service';
import { NotificationDeliveryService } from '../src/modules/notifications/notification-delivery.service';
import { NotificationProcessor } from '../src/modules/notifications/notification.processor';
import { NotificationQueueScheduler } from '../src/modules/notifications/notification-queue.scheduler';
import type {
  EmailSendInput,
  MessageSendInput,
} from '../src/modules/notifications/notification.types';
import { OutboxRelayService } from '../src/modules/notifications/outbox-relay.service';

describe('Reliable notification outbox (e2e)', () => {
  const ownerEmail = 'phase10-owner@richculture.test';
  const customerEmail = 'phase10-customer@richculture.test';
  const password = 'Phase10-admin-password';
  const orderNumber = 'RC-PHASE10-0001';
  const paymentEventId = 'phase10-order-paid';
  const lateEventId = 'phase10-late-payment';

  let app: INestApplication;
  let httpServer: Server;
  let browser: ReturnType<typeof request.agent>;
  let csrf: string;
  let adminUsers: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let customers: Model<Customer>;
  let mobileChallenges: Model<CustomerMobileChallenge>;
  let orders: Model<Order>;
  let outbox: Model<OutboxEvent>;
  let notifications: Model<Notification>;
  let refunds: Model<Refund>;
  let returns: Model<ReturnRequest>;
  let relay: OutboxRelayService;
  let delivery: NotificationDeliveryService;

  const fakeEmail = {
    send: jest.fn((input: EmailSendInput): Promise<{ messageId: string }> =>
      Promise.resolve({ messageId: `<${input.deliveryKey}@richculture.test>` }),
    ),
  };
  const fakeMessages = {
    send: jest.fn((input: MessageSendInput): Promise<{ messageId: string }> =>
      Promise.resolve({ messageId: `message-${input.deliveryKey}` }),
    ),
  };

  async function cleanFixtures(): Promise<void> {
    await notifications.deleteMany({
      $or: [{ sourceEventId: /^phase10-/ }, { recipient: /^\+919999/ }],
    });
    await outbox.deleteMany({
      $or: [{ eventId: /^phase10-/ }, { eventType: 'CUSTOMER_MOBILE_OTP_REQUESTED' }],
    });
    await refunds.deleteMany({ refundNumber: /^RF-PHASE10-/ });
    await returns.deleteMany({ orderNumber: /^RC-PHASE10-/ });
    await mobileChallenges.deleteMany({ targetMobile: /^\+919999/ });
    await customers.deleteMany({ email: /^phase10-customer/ });
    await orders.deleteMany({ orderNumber: /^RC-PHASE10-/ });
    const admins = await adminUsers.find({ email: /^phase10-/ }).select('_id');
    const adminIds = admins.map((admin) => admin._id);
    await adminSessions.deleteMany({ adminUserId: { $in: adminIds } });
    await adminUsers.deleteMany({ _id: { $in: adminIds } });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    })
      .overrideProvider(EmailGatewayService)
      .useValue(fakeEmail)
      .overrideProvider(MessageGatewayService)
      .useValue(fakeMessages)
      .overrideProvider(NotificationProcessor)
      .useValue({})
      .overrideProvider(NotificationQueueScheduler)
      .useValue({})
      .compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    adminUsers = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    customers = app.get(getModelToken(Customer.name));
    mobileChallenges = app.get(getModelToken(CustomerMobileChallenge.name));
    orders = app.get(getModelToken(Order.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    notifications = app.get(getModelToken(Notification.name));
    refunds = app.get(getModelToken(Refund.name));
    returns = app.get(getModelToken(ReturnRequest.name));
    relay = app.get(OutboxRelayService);
    delivery = app.get(NotificationDeliveryService);
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    const passwordHash = await app.get(PasswordService).hash(password);
    await adminUsers.create({
      name: 'Phase 10 Owner',
      email: ownerEmail,
      passwordHash,
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    browser = request.agent(httpServer);
    csrf = (
      (await browser.get('/api/v1/admin/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email: ownerEmail, password })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('creates Phase 10 indexes and enforces notification attempt invariants', async () => {
    const notificationIndexes = (await notifications.collection.indexes()).map(
      (index) => index.name,
    );
    expect(notificationIndexes).toEqual(
      expect.arrayContaining([
        'uq_notifications_delivery_key',
        'ix_notifications_worker',
        'ix_notifications_admin_status_created',
        'ix_notifications_admin_channel_status_created',
      ]),
    );
    const outboxIndexes = (await outbox.collection.indexes()).map((index) => index.name);
    expect(outboxIndexes).toContain('ix_outbox_events_admin_status_created');

    await expect(
      notifications.collection.insertOne({
        outboxEventId: new Types.ObjectId(),
        sourceEventId: 'phase10-invalid-notification',
        channel: 'EMAIL',
        templateKey: 'TEST',
        recipient: 'test@richculture.test',
        deliveryKey: 'a'.repeat(64),
        subject: 'Test',
        textBody: 'Test',
        htmlBody: '<p>Test</p>',
        status: 'PENDING',
        attempts: -1,
        nextAttemptAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it('materializes each recipient once and delivers through the injected gateway', async () => {
    fakeEmail.send.mockClear();
    const deliveredAt = new Date();
    const shippedAt = new Date(deliveredAt.getTime() - 86_400_000);
    const order = await orders.create({
      orderNumber,
      idempotencyKey: 'phase10-order-idempotency-0001',
      idempotencyRequestHash: 'b'.repeat(64),
      sourceCartId: new Types.ObjectId(),
      customerId: new Types.ObjectId(),
      customer: { name: '<Phase 10 Customer>', email: customerEmail },
      shippingAddress: {
        fullName: 'Phase 10 Customer',
        phone: '+919876543210',
        line1: 'Phase 10 Test Address',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        countryCode: 'IN',
      },
      items: [
        {
          productId: new Types.ObjectId(),
          variantId: new Types.ObjectId(),
          productName: 'Phase 10 Product',
          productSlug: 'phase-10-product',
          sku: 'PHASE10-SKU',
          variantTitle: 'Default',
          unitPriceInPaise: 249_900,
          quantity: 1,
          lineTotalInPaise: 249_900,
        },
      ],
      totals: { subtotalInPaise: 249_900, grandTotalInPaise: 249_900 },
      paymentExpiresAt: new Date(Date.now() + 15 * 60_000),
      shipping: {
        provider: ShippingProvider.Manual,
        status: ShipmentStatus.Delivered,
        courierName: 'Phase 10 Courier',
        trackingNumber: 'PHASE10TRACKING',
        trackingUrl: 'https://tracking.richculture.test/PHASE10TRACKING',
        trackingEvents: [
          {
            status: ShipmentStatus.Delivered,
            message: 'Fixture shipment delivered',
            actorType: AuditActorType.System,
            occurredAt: deliveredAt,
          },
        ],
        lastEventAt: deliveredAt,
        shippedAt,
        deliveredAt,
      },
    });
    const [succeededRefund, failedRefund] = await refunds.create([
      {
        refundNumber: 'RF-PHASE10-SUCCEEDED',
        orderId: order._id,
        paymentAttemptId: new Types.ObjectId(),
        idempotencyKey: 'phase10-refund-success-idempotency',
        idempotencyRequestHash: 'd'.repeat(64),
        provider: PaymentProvider.Razorpay,
        providerReceipt: 'RF-PHASE10-SUCCEEDED',
        providerPaymentId: 'pay_PHASE10SUCCEEDED',
        amountInPaise: 50_000,
        status: RefundStatus.Succeeded,
        providerRefundId: 'rfnd_PHASE10SUCCEEDED',
        reason: 'Phase 10 notification success fixture',
        requestedBy: new Types.ObjectId(),
        processedAt: new Date(),
      },
      {
        refundNumber: 'RF-PHASE10-FAILED',
        orderId: order._id,
        paymentAttemptId: new Types.ObjectId(),
        idempotencyKey: 'phase10-refund-failed-idempotency',
        idempotencyRequestHash: 'e'.repeat(64),
        provider: PaymentProvider.Razorpay,
        providerReceipt: 'RF-PHASE10-FAILED',
        providerPaymentId: 'pay_PHASE10FAILED',
        amountInPaise: 25_000,
        status: RefundStatus.Failed,
        reason: 'Phase 10 notification failure fixture',
        requestedBy: new Types.ObjectId(),
        processedAt: new Date(),
        failureCode: 'PHASE10_TEST_FAILURE',
        failureDescription: 'Phase 10 simulated refund failure',
      },
    ]);
    const returnRequest = await returns.create({
      returnNumber: 'RT-PHASE10-0001',
      orderId: order._id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      type: ReturnRequestType.Exchange,
      status: ReturnRequestStatus.Approved,
      items: [
        {
          productId: order.items[0].productId,
          variantId: order.items[0].variantId,
          productName: order.items[0].productName,
          sku: order.items[0].sku,
          variantTitle: order.items[0].variantTitle,
          quantity: 1,
          reason: ReturnReason.Damaged,
          requestedExchangeVariant: {
            variantId: new Types.ObjectId(),
            sku: 'PHASE10-REPLACEMENT',
            title: 'Replacement',
            attributes: [],
          },
          estimatedValueInPaise: order.items[0].lineTotalInPaise,
          restockedQuantity: 0,
        },
      ],
      customerMessage: '<handle carefully>',
      idempotencyKey: 'phase10-return-idempotency',
      idempotencyRequestHash: 'f'.repeat(64),
      requestedAt: new Date(),
      statusHistory: [
        {
          status: ReturnRequestStatus.Requested,
          actorType: AuditActorType.Customer,
          actorId: order.customerId,
          occurredAt: new Date(),
        },
      ],
    });
    await outbox.create([
      {
        eventId: paymentEventId,
        aggregateType: 'ORDER',
        aggregateId: order._id,
        eventType: 'ORDER_PAYMENT_CAPTURED',
        payload: { orderId: order.id, orderNumber },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: lateEventId,
        aggregateType: 'ORDER',
        aggregateId: order._id,
        eventType: 'ORDER_LATE_PAYMENT_CAPTURED',
        payload: { orderId: order.id, orderNumber, refundRequired: true },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-order-shipped',
        aggregateType: 'ORDER',
        aggregateId: order._id,
        eventType: 'ORDER_FULFILLMENT_SHIPPED',
        payload: { orderId: order.id, orderNumber },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-order-delivered',
        aggregateType: 'ORDER',
        aggregateId: order._id,
        eventType: 'ORDER_FULFILLMENT_DELIVERED',
        payload: { orderId: order.id, orderNumber },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-refund-succeeded',
        aggregateType: 'REFUND',
        aggregateId: succeededRefund._id,
        eventType: 'ORDER_REFUND_SUCCEEDED',
        payload: { orderId: order.id, orderNumber, refundId: succeededRefund.id },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-refund-failed',
        aggregateType: 'REFUND',
        aggregateId: failedRefund._id,
        eventType: 'ORDER_REFUND_FAILED',
        payload: { orderId: order.id, orderNumber, refundId: failedRefund.id },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-return-requested',
        aggregateType: 'RETURN_REQUEST',
        aggregateId: returnRequest._id,
        eventType: 'RETURN_REQUEST_REQUESTED',
        payload: {
          returnNumber: returnRequest.returnNumber,
          orderNumber,
          type: ReturnRequestType.Exchange,
          status: ReturnRequestStatus.Requested,
          itemCount: 1,
        },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-return-approved',
        aggregateType: 'RETURN_REQUEST',
        aggregateId: returnRequest._id,
        eventType: 'RETURN_REQUEST_APPROVED',
        payload: {
          returnNumber: returnRequest.returnNumber,
          orderNumber,
          type: ReturnRequestType.Exchange,
          status: ReturnRequestStatus.Approved,
          itemCount: 1,
          customerMessage: '<handle carefully>',
        },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
      {
        eventId: 'phase10-return-expired',
        aggregateType: 'RETURN_REQUEST',
        aggregateId: returnRequest._id,
        eventType: 'RETURN_REQUEST_EXPIRED',
        payload: {
          returnNumber: returnRequest.returnNumber,
          orderNumber,
          type: ReturnRequestType.Exchange,
          status: ReturnRequestStatus.Expired,
          itemCount: 1,
        },
        status: OutboxStatus.Pending,
        availableAt: new Date(),
      },
    ]);

    const firstRelay = await relay.processBatch();
    expect(firstRelay.materialized).toBeGreaterThanOrEqual(10);
    expect(await notifications.countDocuments({ sourceEventId: /^phase10-/ })).toBe(10);
    const customerNotification = await notifications.findOne({ sourceEventId: paymentEventId });
    expect(customerNotification?.htmlBody).toContain('&lt;Phase 10 Customer&gt;');
    const returnNotification = await notifications.findOne({
      sourceEventId: 'phase10-return-approved',
    });
    expect(returnNotification?.htmlBody).toContain('&lt;handle carefully&gt;');
    expect(await notifications.countDocuments({ sourceEventId: 'phase10-return-requested' })).toBe(
      2,
    );
    await expect(
      notifications.findOne({ sourceEventId: 'phase10-return-expired' }),
    ).resolves.toMatchObject({ subject: 'RT-PHASE10-0001 has expired' });

    await outbox.updateOne(
      { eventId: paymentEventId },
      {
        $set: { status: OutboxStatus.Pending, availableAt: new Date() },
        $unset: { publishedAt: 1 },
      },
    );
    await relay.processBatch();
    expect(await notifications.countDocuments({ sourceEventId: paymentEventId })).toBe(1);

    const result = await delivery.processBatch();
    expect(result.sent).toBeGreaterThanOrEqual(10);
    expect(
      await notifications.countDocuments({
        sourceEventId: /^phase10-/,
        status: NotificationStatus.Sent,
      }),
    ).toBe(10);
    const phaseDeliveryKeys = (
      await notifications
        .find({ sourceEventId: /^phase10-/ })
        .select('deliveryKey')
        .lean()
    ).map((notification) => notification.deliveryKey);
    const sentDeliveryKeys = fakeEmail.send.mock.calls.map(([input]) => input.deliveryKey);
    for (const deliveryKey of phaseDeliveryKeys) {
      expect(sentDeliveryKeys.filter((candidate) => candidate === deliveryKey)).toHaveLength(1);
    }
  }, 30_000);

  it('backs delivery failures off and moves the eighth failure to dead status', async () => {
    const retryKey = 'c'.repeat(64);
    await notifications.create({
      outboxEventId: new Types.ObjectId(),
      sourceEventId: 'phase10-delivery-failure',
      channel: NotificationChannel.Email,
      templateKey: 'PHASE10_FAILURE_TEST',
      recipient: customerEmail,
      deliveryKey: retryKey,
      subject: 'Phase 10 failure test',
      textBody: 'Failure test',
      htmlBody: '<p>Failure test</p>',
      status: NotificationStatus.Pending,
      nextAttemptAt: new Date(),
    });
    const beforeFailure = Date.now();
    fakeEmail.send.mockRejectedValueOnce(new Error('simulated provider failure'));
    const first = await delivery.processBatch();
    expect(first.failed).toBe(1);
    const failed = await notifications.findOne({ deliveryKey: retryKey });
    expect(failed).toMatchObject({ status: NotificationStatus.Failed, attempts: 1 });
    expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(beforeFailure);

    await notifications.updateOne(
      { deliveryKey: retryKey },
      {
        $set: {
          status: NotificationStatus.Pending,
          attempts: 7,
          nextAttemptAt: new Date(),
        },
      },
    );
    fakeEmail.send.mockRejectedValueOnce(new Error('simulated terminal failure'));
    const terminal = await delivery.processBatch();
    expect(terminal.failed).toBe(1);
    await expect(notifications.findOne({ deliveryKey: retryKey })).resolves.toMatchObject({
      status: NotificationStatus.Dead,
      attempts: 8,
    });
  });

  it('materializes opted-in SMS updates and securely retires delivered OTP content', async () => {
    fakeMessages.send.mockClear();
    const order = await orders.findOne({ orderNumber });
    if (!order?.customerId) throw new Error('Phase 10 customer order fixture is missing');
    const customerPasswordHash = await app.get(PasswordService).hash(password);
    await customers.create({
      _id: order.customerId,
      name: 'Phase 10 Customer',
      email: customerEmail,
      passwordHash: customerPasswordHash,
      mobile: '+919999000001',
      mobileVerifiedAt: new Date(),
      status: AccountStatus.Active,
      communicationPreferences: {
        marketingEmail: false,
        backInStockEmail: true,
        orderUpdatesSms: true,
        orderUpdatesWhatsapp: false,
      },
    });
    await outbox.create({
      eventId: 'phase10-order-out-for-delivery',
      aggregateType: 'ORDER',
      aggregateId: order._id,
      eventType: 'ORDER_SHIPMENT_OUT_FOR_DELIVERY',
      payload: { orderId: order.id, orderNumber },
      status: OutboxStatus.Pending,
      availableAt: new Date(),
    });

    await expect(relay.processBatch()).resolves.toMatchObject({ materialized: 1 });
    await expect(
      notifications.findOne({ sourceEventId: 'phase10-order-out-for-delivery' }),
    ).resolves.toMatchObject({
      channel: NotificationChannel.Sms,
      recipient: '+919999000001',
      status: NotificationStatus.Pending,
    });
    await expect(delivery.processBatch()).resolves.toMatchObject({ sent: 1 });
    expect(fakeMessages.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: NotificationChannel.Sms,
        templateKey: 'ORDER_SHIPMENT_OUT_FOR_DELIVERY',
      }),
    );

    const customerBrowser = request.agent(httpServer);
    const customerCsrf = (
      (await customerBrowser.get('/api/v1/customer/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await customerBrowser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', customerCsrf)
      .send({ email: customerEmail, password })
      .expect(200);
    const otpResponse = await customerBrowser
      .post('/api/v1/customer/profile/mobile-change')
      .set('x-csrf-token', customerCsrf)
      .send({ mobile: '+919999000002', currentPassword: password })
      .expect(202);
    const otpBody = otpResponse.body as {
      challengeId: string;
      developmentOtp: string;
    };
    const otpEvent = await outbox.findOne({
      aggregateId: new Types.ObjectId(otpBody.challengeId),
      eventType: 'CUSTOMER_MOBILE_OTP_REQUESTED',
    });
    expect(otpEvent).not.toBeNull();
    expect(JSON.stringify(otpEvent?.payload)).not.toContain(otpBody.developmentOtp);

    await expect(relay.processBatch()).resolves.toMatchObject({ materialized: 1 });
    const pendingOtp = await notifications.findOne({ sourceEventId: otpEvent?.eventId });
    expect(pendingOtp).toMatchObject({ channel: NotificationChannel.Sms });
    expect(pendingOtp?.textBody).toContain(otpBody.developmentOtp);
    await expect(delivery.processBatch()).resolves.toMatchObject({ sent: 1 });
    const deliveredOtp = await notifications.findOne({ sourceEventId: otpEvent?.eventId });
    expect(deliveredOtp?.textBody).toBe('[Sensitive one-time credential removed after delivery]');

    await browser
      .get('/api/v1/admin/notifications')
      .query({ channel: NotificationChannel.Sms, search: otpEvent?.eventId })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          total: 1,
          items: [expect.objectContaining({ channel: NotificationChannel.Sms })],
        });
      });
  });

  it('exposes delivery visibility and OWNER-controlled retry endpoints', async () => {
    await request(httpServer).get('/api/v1/admin/notifications').expect(401);
    await browser
      .get('/api/v1/admin/notifications')
      .query({ search: paymentEventId })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ total: 1 });
      });
    await browser
      .get('/api/v1/admin/notifications/operations-summary')
      .expect(200)
      .expect(({ body }: request.Response) => {
        const summary = body as {
          outbox: Record<string, number>;
          notifications: Record<string, number>;
        };
        expect(summary.outbox.PUBLISHED).toBeGreaterThanOrEqual(1);
        expect(summary.notifications.SENT).toBeGreaterThanOrEqual(1);
      });
    await browser
      .get('/api/v1/admin/notifications/outbox')
      .query({ search: lateEventId })
      .expect(200)
      .expect(({ body }: request.Response) => {
        const response = body as {
          total: number;
          items: Array<{ eventId: string; payload?: unknown }>;
        };
        expect(response.total).toBe(1);
        expect(response.items[0]).toMatchObject({ eventId: lateEventId });
        expect(response.items[0].payload).toBeUndefined();
      });

    const notification = await notifications.findOneAndUpdate(
      { sourceEventId: paymentEventId },
      { $set: { status: NotificationStatus.Dead, attempts: 8, lastError: 'test failure' } },
      { returnDocument: 'after' },
    );
    if (!notification) throw new Error('Phase 10 notification fixture is missing');
    await browser
      .post(`/api/v1/admin/notifications/${notification.id}/retry`)
      .set('x-csrf-token', csrf)
      .expect(201)
      .expect(({ body }: request.Response) => {
        const response = body as {
          notification: { status: NotificationStatus; attempts: number };
        };
        expect(response.notification).toMatchObject({
          status: NotificationStatus.Pending,
          attempts: 0,
        });
      });

    const event = await outbox.findOneAndUpdate(
      { eventId: lateEventId },
      { $set: { status: OutboxStatus.Dead, processingAttempts: 8, lastError: 'test failure' } },
      { returnDocument: 'after' },
    );
    if (!event) throw new Error('Phase 10 outbox fixture is missing');
    await browser
      .post(`/api/v1/admin/notifications/outbox/${event.id}/retry`)
      .set('x-csrf-token', csrf)
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ eventId: lateEventId, status: OutboxStatus.Pending });
      });
  });
});
