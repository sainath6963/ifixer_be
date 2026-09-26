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
import { Cart } from '../src/database/schemas/cart.schema';
import { Product } from '../src/database/schemas/catalog.schema';
import { Coupon, CouponRedemption } from '../src/database/schemas/coupon.schema';
import { Customer, CustomerSession } from '../src/database/schemas/identity.schema';
import { OutboxEvent, WebhookEvent } from '../src/database/schemas/integration.schema';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
} from '../src/database/schemas/inventory.schema';
import { Order } from '../src/database/schemas/order.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { PaymentAttempt } from '../src/database/schemas/payment.schema';
import {
  FinancialStatus,
  CouponDiscountType,
  CouponRedemptionStatus,
  CouponStatus,
  InventoryReservationStatus,
  OrderLifecycleStatus,
  PaymentAttemptStatus,
  ProductStatus,
  WebhookStatus,
} from '../src/domain/enums';
import { CheckoutService } from '../src/modules/checkout/checkout.service';
import { RAZORPAY_GATEWAY } from '../src/modules/payments/payment.constants';
import type {
  CreateRazorpayOrderInput,
  RazorpayGateway,
  RazorpayProviderOrder,
  RazorpayProviderPayment,
  RazorpayProviderRefund,
} from '../src/modules/payments/razorpay.types';
import { RazorpayGatewayError } from '../src/modules/payments/razorpay.types';

interface CartBody {
  cart: { version: number };
}

interface InternalOrderBody {
  order: {
    id: string;
    orderNumber: string;
    lifecycleStatus: string;
    financialStatus: string;
    totals: { grandTotalInPaise: number; couponDiscountInPaise: number };
    coupon?: { code: string; discountInPaise: number };
  };
}

interface CheckoutBody {
  checkout: {
    paymentAttemptId: string;
    keyId: string;
    providerOrderId: string;
    amountInPaise: number;
    currency: string;
    checkoutName: string;
  };
}

class FakeRazorpayGateway implements RazorpayGateway {
  readonly keyId = 'rzp_test_phase8example';
  readonly checkoutName = 'Rich Culture Test';
  readonly createdInputs: CreateRazorpayOrderInput[] = [];
  private readonly apiSecret = 'test-razorpay-api-secret-32-characters';
  private readonly webhookSecret = 'test-razorpay-webhook-secret-32-characters';
  private readonly orders = new Map<string, RazorpayProviderOrder>();
  private readonly receiptIndex = new Map<string, string>();
  private readonly payments = new Map<string, RazorpayProviderPayment>();

  async createOrder(input: CreateRazorpayOrderInput): Promise<RazorpayProviderOrder> {
    const existing = await this.findOrderByReceipt(input.receipt);
    if (existing) throw new RazorpayGatewayError('Duplicate receipt', 'BAD_REQUEST_ERROR', 400);
    this.createdInputs.push(input);
    const id = `order_PHASE8TEST${String(this.createdInputs.length).padStart(6, '0')}`;
    const order: RazorpayProviderOrder = {
      id,
      amountInPaise: input.amountInPaise,
      currency: input.currency,
      receipt: input.receipt,
      status: 'created',
      createdAt: new Date(),
    };
    this.orders.set(id, order);
    this.receiptIndex.set(input.receipt, id);
    return order;
  }

  findOrderByReceipt(receipt: string): Promise<RazorpayProviderOrder | undefined> {
    const id = this.receiptIndex.get(receipt);
    return Promise.resolve(id ? this.orders.get(id) : undefined);
  }

  fetchOrder(providerOrderId: string): Promise<RazorpayProviderOrder> {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new RazorpayGatewayError('Order missing', 'NOT_FOUND', 404);
    return Promise.resolve(order);
  }

