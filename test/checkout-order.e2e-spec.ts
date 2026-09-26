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
import { Cart } from '../src/database/schemas/cart.schema';
import { Product } from '../src/database/schemas/catalog.schema';
import { Customer, CustomerSession } from '../src/database/schemas/identity.schema';
import { OutboxEvent } from '../src/database/schemas/integration.schema';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
} from '../src/database/schemas/inventory.schema';
import { Order } from '../src/database/schemas/order.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import {
  CartStatus,
  FulfillmentStatus,
  InventoryReservationStatus,
  OrderLifecycleStatus,
  ProductStatus,
} from '../src/domain/enums';
import { CheckoutService } from '../src/modules/checkout/checkout.service';

interface CartBody {
  cart: {
    id: string;
    version: number;
    totalQuantity: number;
    subtotalInPaise: number;
  };
}

interface OrderBody {
  order: {
    id: string;
    orderNumber: string;
    lifecycleStatus: string;
    fulfillmentStatus: string;
    totals: { subtotalInPaise: number; grandTotalInPaise: number };
    paymentReady: boolean;
  };
}

interface CustomerBrowser {
  browser: ReturnType<typeof request.agent>;
  csrfToken: string;
  email: string;
  cartVersion: number;
}

describe('Transactional checkout and customer orders (e2e)', () => {
  const emails = ['phase7-alpha@richculture.test', 'phase7-beta@richculture.test'];
  const password = 'Phase7-customer-password';
  const productSlug = 'phase7-concurrent-checkout-product';
  const sku = 'PHASE7-CONCURRENT-CHECKOUT';
  const unitPriceInPaise = 249_900;
  const startedAt = new Date();
  const address = {
    fullName: 'Phase 7 Customer',
    phone: '+919876543210',
    line1: '42 Transaction Street',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411001',
    countryCode: 'IN',
  };

  let app: INestApplication;
  let httpServer: Server;
  let carts: Model<Cart>;
  let customers: Model<Customer>;
  let customerSessions: Model<CustomerSession>;
  let products: Model<Product>;
  let inventory: Model<InventoryLevel>;
  let reservations: Model<InventoryReservation>;
  let movements: Model<InventoryMovement>;
  let orders: Model<Order>;
  let outbox: Model<OutboxEvent>;
  let auditLogs: Model<AuditLog>;
  let checkout: CheckoutService;
  let productId: Types.ObjectId;
  let variantId: Types.ObjectId;

  const cleanFixtures = async (): Promise<void> => {
    const orderDocuments = await orders.find({ idempotencyKey: /^phase7-/ }).select('_id');
    const orderIds = orderDocuments.map((order) => order._id);
    const orderIdStrings = orderIds.map((orderId) => orderId.toHexString());
    const productDocuments = await products.find({ slug: productSlug }).select('_id');
    const productIds = productDocuments.map((product) => product._id);
    const customerDocuments = await customers.find({ email: { $in: emails } }).select('_id');
    const customerIds = customerDocuments.map((customer) => customer._id);

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
      action: { $in: [/^CUSTOMER_ORDER_/, /^ORDER_PAYMENT_/] },
      occurredAt: { $gte: startedAt },
    });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    carts = app.get(getModelToken(Cart.name));
    customers = app.get(getModelToken(Customer.name));
    customerSessions = app.get(getModelToken(CustomerSession.name));
    products = app.get(getModelToken(Product.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    reservations = app.get(getModelToken(InventoryReservation.name));
    movements = app.get(getModelToken(InventoryMovement.name));
    orders = app.get(getModelToken(Order.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    checkout = app.get(CheckoutService);
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    variantId = new Types.ObjectId();
    const product = await products.create({
      name: 'Phase 7 Concurrent Checkout Product',
      slug: productSlug,
      description: 'Product used to verify atomic inventory reservations during checkout.',
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
      tags: ['phase7'],
      status: ProductStatus.Active,
      publishedAt: new Date(Date.now() - 60_000),
    });
    productId = product._id;
    await inventory.create({
      productId,
      variantId,
      sku,
      onHand: 5,
      reserved: 0,
      sold: 0,
    });
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('creates the order and inventory indexes used by checkout transitions', async () => {
    const orderIndexes = (await orders.collection.indexes()).map((index) => index.name);
    const reservationIndexes = (await reservations.collection.indexes()).map((index) => index.name);
    const movementIndexes = (await movements.collection.indexes()).map((index) => index.name);
    expect(orderIndexes).toEqual(
      expect.arrayContaining([
        'uq_orders_number',
        'uq_orders_idempotency',
        'ix_orders_customer_lifecycle_created',
        'ix_orders_payment_expiry',
      ]),
    );
    expect(reservationIndexes).toContain('ix_inventory_reservations_order_status');
    expect(movementIndexes).toContain('uq_inventory_movements_checkout_transition');
  });

  it('prevents overselling and supports idempotent create, ownership, cancel, and expiry', async () => {
    const shoppers = await Promise.all(emails.map((email) => registerShopper(email)));
    for (const shopper of shoppers) {
      const cartResponse = await shopper.browser
        .put(`/api/v1/cart/items/${variantId.toHexString()}`)
        .set('x-csrf-token', shopper.csrfToken)
        .send({ productId: productId.toHexString(), quantity: 4, expectedVersion: 0 })
        .expect(200);
      shopper.cartVersion = (cartResponse.body as CartBody).cart.version;
    }

    const checkoutBodies = shoppers.map((shopper) => ({
      expectedCartVersion: shopper.cartVersion,
      shippingAddress: { ...address, fullName: shopper.email },
    }));
    await shoppers[0].browser
      .post('/api/v1/checkout/preview')
      .set('x-csrf-token', shoppers[0].csrfToken)
      .send({ ...checkoutBodies[0], expectedCartVersion: 0 })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'CART_VERSION_CONFLICT' });
      });
    await shoppers[0].browser
      .post('/api/v1/checkout/preview')
      .set('x-csrf-token', shoppers[0].csrfToken)
      .send(checkoutBodies[0])
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          preview: {
            readyToCreateOrder: true,
            totals: {
              subtotalInPaise: unitPriceInPaise * 4,
              grandTotalInPaise: unitPriceInPaise * 4,
              currency: 'INR',
            },
          },
        });
      });
    await shoppers[0].browser
      .post('/api/v1/checkout/orders')
      .set('x-csrf-token', shoppers[0].csrfToken)
      .send(checkoutBodies[0])
      .expect(400)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
      });

    const keys = ['phase7-alpha-checkout-0001', 'phase7-beta-checkout-0001'];
    const attempts = await Promise.all(
      shoppers.map((shopper, index) =>
        shopper.browser
          .post('/api/v1/checkout/orders')
          .set('x-csrf-token', shopper.csrfToken)
          .set('idempotency-key', keys[index])
          .send(checkoutBodies[index]),
      ),
    );
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);

    const winnerIndex = attempts.findIndex((response) => response.status === 201);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerOrder = (attempts[winnerIndex].body as OrderBody).order;
    expect(winnerOrder).toMatchObject({
      lifecycleStatus: OrderLifecycleStatus.PendingPayment,
      fulfillmentStatus: FulfillmentStatus.Unfulfilled,
      totals: {
        subtotalInPaise: unitPriceInPaise * 4,
        grandTotalInPaise: unitPriceInPaise * 4,
      },
      paymentReady: true,
    });
    for (const privateField of [
      'idempotencyKey',
      'idempotencyRequestHash',
      'sourceCartId',
      'storageKey',
      'reserved',
      'onHand',
    ]) {
      expect(winnerOrder).not.toHaveProperty(privateField);
      expect(winnerOrder).not.toHaveProperty(`items.0.${privateField}`);
    }
    expect(attempts[loserIndex].body).toMatchObject({ code: 'CHECKOUT_ITEMS_UNAVAILABLE' });
    expect(await orders.countDocuments({ idempotencyKey: { $in: keys } })).toBe(1);
    expect(await reservations.countDocuments({ status: InventoryReservationStatus.Active })).toBe(
      1,
    );
    expect(await movements.countDocuments({ referenceType: 'CHECKOUT_RESERVATION' })).toBe(1);
    expect((await inventory.findOne({ variantId }).orFail()).reserved).toBe(4);

    const retry = await shoppers[winnerIndex].browser
      .post('/api/v1/checkout/orders')
      .set('x-csrf-token', shoppers[winnerIndex].csrfToken)
      .set('idempotency-key', keys[winnerIndex])
      .send(checkoutBodies[winnerIndex])
      .expect(201);
    expect((retry.body as OrderBody).order.id).toBe(winnerOrder.id);
    expect(await movements.countDocuments({ referenceType: 'CHECKOUT_RESERVATION' })).toBe(1);
    await shoppers[winnerIndex].browser
      .post('/api/v1/checkout/orders')
      .set('x-csrf-token', shoppers[winnerIndex].csrfToken)
      .set('idempotency-key', keys[winnerIndex])
      .send({
        ...checkoutBodies[winnerIndex],
        shippingAddress: { ...checkoutBodies[winnerIndex].shippingAddress, city: 'Mumbai' },
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });

    await shoppers[winnerIndex].browser
      .get('/api/v1/customer/orders')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ total: 1, items: [{ id: winnerOrder.id }] });
      });
    await shoppers[winnerIndex].browser
      .get(`/api/v1/customer/orders/${winnerOrder.orderNumber}`)
      .expect(200);
    await shoppers[loserIndex].browser
      .get(`/api/v1/customer/orders/${winnerOrder.orderNumber}`)
      .expect(404)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'ORDER_NOT_FOUND' });
      });

    await shoppers[winnerIndex].browser
      .post(`/api/v1/customer/orders/${winnerOrder.orderNumber}/cancel`)
      .set('x-csrf-token', shoppers[winnerIndex].csrfToken)
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          order: {
            id: winnerOrder.id,
            lifecycleStatus: OrderLifecycleStatus.Cancelled,
            fulfillmentStatus: FulfillmentStatus.Cancelled,
            paymentReady: false,
          },
        });
      });
    await shoppers[winnerIndex].browser
      .post(`/api/v1/customer/orders/${winnerOrder.orderNumber}/cancel`)
      .set('x-csrf-token', shoppers[winnerIndex].csrfToken)
      .expect(200);
    expect((await inventory.findOne({ variantId }).orFail()).reserved).toBe(0);
    expect(
      await reservations.countDocuments({
        orderId: winnerOrder.id,
        status: InventoryReservationStatus.Released,
      }),
    ).toBe(1);
    expect(
      await movements.countDocuments({
        referenceType: 'ORDER_CANCEL_RELEASE',
        referenceId: winnerOrder.id,
      }),
    ).toBe(1);

    const expiringResponse = await shoppers[loserIndex].browser
      .post('/api/v1/checkout/orders')
      .set('x-csrf-token', shoppers[loserIndex].csrfToken)
      .set('idempotency-key', keys[loserIndex])
      .send(checkoutBodies[loserIndex])
      .expect(201);
    const expiringOrder = (expiringResponse.body as OrderBody).order;
    expect(await orders.countDocuments({ idempotencyKey: { $in: keys } })).toBe(2);
    expect((await inventory.findOne({ variantId }).orFail()).reserved).toBe(4);

    const past = new Date(Date.now() - 60_000);
    await orders.updateOne({ _id: expiringOrder.id }, { $set: { paymentExpiresAt: past } });
    await reservations.updateOne({ orderId: expiringOrder.id }, { $set: { expiresAt: past } });
    expect(await checkout.expirePendingOrders()).toBe(1);
    expect(await checkout.expirePendingOrders()).toBe(0);
    expect((await orders.findById(expiringOrder.id).orFail()).lifecycleStatus).toBe(
      OrderLifecycleStatus.Expired,
    );
    expect((await inventory.findOne({ variantId }).orFail()).reserved).toBe(0);
    expect(
      await reservations.countDocuments({
        orderId: expiringOrder.id,
        status: InventoryReservationStatus.Expired,
      }),
    ).toBe(1);
    expect(
      await movements.countDocuments({
        referenceType: 'ORDER_EXPIRY_RELEASE',
        referenceId: expiringOrder.id,
      }),
    ).toBe(1);
    expect(await carts.countDocuments({ status: CartStatus.Converted })).toBe(2);
    expect(
      await outbox.countDocuments({ aggregateId: { $in: [winnerOrder.id, expiringOrder.id] } }),
    ).toBe(4);

    const actions = await auditLogs.distinct('action', {
      occurredAt: { $gte: startedAt },
      action: { $in: [/^CUSTOMER_ORDER_/, /^ORDER_PAYMENT_/] },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        'CUSTOMER_ORDER_CREATED',
        'CUSTOMER_ORDER_CANCELLED',
        'ORDER_PAYMENT_EXPIRED',
      ]),
    );
  }, 60_000);

  async function registerShopper(email: string): Promise<CustomerBrowser> {
    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    const csrfToken = (csrfResponse.body as { csrfToken: string }).csrfToken;
    await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Phase 7 Shopper', email, password })
      .expect(201);
    return { browser, csrfToken, email, cartVersion: 0 };
  }
});
