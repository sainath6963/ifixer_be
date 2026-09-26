import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { Model, Types } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { AdminSession, AdminUser } from '../src/database/schemas/identity.schema';
import { OutboxEvent, WebhookEvent } from '../src/database/schemas/integration.schema';
import { InventoryLevel, InventoryMovement } from '../src/database/schemas/inventory.schema';
import { Order, OrderDocument } from '../src/database/schemas/order.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { PaymentAttempt, Refund, RefundDocument } from '../src/database/schemas/payment.schema';
import {
  AccountStatus,
  AdminRole,
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  PaymentAttemptStatus,
  PaymentProvider,
  RefundStatus,
  ShipmentStatus,
  ShippingProvider,
  WebhookStatus,
} from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import { RAZORPAY_GATEWAY } from '../src/modules/payments/payment.constants';
import type {
  CreateRazorpayRefundInput,
  RazorpayGateway,
  RazorpayProviderOrder,
  RazorpayProviderPayment,
  RazorpayProviderRefund,
  RazorpayRefundStatus,
} from '../src/modules/payments/razorpay.types';
import { RazorpayGatewayError } from '../src/modules/payments/razorpay.types';

interface AdminOrderBody {
  order: {
    id: string;
    orderNumber: string;
    lifecycleStatus: OrderLifecycleStatus;
    financialStatus: FinancialStatus;
    fulfillmentStatus: FulfillmentStatus;
    shipping?: {
      provider: ShippingProvider;
      status: ShipmentStatus;
      trackingNumber: string;
      trackingEvents: Array<{ status: ShipmentStatus; message: string }>;
    };
    version: number;
  };
}

interface RefundBody {
  refund: {
    id: string;
    refundNumber: string;
    providerRefundId?: string;
    status: RefundStatus;
  };
  financialStatus: FinancialStatus;
  refundedInPaise: number;
  refundPendingInPaise: number;
}

class FakePhase9RazorpayGateway implements RazorpayGateway {
  readonly keyId = 'rzp_test_phase9example';
  readonly checkoutName = 'Rich Culture Test';
  readonly refundInputs: CreateRazorpayRefundInput[] = [];
  nextRefundStatus: RazorpayRefundStatus = 'processed';
  private readonly webhookSecret = 'test-razorpay-webhook-secret-32-characters';
  private readonly refunds = new Map<string, RazorpayProviderRefund>();
  private readonly idempotencyIndex = new Map<string, string>();

  createOrder(): Promise<RazorpayProviderOrder> {
    return Promise.reject(new Error('Payment creation is outside the Phase 9 fixture'));
  }

  findOrderByReceipt(): Promise<RazorpayProviderOrder | undefined> {
    return Promise.resolve(undefined);
  }

  fetchOrder(): Promise<RazorpayProviderOrder> {
    return Promise.reject(new Error('Payment lookup is outside the Phase 9 fixture'));
  }

  fetchPayment(): Promise<RazorpayProviderPayment> {
    return Promise.reject(new Error('Payment lookup is outside the Phase 9 fixture'));
  }

  fetchPaymentsForOrder(): Promise<RazorpayProviderPayment[]> {
    return Promise.resolve([]);
  }

  createRefund(input: CreateRazorpayRefundInput): Promise<RazorpayProviderRefund> {
    const existingId = this.idempotencyIndex.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.refunds.get(existingId);
      if (!existing) throw new Error('Fake refund index is inconsistent');
      return Promise.resolve(existing);
    }
    this.refundInputs.push(input);
    const id = `rfnd_PHASE9TEST${String(this.refundInputs.length).padStart(6, '0')}`;
    const refund: RazorpayProviderRefund = {
      id,
      paymentId: input.providerPaymentId,
      amountInPaise: input.amountInPaise,
      currency: 'INR',
      receipt: input.receipt,
      status: this.nextRefundStatus,
      acquirerReference:
        this.nextRefundStatus === 'processed' ? `ARNPHASE9${this.refundInputs.length}` : undefined,
      createdAt: new Date(),
    };
    this.refunds.set(id, refund);
    this.idempotencyIndex.set(input.idempotencyKey, id);
    return Promise.resolve(refund);
  }

  findRefundByReceipt(
    providerPaymentId: string,
    receipt: string,
  ): Promise<RazorpayProviderRefund | undefined> {
    return Promise.resolve(
      [...this.refunds.values()].find(
        (refund) => refund.paymentId === providerPaymentId && refund.receipt === receipt,
      ),
    );
  }

  fetchRefund(
    providerPaymentId: string,
    providerRefundId: string,
  ): Promise<RazorpayProviderRefund> {
    const refund = this.refunds.get(providerRefundId);
    if (!refund || refund.paymentId !== providerPaymentId) {
      throw new RazorpayGatewayError('Refund missing', 'NOT_FOUND', 404);
    }
    return Promise.resolve(refund);
  }

  verifyPaymentSignature(): boolean {
    return false;
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return signature === this.signWebhook(rawBody.toString('utf8'));
  }

  signWebhook(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
}

