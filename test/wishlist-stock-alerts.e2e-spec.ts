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
import { Product } from '../src/database/schemas/catalog.schema';
import {
  AdminSession,
  AdminUser,
  Customer,
  CustomerSession,
} from '../src/database/schemas/identity.schema';
import { OutboxEvent } from '../src/database/schemas/integration.schema';
import { InventoryLevel } from '../src/database/schemas/inventory.schema';
import { Notification } from '../src/database/schemas/notification.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { StockAlert, WishlistItem } from '../src/database/schemas/wishlist.schema';
import {
  AccountStatus,
  AdminRole,
  OutboxStatus,
  ProductStatus,
  StockAlertStatus,
} from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import { NotificationProcessor } from '../src/modules/notifications/notification.processor';
import { NotificationQueueScheduler } from '../src/modules/notifications/notification-queue.scheduler';
import { OutboxRelayService } from '../src/modules/notifications/outbox-relay.service';
import { StockAlertDispatchService } from '../src/modules/wishlist/stock-alert-dispatch.service';

describe('Wishlist and back-in-stock alerts (e2e)', () => {
  const customerEmail = 'phase18-customer@richculture.test';
  const customerPassword = 'Phase18-customer-password';
  const ownerEmail = 'phase18-owner@richculture.test';
  const ownerPassword = 'Phase18-owner-password';
  const productId = new Types.ObjectId();
  const variantId = new Types.ObjectId();
  const productSlug = 'phase18-stock-alert-product';
  const startedAt = new Date();

  let app: INestApplication;
  let httpServer: Server;
  let products: Model<Product>;
  let inventory: Model<InventoryLevel>;
  let customers: Model<Customer>;
  let customerSessions: Model<CustomerSession>;
  let admins: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let wishlist: Model<WishlistItem>;
  let alerts: Model<StockAlert>;
  let outbox: Model<OutboxEvent>;
  let notifications: Model<Notification>;
  let audits: Model<AuditLog>;

  async function cleanup(): Promise<void> {
    const alertIds = (await alerts.find({ productId }).select('_id')).map((alert) => alert._id);
    const eventIds = alertIds.map((id) => `stock-alert:${id.toHexString()}`);
    await notifications.deleteMany({ sourceEventId: { $in: eventIds } });
    await outbox.deleteMany({ eventId: { $in: eventIds } });
    await alerts.deleteMany({ productId });
    await wishlist.deleteMany({ productId });
    await inventory.deleteMany({ productId });
    await products.deleteMany({ _id: productId });
    const customer = await customers.findOne({ email: customerEmail }).select('_id');
    if (customer) {
      await customerSessions.deleteMany({ customerId: customer._id });
      await customers.deleteOne({ _id: customer._id });
    }
    const admin = await admins.findOne({ email: ownerEmail }).select('_id');
    if (admin) {
      await adminSessions.deleteMany({ adminUserId: admin._id });
      await admins.deleteOne({ _id: admin._id });
    }
    await audits.deleteMany({
      resourceType: { $in: ['WISHLIST', 'STOCK_ALERT'] },
      occurredAt: { $gte: startedAt },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    })
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
    products = app.get(getModelToken(Product.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    customers = app.get(getModelToken(Customer.name));
    customerSessions = app.get(getModelToken(CustomerSession.name));
    admins = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    wishlist = app.get(getModelToken(WishlistItem.name));
    alerts = app.get(getModelToken(StockAlert.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    notifications = app.get(getModelToken(Notification.name));
    audits = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();
    await cleanup();
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanup();
    await app.close();
  });

  it('creates Phase 18 indexes and enforces stock-alert state invariants', async () => {
    expect((await wishlist.collection.indexes()).map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'uq_wishlist_items_customer_product',
        'ix_wishlist_items_customer_created',
      ]),
    );
    expect((await alerts.collection.indexes()).map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'uq_stock_alerts_customer_variant_active',
        'ix_stock_alerts_dispatch',
        'ix_stock_alerts_active_demand',
      ]),
    );
    await expect(
      alerts.collection.insertOne({
        customerId: new Types.ObjectId(),
        productId,
        variantId,
        productName: 'Invalid alert',
        productSlug: 'invalid-alert',
        variantTitle: 'Medium',
        sku: 'PHASE18-INVALID',
        status: StockAlertStatus.Notified,
        active: true,
        requestedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it('saves a product, tracks demand, and materializes one verified restock email', async () => {
    await request(httpServer).get('/api/v1/customer/wishlist').expect(401);
    await request(httpServer).get('/api/v1/admin/stock-demand').expect(401);

    const customerBrowser = request.agent(httpServer);
    const customerCsrf = (
      (await customerBrowser.get('/api/v1/customer/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await customerBrowser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', customerCsrf)
      .send({ name: 'Asha Kulkarni', email: customerEmail, password: customerPassword })
      .expect(201);
    const customer = await customers.findOne({ email: customerEmail }).orFail();

    await products.create({
      _id: productId,
      name: 'Phase 18 Stock Alert Product',
      slug: productSlug,
      description: 'A published product used to verify wishlist and stock alert operations.',
      status: ProductStatus.Active,
      publishedAt: new Date(),
      variants: [
        {
          variantId,
          sku: 'PHASE18-STOCK-M',
          title: 'Natural / Medium',
          attributes: [{ name: 'size', value: 'M' }],
          priceInPaise: 179_900,
          isActive: true,
        },
      ],
    });
    await inventory.create({
      productId,
      variantId,
      sku: 'PHASE18-STOCK-M',
      onHand: 0,
      reserved: 0,
      sold: 0,
      reorderPoint: 2,
    });

    const productPath = `/api/v1/customer/wishlist/${productId.toHexString()}`;
    await customerBrowser.post(productPath).expect(403);
    await customerBrowser.post(productPath).set('x-csrf-token', customerCsrf).expect(201);
    await customerBrowser.post(productPath).set('x-csrf-token', customerCsrf).expect(201);
    expect(await wishlist.countDocuments({ customerId: customer._id, productId })).toBe(1);
    await customerBrowser
      .get(`/api/v1/customer/wishlist/products/${productId.toHexString()}`)
      .expect(200)
      .expect({ wishlisted: true });
    await customerBrowser
      .get('/api/v1/customer/wishlist')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          total: 1,
          items: [{ product: { id: productId.toHexString(), slug: productSlug } }],
        });
      });

    const alertPath = `/api/v1/customer/stock-alerts/${productId.toHexString()}/variants/${variantId.toHexString()}`;
    await customerBrowser
      .post(alertPath)
      .set('x-csrf-token', customerCsrf)
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect((body as { code: string }).code).toBe('STOCK_ALERT_EMAIL_VERIFICATION_REQUIRED');
      });
    customer.emailVerifiedAt = new Date();
    await customer.save();
    const createdAlert = await customerBrowser
      .post(alertPath)
      .set('x-csrf-token', customerCsrf)
      .expect(201);
    await customerBrowser.post(alertPath).set('x-csrf-token', customerCsrf).expect(201);
    expect(await alerts.countDocuments({ customerId: customer._id, variantId })).toBe(1);
    await customerBrowser
      .get(`/api/v1/customer/stock-alerts/product/${productId.toHexString()}`)
      .expect(200)
      .expect({ emailEligible: true, activeVariantIds: [variantId.toHexString()] });

    const passwordHash = await app.get(PasswordService).hash(ownerPassword);
    await admins.create({
      name: 'Phase 18 Owner',
      email: ownerEmail,
      passwordHash,
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    const adminBrowser = request.agent(httpServer);
    const adminCsrf = (
      (await adminBrowser.get('/api/v1/admin/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await adminBrowser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', adminCsrf)
      .send({ email: ownerEmail, password: ownerPassword })
      .expect(200);
    await adminBrowser
      .get('/api/v1/admin/stock-demand?search=PHASE18-STOCK')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          total: 1,
          items: [
            {
              productId: productId.toHexString(),
              variantId: variantId.toHexString(),
              subscriberCount: 1,
              available: 0,
            },
          ],
        });
      });

    await inventory.updateOne({ variantId }, { $set: { onHand: 3 } });
    expect(await app.get(StockAlertDispatchService).processBatch()).toEqual({
      available: 1,
      dispatched: 1,
    });
    expect(await app.get(StockAlertDispatchService).processBatch()).toEqual({
      available: 0,
      dispatched: 0,
    });
    const alertId = (createdAlert.body as { id: string }).id;
    expect(await alerts.findById(alertId).lean()).toMatchObject({
      active: false,
      status: StockAlertStatus.Notified,
    });
    const eventId = `stock-alert:${alertId}`;
    expect(await outbox.findOne({ eventId }).lean()).toMatchObject({
      eventType: 'STOCK_ALERT_AVAILABLE',
      status: OutboxStatus.Pending,
    });

    const relay = app.get(OutboxRelayService);
    const relayResult = await relay.processBatch();
    expect(relayResult.failed).toBe(0);
    expect(await outbox.findOne({ eventId }).lean()).toMatchObject({
      status: OutboxStatus.Published,
    });
    const notification = await notifications.findOne({ sourceEventId: eventId }).orFail();
    expect(notification).toMatchObject({
      recipient: customerEmail,
      templateKey: 'STOCK_ALERT_AVAILABLE',
      subject: 'Phase 18 Stock Alert Product is back in stock',
    });
    expect(notification.textBody).toContain(
      `http://localhost:3000/products/${encodeURIComponent(productSlug)}`,
    );
    await relay.processBatch();
    expect(await notifications.countDocuments({ sourceEventId: eventId })).toBe(1);

    expect(
      await audits.distinct('action', {
        resourceType: { $in: ['WISHLIST', 'STOCK_ALERT'] },
        occurredAt: { $gte: startedAt },
      }),
    ).toEqual(expect.arrayContaining(['WISHLIST_ITEM_ADDED', 'STOCK_ALERT_SUBSCRIBED']));
  });
});