  fetchPayment(providerPaymentId: string): Promise<RazorpayProviderPayment> {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) throw new RazorpayGatewayError('Payment missing', 'NOT_FOUND', 404);
    return Promise.resolve(payment);
  }

  fetchPaymentsForOrder(providerOrderId: string): Promise<RazorpayProviderPayment[]> {
    return Promise.resolve(
      [...this.payments.values()].filter((payment) => payment.orderId === providerOrderId),
    );
  }

  createRefund(): Promise<RazorpayProviderRefund> {
    return Promise.reject(new Error('Refunds are outside this payment lifecycle fixture'));
  }

  findRefundByReceipt(): Promise<RazorpayProviderRefund | undefined> {
    return Promise.resolve(undefined);
  }

  fetchRefund(): Promise<RazorpayProviderRefund> {
    return Promise.reject(new Error('Refunds are outside this payment lifecycle fixture'));
  }

  verifyPaymentSignature(
    providerOrderId: string,
    providerPaymentId: string,
    signature: string,
  ): boolean {
    return signature === this.signPayment(providerOrderId, providerPaymentId);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return signature === createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  addPayment(payment: RazorpayProviderPayment): void {
    this.payments.set(payment.id, payment);
    const order = this.orders.get(payment.orderId);
    if (order) {
      order.status = payment.status === 'captured' ? 'paid' : 'attempted';
    }
  }

  signPayment(providerOrderId: string, providerPaymentId: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest('hex');
  }

  signWebhook(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
}

describe('Razorpay payment lifecycle (e2e)', () => {
  const email = 'phase8-customer@richculture.test';
  const password = 'Phase8-customer-password';
  const productSlug = 'phase8-payment-product';
  const sku = 'PHASE8-PAYMENT-PRODUCT';
  const unitPriceInPaise = 249_900;
  const startedAt = new Date();
  const gateway = new FakeRazorpayGateway();
  const address = {
    fullName: 'Phase 8 Customer',
    phone: '+919876543210',
    line1: '88 Payment Street',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411001',
    countryCode: 'IN',
  };

  let app: INestApplication;
  let httpServer: Server;
  let browser: ReturnType<typeof request.agent>;
  let csrfToken: string;
  let productId: Types.ObjectId;
  let variantId: Types.ObjectId;
  let carts: Model<Cart>;
  let customers: Model<Customer>;
  let customerSessions: Model<CustomerSession>;
  let products: Model<Product>;
  let coupons: Model<Coupon>;
  let couponRedemptions: Model<CouponRedemption>;
  let inventory: Model<InventoryLevel>;
  let reservations: Model<InventoryReservation>;
  let movements: Model<InventoryMovement>;
  let orders: Model<Order>;
  let attempts: Model<PaymentAttempt>;
  let webhookEvents: Model<WebhookEvent>;
  let outbox: Model<OutboxEvent>;
  let auditLogs: Model<AuditLog>;
  let checkoutService: CheckoutService;

  const cleanFixtures = async (): Promise<void> => {
    const orderDocuments = await orders.find({ idempotencyKey: /^phase8-order-/ }).select('_id');
    const orderIds = orderDocuments.map((order) => order._id);
    const orderIdStrings = orderIds.map((orderId) => orderId.toHexString());
    const productDocuments = await products.find({ slug: productSlug }).select('_id');
    const productIds = productDocuments.map((product) => product._id);
    const customerDocuments = await customers.find({ email }).select('_id');
    const customerIds = customerDocuments.map((customer) => customer._id);

    await couponRedemptions.deleteMany({ code: /^PHASE16-/ });
    await coupons.deleteMany({ code: /^PHASE16-/ });

    await webhookEvents.deleteMany({ eventId: /^phase8-/ });
    await attempts.deleteMany({ orderId: { $in: orderIds } });
    await outbox.deleteMany({ aggregateId: { $in: orderIds } });
    await movements.deleteMany({
      $or: [{ referenceId: { $in: orderIdStrings } }, { productId: { $in: productIds } }],
    });
    await reservations.deleteMany({
      $or: [{ orderId: { $in: orderIds } }, { productId: { $in: productIds } }],
    });
    await orders.deleteMany({ _id: { $in: orderIds } });
    await carts.deleteMany({
      $or: [{ customerId: { $in: customerIds } }, { 'items.productId': { $in: productIds } }],
    });
    await customerSessions.deleteMany({ customerId: { $in: customerIds } });
    await inventory.deleteMany({ productId: { $in: productIds } });
    await products.deleteMany({ _id: { $in: productIds } });
    await customers.deleteMany({ _id: { $in: customerIds } });
    await auditLogs.deleteMany({
      action: { $in: [/^CUSTOMER_PAYMENT_/, /^ORDER_PAYMENT_/, /^ORDER_LATE_PAYMENT_/] },
      occurredAt: { $gte: startedAt },
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
    carts = app.get(getModelToken(Cart.name));
    customers = app.get(getModelToken(Customer.name));
    customerSessions = app.get(getModelToken(CustomerSession.name));
    products = app.get(getModelToken(Product.name));
    coupons = app.get(getModelToken(Coupon.name));
    couponRedemptions = app.get(getModelToken(CouponRedemption.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    reservations = app.get(getModelToken(InventoryReservation.name));
    movements = app.get(getModelToken(InventoryMovement.name));
    orders = app.get(getModelToken(Order.name));
    attempts = app.get(getModelToken(PaymentAttempt.name));
    webhookEvents = app.get(getModelToken(WebhookEvent.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    checkoutService = app.get(CheckoutService);
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    variantId = new Types.ObjectId();
    const product = await products.create({
      name: 'Phase 8 Payment Product',
      slug: productSlug,
      description: 'Product used to verify Razorpay payment state transitions.',
      categoryIds: [],
      variants: [
        {
          variantId,
          sku,
          title: 'Default',
          attributes: [{ name: 'style', value: 'Default' }],
          priceInPaise: unitPriceInPaise,
          isActive: true,
          sortOrder: 0,
        },
      ],
      images: [],
      tags: ['phase8'],
      status: ProductStatus.Active,
      publishedAt: new Date(Date.now() - 60_000),
    });
    productId = product._id;
    await inventory.create({
      productId,
      variantId,
      sku,
      onHand: 10,
      reserved: 0,
      sold: 0,
    });
    browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    csrfToken = (csrfResponse.body as { csrfToken: string }).csrfToken;
    await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Phase 8 Customer', email, password })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('creates Phase 8 payment, webhook, and capture indexes', async () => {
    const paymentIndexes = (await attempts.collection.indexes()).map((index) => index.name);
    const webhookIndexes = (await webhookEvents.collection.indexes()).map((index) => index.name);
    const movementIndexes = (await movements.collection.indexes()).map((index) => index.name);
    expect(paymentIndexes).toEqual(
      expect.arrayContaining([
        'uq_payment_attempts_order_provider',
        'uq_payment_attempts_provider_receipt',
        'uq_payment_attempts_provider_order_when_present',
        'uq_payment_attempts_provider_payment_when_present',
        'ix_payment_attempts_reconcile_v2',
      ]),
    );
    expect(webhookIndexes).toContain('uq_webhook_events_provider_event');
    expect(movementIndexes).toContain('uq_inventory_movements_payment_capture');
  });

  it('initiates one provider order and verifies a captured browser payment exactly once', async () => {
    const order = await createInternalOrder(2, 'phase8-order-browser-0001');
    const paymentKey = 'phase8-payment-browser-0001';
    await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .expect(400)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
      });

    const initiateResponse = await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', paymentKey)
      .expect(201);
    const providerCheckout = (initiateResponse.body as CheckoutBody).checkout;
    expect(providerCheckout).toMatchObject({
      keyId: gateway.keyId,
      amountInPaise: unitPriceInPaise * 2,
      currency: 'INR',
      checkoutName: gateway.checkoutName,
    });
    expect(JSON.stringify(providerCheckout)).not.toContain('secret');
    expect(gateway.createdInputs).toHaveLength(1);
    expect(gateway.createdInputs[0]).toMatchObject({
      amountInPaise: unitPriceInPaise * 2,
      receipt: order.orderNumber,
      internalOrderId: order.id,
    });

    const retry = await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', 'phase8-payment-browser-reload-0001')
      .expect(201);
    expect((retry.body as CheckoutBody).checkout.providerOrderId).toBe(
      providerCheckout.providerOrderId,
    );
    expect(gateway.createdInputs).toHaveLength(1);

    const payment = providerPayment(
      'pay_PHASE8BROWSER0001',
      providerCheckout.providerOrderId,
      unitPriceInPaise * 2,
      'captured',
    );
    gateway.addPayment(payment);
    await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay/verify`)
      .set('x-csrf-token', csrfToken)
      .send({
        razorpayOrderId: providerCheckout.providerOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: '0'.repeat(64),
      })
      .expect(401)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PAYMENT_SIGNATURE_INVALID' });
      });

    const signature = gateway.signPayment(providerCheckout.providerOrderId, payment.id);
    await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay/verify`)
      .set('x-csrf-token', csrfToken)
      .send({
        razorpayOrderId: providerCheckout.providerOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: signature,
      })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          payment: {
            status: PaymentAttemptStatus.Captured,
            providerPaymentId: payment.id,
            signatureVerified: true,
          },
          order: {
            lifecycleStatus: OrderLifecycleStatus.Confirmed,
            financialStatus: FinancialStatus.Paid,
          },
        });
      });
    await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay/verify`)
      .set('x-csrf-token', csrfToken)
      .send({
        razorpayOrderId: providerCheckout.providerOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: signature,
      })
      .expect(200);

    expect(await attempts.countDocuments({ orderId: order.id })).toBe(1);
    const level = await inventory.findOne({ variantId }).orFail();
    expect(level).toMatchObject({ onHand: 8, reserved: 0, sold: 2 });
    expect(
      await reservations.countDocuments({
        orderId: order.id,
        status: InventoryReservationStatus.Committed,
      }),
    ).toBe(1);
    expect(
      await movements.countDocuments({
        referenceType: 'PAYMENT_CAPTURE_COMMIT',
        referenceId: order.id,
      }),
    ).toBe(1);
    expect(await outbox.countDocuments({ eventId: `order-paid:${order.id}` })).toBe(1);
  }, 60_000);

  it('deduplicates signed webhooks and never downgrades a captured payment', async () => {
    const order = await createInternalOrder(1, 'phase8-order-webhook-0001');
    await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', 'phase8-payment-browser-0001')
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });
    const initiateResponse = await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', 'phase8-payment-webhook-0001')
      .expect(201);
    const providerOrderId = (initiateResponse.body as CheckoutBody).checkout.providerOrderId;

    await sendWebhook(
      'phase8-invalid-signature-0001',
      webhookPayload(
        'payment.authorized',
        providerPayment('pay_PHASE8WEBHOOK0001', providerOrderId, unitPriceInPaise, 'authorized'),
      ),
      '0'.repeat(64),
    ).expect(401);
    expect(await webhookEvents.countDocuments({ eventId: 'phase8-invalid-signature-0001' })).toBe(
      0,
    );

    const authorizedPayment = providerPayment(
      'pay_PHASE8WEBHOOK0001',
      providerOrderId,
      unitPriceInPaise,
      'authorized',
    );
    gateway.addPayment(authorizedPayment);
    const authorizedPayload = webhookPayload('payment.authorized', authorizedPayment);
    await sendWebhook('phase8-authorized-0001', authorizedPayload).expect(204);
    await sendWebhook('phase8-authorized-0001', authorizedPayload).expect(204);
    expect((await orders.findById(order.id).orFail()).financialStatus).toBe(
      FinancialStatus.Pending,
    );
    expect((await attempts.findOne({ orderId: order.id }).orFail()).status).toBe(
      PaymentAttemptStatus.Authorized,
    );
    expect(await webhookEvents.countDocuments({ eventId: 'phase8-authorized-0001' })).toBe(1);

    const capturedPayment = { ...authorizedPayment, status: 'captured' as const, captured: true };
    gateway.addPayment(capturedPayment);
    const capturedPayload = webhookPayload('payment.captured', capturedPayment);
    await sendWebhook('phase8-captured-0001', capturedPayload).expect(204);
    expect(await orders.findById(order.id).lean()).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.Confirmed,
      financialStatus: FinancialStatus.Paid,
    });

    const failedPayment = providerPayment(
      'pay_PHASE8WEBHOOKFAIL01',
      providerOrderId,
      unitPriceInPaise,
      'failed',
    );
    await sendWebhook(
      'phase8-failed-after-capture-0001',
      webhookPayload('payment.failed', failedPayment),
    ).expect(204);
    expect(await orders.findById(order.id).lean()).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.Confirmed,
      financialStatus: FinancialStatus.Paid,
    });
    expect((await attempts.findOne({ orderId: order.id }).orFail()).status).toBe(
      PaymentAttemptStatus.Captured,
    );

    const changedPayload = webhookPayload('payment.failed', {
      ...failedPayment,
      errorDescription: 'Changed replay body',
    });
    await sendWebhook('phase8-failed-after-capture-0001', changedPayload).expect(409);
    expect((await webhookEvents.findOne({ eventId: 'phase8-captured-0001' }).orFail()).status).toBe(
      WebhookStatus.Processed,
    );
    const level = await inventory.findOne({ variantId }).orFail();
    expect(level).toMatchObject({ onHand: 7, reserved: 0, sold: 3 });
  }, 60_000);

  it('records a captured payment after expiry without selling released inventory', async () => {
    const order = await createInternalOrder(1, 'phase8-order-late-0001');
    const initiateResponse = await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', 'phase8-payment-late-0001')
      .expect(201);
    const providerOrderId = (initiateResponse.body as CheckoutBody).checkout.providerOrderId;

    const past = new Date(Date.now() - 60_000);
    await orders.updateOne({ _id: order.id }, { $set: { paymentExpiresAt: past } });
    await reservations.updateOne({ orderId: order.id }, { $set: { expiresAt: past } });
    expect(await checkoutService.expirePendingOrders()).toBe(1);
    const beforeCapture = await inventory.findOne({ variantId }).orFail();
    expect(beforeCapture).toMatchObject({ onHand: 7, reserved: 0, sold: 3 });

    const latePayment = providerPayment(
      'pay_PHASE8LATEPAY0001',
      providerOrderId,
      unitPriceInPaise,
      'captured',
    );
    gateway.addPayment(latePayment);
    await sendWebhook(
      'phase8-late-capture-0001',
      webhookPayload('payment.captured', latePayment),
    ).expect(204);

    expect(await orders.findById(order.id).lean()).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.Expired,
      financialStatus: FinancialStatus.Paid,
    });
    expect((await attempts.findOne({ orderId: order.id }).orFail()).status).toBe(
      PaymentAttemptStatus.Captured,
    );
    const afterCapture = await inventory.findOne({ variantId }).orFail();
    expect(afterCapture).toMatchObject({ onHand: 7, reserved: 0, sold: 3 });
    expect(
      await movements.countDocuments({
        referenceType: 'PAYMENT_CAPTURE_COMMIT',
        referenceId: order.id,
      }),
    ).toBe(0);
    expect(await outbox.countDocuments({ eventId: `order-late-payment:${order.id}` })).toBe(1);
  }, 60_000);

  it('redeems a coupon on capture and releases a different coupon on cancellation', async () => {
    const customer = await customers.findOne({ email }).orFail();
    const adminId = new Types.ObjectId();
    const paidCoupon = await coupons.create({
      code: 'PHASE16-PAID',
      name: 'Phase 16 paid coupon',
      status: CouponStatus.Active,
      discountType: CouponDiscountType.FixedAmount,
      fixedAmountInPaise: 50_000,
      minimumSubtotalInPaise: 100_000,
      usageLimit: 5,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      createdBy: adminId,
      updatedBy: adminId,
    });
    const order = await createInternalOrder(1, 'phase8-order-coupon-paid-0001', paidCoupon.code);
    expect(order).toMatchObject({
      totals: { grandTotalInPaise: unitPriceInPaise - 50_000, couponDiscountInPaise: 50_000 },
      coupon: { code: paidCoupon.code, discountInPaise: 50_000 },
    });
    expect(await coupons.findById(paidCoupon.id).lean()).toMatchObject({
      reservedCount: 1,
      redeemedCount: 0,
    });

    const initiate = await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay`)
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', 'phase8-payment-coupon-paid-0001')
      .expect(201);
    const providerOrderId = (initiate.body as CheckoutBody).checkout.providerOrderId;
    expect((initiate.body as CheckoutBody).checkout.amountInPaise).toBe(unitPriceInPaise - 50_000);
    const payment = providerPayment(
      'pay_PHASE16COUPONPAID01',
      providerOrderId,
      unitPriceInPaise - 50_000,
      'captured',
    );
    gateway.addPayment(payment);
    await browser
      .post(`/api/v1/customer/orders/${order.orderNumber}/payments/razorpay/verify`)
      .set('x-csrf-token', csrfToken)
      .send({
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: gateway.signPayment(providerOrderId, payment.id),
      })
      .expect(200);
    expect(await coupons.findById(paidCoupon.id).lean()).toMatchObject({
      reservedCount: 0,
      redeemedCount: 1,
    });
    expect(await couponRedemptions.findOne({ orderId: order.id }).lean()).toMatchObject({
      customerId: customer._id,
      status: CouponRedemptionStatus.Redeemed,
      active: true,
    });

    const releasedCoupon = await coupons.create({
      code: 'PHASE16-RELEASED',
      name: 'Phase 16 released coupon',
      status: CouponStatus.Active,
      discountType: CouponDiscountType.Percentage,
      percentageOff: 10,
      maximumDiscountInPaise: 25_000,
      minimumSubtotalInPaise: 0,
      usageLimit: 1,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      createdBy: adminId,
      updatedBy: adminId,
    });
    const cancelled = await createInternalOrder(
      1,
      'phase8-order-coupon-release-0001',
      releasedCoupon.code,
    );
    await browser
      .post(`/api/v1/customer/orders/${cancelled.orderNumber}/cancel`)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(await coupons.findById(releasedCoupon.id).lean()).toMatchObject({
      reservedCount: 0,
      redeemedCount: 0,
    });
    expect(await couponRedemptions.findOne({ orderId: cancelled.id }).lean()).toMatchObject({
      status: CouponRedemptionStatus.Released,
      active: false,
    });
  }, 60_000);

  async function createInternalOrder(
    quantity: number,
    idempotencyKey: string,
    couponCode?: string,
  ): Promise<InternalOrderBody['order']> {
    const cartResponse = await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrfToken)
      .send({ productId: productId.toHexString(), quantity, expectedVersion: 0 })
      .expect(200);
    const cartVersion = (cartResponse.body as CartBody).cart.version;
    const response = await browser
      .post('/api/v1/checkout/orders')
      .set('x-csrf-token', csrfToken)
      .set('idempotency-key', idempotencyKey)
      .send({ expectedCartVersion: cartVersion, shippingAddress: address, couponCode })
      .expect(201);
    return (response.body as InternalOrderBody).order;
  }

  function providerPayment(
    id: string,
    orderId: string,
    amountInPaise: number,
    status: RazorpayProviderPayment['status'],
  ): RazorpayProviderPayment {
    return {
      id,
      orderId,
      amountInPaise,
      currency: 'INR',
      status,
      captured: status === 'captured',
      errorCode: status === 'failed' ? 'BAD_REQUEST_ERROR' : undefined,
      errorDescription: status === 'failed' ? 'Payment processing failed' : undefined,
      createdAt: new Date(),
    };
  }

  function webhookPayload(
    event: string,
    payment: RazorpayProviderPayment,
  ): Record<string, unknown> {
    return {
      entity: 'event',
      event,
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: payment.id,
            entity: 'payment',
            order_id: payment.orderId,
            amount: payment.amountInPaise,
            currency: payment.currency,
            status: payment.status,
            captured: payment.captured,
            error_code: payment.errorCode ?? null,
            error_description: payment.errorDescription ?? null,
            created_at: Math.floor(payment.createdAt.getTime() / 1000),
          },
        },
      },
    };
  }

  function sendWebhook(
    eventId: string,
    payload: Record<string, unknown>,
    signature?: string,
  ): request.Test {
    const rawBody = JSON.stringify(payload);
    return request(httpServer)
      .post('/api/v1/payments/razorpay/webhook')
      .set('content-type', 'application/json')
      .set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', signature ?? gateway.signWebhook(rawBody))
      .send(rawBody);
  }
});