describe('Admin order, fulfillment, and refund operations (e2e)', () => {
  const ownerEmail = 'phase9-owner@richculture.test';
  const staffEmail = 'phase9-staff@richculture.test';
  const password = 'Phase9-admin-password';
  const unitPriceInPaise = 249_900;
  const gateway = new FakePhase9RazorpayGateway();
  const startedAt = new Date();

  let app: INestApplication;
  let httpServer: Server;
  let ownerBrowser: ReturnType<typeof request.agent>;
  let staffBrowser: ReturnType<typeof request.agent>;
  let ownerCsrf: string;
  let staffCsrf: string;
  let adminUsers: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let orders: Model<Order>;
  let attempts: Model<PaymentAttempt>;
  let refunds: Model<Refund>;
  let inventory: Model<InventoryLevel>;
  let movements: Model<InventoryMovement>;
  let webhookEvents: Model<WebhookEvent>;
  let outbox: Model<OutboxEvent>;
  let auditLogs: Model<AuditLog>;

  const cleanFixtures = async (): Promise<void> => {
    const orderDocuments = await orders.find({ orderNumber: /^RC-PHASE9-/ }).select('_id items');
    const orderIds = orderDocuments.map((order) => order._id);
    const orderIdStrings = orderIds.map((orderId) => orderId.toHexString());
    const productIds = orderDocuments.flatMap((order) => order.items.map((item) => item.productId));
    const refundDocuments = await refunds.find({ orderId: { $in: orderIds } }).select('_id');
    const refundIds = refundDocuments.map((refund) => refund._id);
    await webhookEvents.deleteMany({ eventId: /^phase9-/ });
    await outbox.deleteMany({ aggregateId: { $in: [...orderIds, ...refundIds] } });
    await refunds.deleteMany({ orderId: { $in: orderIds } });
    await attempts.deleteMany({ orderId: { $in: orderIds } });
    await movements.deleteMany({ referenceId: { $in: orderIdStrings } });
    await inventory.deleteMany({ productId: { $in: productIds } });
    await orders.deleteMany({ _id: { $in: orderIds } });
    const phaseAdmins = await adminUsers.find({ email: /^phase9-/ }).select('_id');
    const adminIds = phaseAdmins.map((admin) => admin._id);
    await adminSessions.deleteMany({ adminUserId: { $in: adminIds } });
    await adminUsers.deleteMany({ _id: { $in: adminIds } });
    await auditLogs.deleteMany({
      occurredAt: { $gte: startedAt },
      $or: [
        { actorId: { $in: adminIds } },
        { action: /^(ORDER_REFUND_|ORDER_FULFILLMENT_|ORDER_ADMIN_NOTE_)/ },
      ],
    });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useValue(gateway)
      .compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    adminUsers = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    orders = app.get(getModelToken(Order.name));
    attempts = app.get(getModelToken(PaymentAttempt.name));
    refunds = app.get(getModelToken(Refund.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    movements = app.get(getModelToken(InventoryMovement.name));
    webhookEvents = app.get(getModelToken(WebhookEvent.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    const passwordHash = await app.get(PasswordService).hash(password);
    await adminUsers.create([
      {
        name: 'Phase 9 Owner',
        email: ownerEmail,
        passwordHash,
        roles: [AdminRole.Owner],
        status: AccountStatus.Active,
      },
      {
        name: 'Phase 9 Staff',
        email: staffEmail,
        passwordHash,
        roles: [AdminRole.Staff],
        status: AccountStatus.Active,
      },
    ]);

    ownerBrowser = request.agent(httpServer);
    ownerCsrf = (
      (await ownerBrowser.get('/api/v1/admin/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await ownerBrowser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', ownerCsrf)
      .send({ email: ownerEmail, password })
      .expect(200);

    staffBrowser = request.agent(httpServer);
    staffCsrf = (
      (await staffBrowser.get('/api/v1/admin/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await staffBrowser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', staffCsrf)
      .send({ email: staffEmail, password })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('creates Phase 9 indexes and protects operational endpoints with admin RBAC', async () => {
    const refundIndexes = (await refunds.collection.indexes()).map((index) => index.name);
    const movementIndexes = (await movements.collection.indexes()).map((index) => index.name);
    const orderIndexes = (await orders.collection.indexes()).map((index) => index.name);
    expect(refundIndexes).toEqual(
      expect.arrayContaining([
        'uq_refunds_idempotency',
        'uq_refunds_provider_receipt',
        'uq_refunds_provider_refund_when_present',
        'ix_refunds_reconcile_v2',
      ]),
    );
    expect(movementIndexes).toContain('uq_inventory_movements_fulfillment_restock');
    expect(orderIndexes).toContain('ix_orders_email_created');
    expect(orderIndexes).toContain('ix_orders_shipment_status_last_event');
    expect(orderIndexes).toContain('uq_orders_courier_tracking_when_present');

    const fixture = await createPaidOrder('ACCESS0001', 1);
    await expect(
      attempts.collection.updateOne(
        { orderId: fixture.order._id },
        { $set: { refundedInPaise: unitPriceInPaise, refundPendingInPaise: 1 } },
      ),
    ).rejects.toMatchObject({ code: 121 });
    await request(httpServer).get('/api/v1/admin/orders').expect(401);
    await staffBrowser
      .get('/api/v1/admin/orders')
      .query({ search: fixture.order.orderNumber })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ total: 1 });
      });
    await staffBrowser
      .get('/api/v1/admin/orders/operations-summary')
      .expect(200)
      .expect(({ body }: request.Response) => {
        const summary = body as {
          orders: { paidUnfulfilled: number };
          refunds: { pending: number };
          alerts: { lateCapturedNeedsRefund: number };
        };
        expect(summary.orders.paidUnfulfilled).toBeGreaterThanOrEqual(1);
        expect(summary.refunds.pending).toBeGreaterThanOrEqual(0);
        expect(summary.alerts.lateCapturedNeedsRefund).toBeGreaterThanOrEqual(0);
      });
    await staffBrowser
      .post(`/api/v1/admin/orders/${fixture.order.orderNumber}/refunds`)
      .set('x-csrf-token', staffCsrf)
      .set('idempotency-key', 'phase9-staff-refund-0001')
      .send({
        expectedOrderVersion: 0,
        amountInPaise: 100,
        reason: 'Staff must not be allowed to refund',
        confirmRefund: true,
      })
      .expect(403);
  }, 60_000);

  it('moves fulfillment through guarded states and restocks a physical return exactly once', async () => {
    const fixture = await createPaidOrder('FULFILL0001', 3);
    const baseUrl = `/api/v1/admin/orders/${fixture.order.orderNumber}`;

    let response = await staffBrowser
      .patch(`${baseUrl}/admin-note`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 0, adminNote: 'Gift wrap verified by operations.' })
      .expect(200);
    expect((response.body as AdminOrderBody).order.version).toBe(1);

    await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 0, status: FulfillmentStatus.Processing })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'ORDER_VERSION_CONFLICT' });
      });

    response = await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 1, status: FulfillmentStatus.Processing })
      .expect(200);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      fulfillmentStatus: FulfillmentStatus.Processing,
      version: 2,
    });

    await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 2, status: FulfillmentStatus.Shipped })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'SHIPPING_DETAILS_REQUIRED' });
      });

    response = await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 2,
        status: FulfillmentStatus.Shipped,
        courierName: 'Blue Dart',
        trackingNumber: 'BD-PHASE9-0001',
        trackingUrl: 'https://example.test/track/BD-PHASE9-0001',
      })
      .expect(200);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      fulfillmentStatus: FulfillmentStatus.Shipped,
      shipping: { trackingNumber: 'BD-PHASE9-0001' },
      version: 3,
    });

    response = await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 3, status: FulfillmentStatus.Delivered })
      .expect(200);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.Completed,
      fulfillmentStatus: FulfillmentStatus.Delivered,
      version: 4,
    });

    response = await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 4,
        status: FulfillmentStatus.Returned,
        reason: 'Physical parcel returned to warehouse',
      })
      .expect(200);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.Completed,
      fulfillmentStatus: FulfillmentStatus.Returned,
      version: 5,
    });
    expect(await inventory.findOne({ variantId: fixture.variantId }).lean()).toMatchObject({
      onHand: 10,
      reserved: 0,
      sold: 0,
    });
    expect(
      await movements.countDocuments({
        referenceType: 'ORDER_FULFILLMENT_RESTOCK',
        referenceId: fixture.order.id,
      }),
    ).toBe(1);
    await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 5, status: FulfillmentStatus.Returned })
      .expect(409);
  }, 60_000);

  it('records a guarded provider-neutral shipment timeline and synchronizes fulfillment', async () => {
    const fixture = await createPaidOrder('SHIPMENT0001', 1);
    const baseUrl = `/api/v1/admin/orders/${fixture.order.orderNumber}`;

    await request(httpServer).post(`${baseUrl}/shipment`).expect(403);
    let response = await staffBrowser
      .patch(`${baseUrl}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 0, status: FulfillmentStatus.Processing })
      .expect(200);
    expect((response.body as AdminOrderBody).order.version).toBe(1);

    response = await staffBrowser
      .post(`${baseUrl}/shipment`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 1,
        courierName: 'Blue Dart',
        trackingNumber: 'BD-PHASE21-0001',
        trackingUrl: 'https://example.test/track/BD-PHASE21-0001',
        serviceLevel: 'Surface',
        estimatedDeliveryAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      })
      .expect(201);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      fulfillmentStatus: FulfillmentStatus.Processing,
      version: 2,
      shipping: {
        provider: ShippingProvider.Manual,
        status: ShipmentStatus.ReadyToShip,
        trackingNumber: 'BD-PHASE21-0001',
        trackingEvents: [{ status: ShipmentStatus.ReadyToShip }],
      },
    });

    await staffBrowser
      .post(`${baseUrl}/shipment`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 2,
        courierName: 'Blue Dart',
        trackingNumber: 'BD-PHASE21-0001',
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'SHIPMENT_ALREADY_EXISTS' });
      });
    await staffBrowser
      .patch(`${baseUrl}/shipment/status`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 2,
        status: ShipmentStatus.Delivered,
        message: 'Invalid direct delivery',
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'SHIPMENT_TRANSITION_INVALID' });
      });

    response = await staffBrowser
      .patch(`${baseUrl}/shipment/status`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 2,
        status: ShipmentStatus.InTransit,
        message: 'Parcel collected by courier',
        location: 'Pune hub',
      })
      .expect(200);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      fulfillmentStatus: FulfillmentStatus.Shipped,
      version: 3,
      shipping: {
        status: ShipmentStatus.InTransit,
        trackingEvents: [
          { status: ShipmentStatus.ReadyToShip },
          { status: ShipmentStatus.InTransit, message: 'Parcel collected by courier' },
        ],
      },
    });

    response = await staffBrowser
      .patch(`${baseUrl}/shipment/status`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 3,
        status: ShipmentStatus.DeliveryException,
        message: 'Delivery delayed by severe weather',
        location: 'Mumbai hub',
      })
      .expect(200);
    expect((response.body as AdminOrderBody).order.shipping?.status).toBe(
      ShipmentStatus.DeliveryException,
    );
    await staffBrowser
      .get('/api/v1/admin/orders/operations-summary')
      .expect(200)
      .expect(({ body }: request.Response) => {
        const summary = body as { alerts: { deliveryExceptions: number } };
        expect(summary.alerts.deliveryExceptions).toBeGreaterThanOrEqual(1);
      });

    response = await staffBrowser
      .patch(`${baseUrl}/shipment/status`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 4,
        status: ShipmentStatus.OutForDelivery,
        message: 'Parcel is out for delivery',
        location: 'Pune',
      })
      .expect(200);
    expect((response.body as AdminOrderBody).order.version).toBe(5);

    response = await staffBrowser
      .patch(`${baseUrl}/shipment/status`)
      .set('x-csrf-token', staffCsrf)
      .send({
        expectedVersion: 5,
        status: ShipmentStatus.Delivered,
        message: 'Parcel delivered to customer',
        location: 'Pune',
      })
      .expect(200);
    expect((response.body as AdminOrderBody).order).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.Completed,
      fulfillmentStatus: FulfillmentStatus.Delivered,
      version: 6,
      shipping: { status: ShipmentStatus.Delivered },
    });
    expect((response.body as AdminOrderBody).order.shipping?.trackingEvents).toHaveLength(5);
    expect(
      await outbox.countDocuments({
        aggregateId: fixture.order._id,
        eventType: {
          $in: [
            'ORDER_SHIPMENT_CREATED',
            'ORDER_FULFILLMENT_SHIPPED',
            'ORDER_FULFILLMENT_DELIVERED',
          ],
        },
      }),
    ).toBe(3);
  }, 60_000);

  it('issues idempotent partial/full refunds and blocks over-refund and concurrent overspend', async () => {
    gateway.nextRefundStatus = 'processed';
    const fixture = await createPaidOrder('REFUND0001', 1);
    const url = `/api/v1/admin/orders/${fixture.order.orderNumber}/refunds`;
    const firstInput = {
      expectedOrderVersion: 0,
      amountInPaise: 100_000,
      reason: 'Customer accepted a partial goodwill refund',
      confirmRefund: true,
    };
    const callsBefore = gateway.refundInputs.length;
    let response = await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-owner-refund-0001')
      .send(firstInput)
      .expect(201);
    const first = response.body as RefundBody;
    expect(first).toMatchObject({
      refund: { status: RefundStatus.Succeeded },
      financialStatus: FinancialStatus.PartiallyRefunded,
      refundedInPaise: 100_000,
      refundPendingInPaise: 0,
    });

    response = await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-owner-refund-0001')
      .send(firstInput)
      .expect(201);
    expect((response.body as RefundBody).refund.id).toBe(first.refund.id);
    expect(gateway.refundInputs).toHaveLength(callsBefore + 1);

    await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-owner-refund-0001')
      .send({ ...firstInput, amountInPaise: 90_000 })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });

    const liveOrder = await orders.findById(fixture.order._id).orFail();
    const liveOrderVersion = liveOrder.get('version') as number;
    await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-owner-refund-too-large-0001')
      .send({
        expectedOrderVersion: liveOrderVersion,
        amountInPaise: 149_901,
        reason: 'This amount exceeds the remaining refundable balance',
        confirmRefund: true,
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_AVAILABLE' });
      });

    await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-owner-refund-remaining-0001')
      .send({
        expectedOrderVersion: liveOrderVersion,
        amountInPaise: 149_900,
        reason: 'Refund the complete remaining captured balance',
        confirmRefund: true,
      })
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          financialStatus: FinancialStatus.Refunded,
          refundedInPaise: unitPriceInPaise,
          refundPendingInPaise: 0,
        });
      });

    const refundedOrder = await orders.findById(fixture.order._id).orFail();
    const refundedOrderVersion = refundedOrder.get('version') as number;
    await ownerBrowser
      .patch(`/api/v1/admin/orders/${fixture.order.orderNumber}/fulfillment`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: refundedOrderVersion,
        status: FulfillmentStatus.Cancelled,
        reason: 'Fully refunded before warehouse dispatch',
      })
      .expect(200);
    expect(await inventory.findOne({ variantId: fixture.variantId }).lean()).toMatchObject({
      onHand: 10,
      sold: 0,
    });

    const concurrent = await createPaidOrder('CONCUR0001', 1);
    const concurrentUrl = `/api/v1/admin/orders/${concurrent.order.orderNumber}/refunds`;
    const sendConcurrentRefund = (key: string): request.Test =>
      ownerBrowser
        .post(concurrentUrl)
        .set('x-csrf-token', ownerCsrf)
        .set('idempotency-key', key)
        .send({
          expectedOrderVersion: 0,
          amountInPaise: 150_000,
          reason: 'Concurrent refund capacity verification',
          confirmRefund: true,
        });
    const results = await Promise.all([
      sendConcurrentRefund('phase9-concurrent-refund-0001'),
      sendConcurrentRefund('phase9-concurrent-refund-0002'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const concurrentAttempt = await attempts.findOne({ orderId: concurrent.order._id }).orFail();
    expect(
      (concurrentAttempt.refundedInPaise ?? 0) + (concurrentAttempt.refundPendingInPaise ?? 0),
    ).toBe(150_000);
  }, 60_000);

  it('finalizes a pending refund from a signed webhook and ignores a stale downgrade', async () => {
    gateway.nextRefundStatus = 'pending';
    const fixture = await createPaidOrder('WEBHOOK0001', 1);
    const response = await ownerBrowser
      .post(`/api/v1/admin/orders/${fixture.order.orderNumber}/refunds`)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-webhook-refund-0001')
      .send({
        expectedOrderVersion: 0,
        amountInPaise: unitPriceInPaise,
        reason: 'Full refund waits for definitive provider webhook',
        confirmRefund: true,
      })
      .expect(201);
    const requested = response.body as RefundBody;
    expect(requested).toMatchObject({
      refund: { status: RefundStatus.Processing },
      financialStatus: FinancialStatus.Paid,
      refundedInPaise: 0,
      refundPendingInPaise: unitPriceInPaise,
    });
    await staffBrowser
      .patch(`/api/v1/admin/orders/${fixture.order.orderNumber}/fulfillment`)
      .set('x-csrf-token', staffCsrf)
      .send({ expectedVersion: 0, status: FulfillmentStatus.Processing })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'ORDER_REFUND_PENDING' });
      });

    const refundDocument = await refunds.findById(requested.refund.id).orFail();
    const processed = providerRefund(refundDocument, 'processed');
    const processedPayload = refundWebhookPayload('refund.processed', processed);
    await sendWebhook('phase9-refund-processed-0001', processedPayload).expect(204);
    await sendWebhook('phase9-refund-processed-0001', processedPayload).expect(204);

    expect(await orders.findById(fixture.order._id).lean()).toMatchObject({
      financialStatus: FinancialStatus.Refunded,
    });
    expect(await attempts.findOne({ orderId: fixture.order._id }).lean()).toMatchObject({
      refundedInPaise: unitPriceInPaise,
      refundPendingInPaise: 0,
    });
    expect(await refunds.findById(requested.refund.id).lean()).toMatchObject({
      status: RefundStatus.Succeeded,
    });
    expect(await webhookEvents.countDocuments({ eventId: 'phase9-refund-processed-0001' })).toBe(1);

    const failedPayload = refundWebhookPayload(
      'refund.failed',
      providerRefund(refundDocument, 'failed'),
    );
    await sendWebhook('phase9-refund-stale-failed-0001', failedPayload).expect(204);
    expect((await refunds.findById(requested.refund.id).orFail()).status).toBe(
      RefundStatus.Succeeded,
    );
    expect(
      (await webhookEvents.findOne({ eventId: 'phase9-refund-stale-failed-0001' }).orFail()).status,
    ).toBe(WebhookStatus.Processed);
  }, 60_000);

  it('releases reserved refund capacity after a definitive provider failure', async () => {
    gateway.nextRefundStatus = 'failed';
    const fixture = await createPaidOrder('FAILURE0001', 1);
    const url = `/api/v1/admin/orders/${fixture.order.orderNumber}/refunds`;
    await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-failed-refund-0001')
      .send({
        expectedOrderVersion: 0,
        amountInPaise: unitPriceInPaise,
        reason: 'Provider failure should release reserved refund capacity',
        confirmRefund: true,
      })
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          refund: { status: RefundStatus.Failed },
          financialStatus: FinancialStatus.Paid,
          refundedInPaise: 0,
          refundPendingInPaise: 0,
        });
      });

    gateway.nextRefundStatus = 'processed';
    await ownerBrowser
      .post(url)
      .set('x-csrf-token', ownerCsrf)
      .set('idempotency-key', 'phase9-failed-refund-retry-0001')
      .send({
        expectedOrderVersion: 0,
        amountInPaise: unitPriceInPaise,
        reason: 'Retry as a distinct approved refund after final failure',
        confirmRefund: true,
      })
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          refund: { status: RefundStatus.Succeeded },
          financialStatus: FinancialStatus.Refunded,
          refundedInPaise: unitPriceInPaise,
          refundPendingInPaise: 0,
        });
      });
  }, 60_000);

  async function createPaidOrder(
    suffix: string,
    quantity: number,
  ): Promise<{
    order: OrderDocument;
    productId: Types.ObjectId;
    variantId: Types.ObjectId;
  }> {
    const productId = new Types.ObjectId();
    const variantId = new Types.ObjectId();
    const orderNumber = `RC-PHASE9-${suffix}`;
    const [order] = await orders.create([
      {
        orderNumber,
        idempotencyKey: `phase9-order-${suffix}-0001`,
        idempotencyRequestHash: '9'.repeat(64),
        sourceCartId: new Types.ObjectId(),
        customerId: new Types.ObjectId(),
        customer: {
          name: `Phase 9 ${suffix}`,
          email: `phase9-${suffix.toLowerCase()}@richculture.test`,
          mobile: '+919876543210',
        },
        shippingAddress: {
          fullName: `Phase 9 ${suffix}`,
          phone: '+919876543210',
          line1: '99 Operations Street',
          city: 'Pune',
          state: 'Maharashtra',
          postalCode: '411001',
          countryCode: 'IN',
        },
        items: [
          {
            productId,
            variantId,
            productName: 'Phase 9 Operations Product',
            productSlug: `phase9-${suffix.toLowerCase()}`,
            sku: `PHASE9-${suffix}`,
            variantTitle: 'Default',
            attributes: [{ name: 'phase', value: '9' }],
            unitPriceInPaise,
            discountInPaise: 0,
            taxInPaise: 0,
            quantity,
            lineTotalInPaise: unitPriceInPaise * quantity,
          },
        ],
        totals: {
          subtotalInPaise: unitPriceInPaise * quantity,
          itemDiscountInPaise: 0,
          couponDiscountInPaise: 0,
          shippingInPaise: 0,
          taxInPaise: 0,
          grandTotalInPaise: unitPriceInPaise * quantity,
        },
        currency: 'INR',
        lifecycleStatus: OrderLifecycleStatus.Confirmed,
        financialStatus: FinancialStatus.Paid,
        fulfillmentStatus: FulfillmentStatus.Unfulfilled,
        paymentExpiresAt: new Date(Date.now() - 60_000),
        statusHistory: [],
      },
    ]);
    await inventory.create({
      productId,
      variantId,
      sku: `PHASE9-${suffix}`,
      onHand: 10 - quantity,
      reserved: 0,
      sold: quantity,
      reorderPoint: 0,
    });
    await attempts.create({
      orderId: order._id,
      orderNumber,
      attemptNumber: 1,
      idempotencyKey: `phase9-payment-${suffix}-0001`,
      idempotencyRequestHash: '8'.repeat(64),
      provider: PaymentProvider.Razorpay,
      providerReceipt: orderNumber,
      amountInPaise: unitPriceInPaise * quantity,
      currency: 'INR',
      status: PaymentAttemptStatus.Captured,
      providerOrderId: `order_PHASE9${suffix}ORDER`,
      providerPaymentId: `pay_PHASE9${suffix}PAYMENT`,
      signatureVerifiedAt: new Date(),
      authorizedAt: new Date(),
      capturedAt: new Date(),
      refundedInPaise: 0,
      refundPendingInPaise: 0,
    });
    return { order, productId, variantId };
  }

  function providerRefund(
    refund: RefundDocument,
    status: RazorpayRefundStatus,
  ): RazorpayProviderRefund {
    if (!refund.providerRefundId) throw new Error('Fixture provider refund ID is missing');
    return {
      id: refund.providerRefundId,
      paymentId: refund.providerPaymentId,
      amountInPaise: refund.amountInPaise,
      currency: refund.currency,
      receipt: refund.providerReceipt,
      status,
      acquirerReference: status === 'processed' ? 'ARNPHASE9WEBHOOK0001' : undefined,
      createdAt: new Date(),
    };
  }

  function refundWebhookPayload(
    event: string,
    refund: RazorpayProviderRefund,
  ): Record<string, unknown> {
    return {
      entity: 'event',
      event,
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        refund: {
          entity: {
            id: refund.id,
            entity: 'refund',
            payment_id: refund.paymentId,
            amount: refund.amountInPaise,
            currency: refund.currency,
            receipt: refund.receipt,
            status: refund.status,
            acquirer_data: { arn: refund.acquirerReference ?? null },
            created_at: Math.floor(refund.createdAt.getTime() / 1000),
          },
        },
      },
    };
  }

  function sendWebhook(eventId: string, payload: Record<string, unknown>): request.Test {
    const rawBody = JSON.stringify(payload);
    return request(httpServer)
      .post('/api/v1/payments/razorpay/webhook')
      .set('content-type', 'application/json')
      .set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', gateway.signWebhook(rawBody))
      .send(rawBody);
  }
});
