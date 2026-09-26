import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { Model, Types } from 'mongoose';
import sharp from 'sharp';
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
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
} from '../src/database/schemas/inventory.schema';
import { OutboxEvent } from '../src/database/schemas/integration.schema';
import { Notification } from '../src/database/schemas/notification.schema';
import { Order } from '../src/database/schemas/order.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { ReturnRequest } from '../src/database/schemas/return-request.schema';
import { ReturnEvidence } from '../src/database/schemas/return-evidence.schema';
import {
  AccountStatus,
  AdminRole,
  AuditActorType,
  ExchangeReservationStatus,
  FinancialStatus,
  FulfillmentStatus,
  InventoryReservationStatus,
  OrderLifecycleStatus,
  ProductStatus,
  ReturnReason,
  ReturnRequestStatus,
  ReturnRequestType,
  ShipmentStatus,
  ShippingProvider,
} from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import { ReturnRequestService } from '../src/modules/returns/return-request.service';

interface ReturnBody {
  id: string;
  returnNumber: string;
  status: ReturnRequestStatus;
  version: number;
  items: Array<{ variantId: string; quantity: number; restockedQuantity: number }>;
  resolution?: { type: string; trackingNumber?: string };
  exchangeReservation?: {
    status: ExchangeReservationStatus;
    expiresAt?: string;
    finalizedAt?: string;
  };
}

interface EvidenceBody {
  id: string;
  originalFilename: string;
  mimeType: string;
  contentUrl: string;
}

describe('Customer return and exchange requests (e2e)', () => {
  const customerEmail = 'phase13-customer@richculture.test';
  const customerPassword = 'Phase13-customer-password';
  const ownerEmail = 'phase13-owner@richculture.test';
  const ownerPassword = 'Phase13-owner-password';
  const orderNumber = 'RC-20260810-A1B2C3D4E5';
  const productSlug = 'phase13-return-product';
  const originalVariantId = new Types.ObjectId();
  const exchangeVariantId = new Types.ObjectId();
  const startedAt = new Date();

  let app: INestApplication;
  let httpServer: Server;
  let customers: Model<Customer>;
  let customerSessions: Model<CustomerSession>;
  let admins: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let products: Model<Product>;
  let orders: Model<Order>;
  let returns: Model<ReturnRequest>;
  let evidence: Model<ReturnEvidence>;
  let outbox: Model<OutboxEvent>;
  let notifications: Model<Notification>;
  let inventory: Model<InventoryLevel>;
  let movements: Model<InventoryMovement>;
  let reservations: Model<InventoryReservation>;
  let audits: Model<AuditLog>;
  let ownerBrowser: ReturnType<typeof request.agent>;
  let ownerCsrf: string;
  let returnService: ReturnRequestService;

  async function cleanFixtures(): Promise<void> {
    const order = await orders.findOne({ orderNumber }).select('_id');
    const product = await products.findOne({ slug: productSlug }).select('_id');
    const customer = await customers.findOne({ email: customerEmail }).select('_id');
    const admin = await admins.findOne({ email: ownerEmail }).select('_id');
    const returnDocuments = order ? await returns.find({ orderId: order._id }).select('_id') : [];
    const returnIds = returnDocuments.map((document) => document._id);
    const evidenceDocuments = await evidence.find({ returnRequestId: { $in: returnIds } }).exec();
    for (const item of evidenceDocuments) {
      await rm(resolve('/tmp/rich-culture-test-media', item.storageKey), { force: true });
    }
    await evidence.deleteMany({ returnRequestId: { $in: returnIds } });
    const events = await outbox.find({ aggregateId: { $in: returnIds } }).select('_id');
    await notifications.deleteMany({ outboxEventId: { $in: events.map((event) => event._id) } });
    await outbox.deleteMany({ aggregateId: { $in: returnIds } });
    await movements.deleteMany({
      referenceId: { $in: returnDocuments.map((document) => document._id.toHexString()) },
    });
    await reservations.deleteMany({ returnRequestId: { $in: returnIds } });
    if (order) await returns.deleteMany({ orderId: order._id });
    if (order) await orders.deleteOne({ _id: order._id });
    if (product) await inventory.deleteMany({ productId: product._id });
    if (product) await products.deleteOne({ _id: product._id });
    if (customer) await customerSessions.deleteMany({ customerId: customer._id });
    if (customer) await customers.deleteOne({ _id: customer._id });
    if (admin) await adminSessions.deleteMany({ adminUserId: admin._id });
    if (admin) await admins.deleteOne({ _id: admin._id });
    await audits.deleteMany({
      occurredAt: { $gte: startedAt },
      action: /^RETURN_(?:REQUEST|EVIDENCE)_/,
    });
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
    customerSessions = app.get(getModelToken(CustomerSession.name));
    admins = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    products = app.get(getModelToken(Product.name));
    orders = app.get(getModelToken(Order.name));
    returns = app.get(getModelToken(ReturnRequest.name));
    evidence = app.get(getModelToken(ReturnEvidence.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    notifications = app.get(getModelToken(Notification.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    movements = app.get(getModelToken(InventoryMovement.name));
    reservations = app.get(getModelToken(InventoryReservation.name));
    audits = app.get(getModelToken(AuditLog.name));
    returnService = app.get(ReturnRequestService);
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    const passwordHash = await app.get(PasswordService).hash(ownerPassword);
    await admins.create({
      name: 'Phase 13 Owner',
      email: ownerEmail,
      passwordHash,
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    ownerBrowser = request.agent(httpServer);
    ownerCsrf = (
      (await ownerBrowser.get('/api/v1/admin/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await ownerBrowser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', ownerCsrf)
      .send({ email: ownerEmail, password: ownerPassword })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('guards quantities and completes an inspected exchange without double-restocking', async () => {
    const customerBrowser = request.agent(httpServer);
    const customerCsrf = (
      (await customerBrowser.get('/api/v1/customer/auth/csrf').expect(200)).body as {
        csrfToken: string;
      }
    ).csrfToken;
    await customerBrowser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', customerCsrf)
      .send({
        name: 'Phase 13 Customer',
        email: customerEmail,
        password: customerPassword,
      })
      .expect(201);
    const customer = await customers.findOne({ email: customerEmail }).orFail();
    const productId = new Types.ObjectId();
    await products.create({
      _id: productId,
      name: 'Phase 13 Return Product',
      slug: productSlug,
      description: 'A product fixture with two exchangeable variants.',
      status: ProductStatus.Active,
      publishedAt: new Date(),
      variants: [
        {
          variantId: originalVariantId,
          sku: 'PHASE13-M',
          title: 'Medium',
          attributes: [{ name: 'size', value: 'M' }],
          priceInPaise: 120_000,
          isActive: true,
          sortOrder: 0,
        },
        {
          variantId: exchangeVariantId,
          sku: 'PHASE13-L',
          title: 'Large',
          attributes: [{ name: 'size', value: 'L' }],
          priceInPaise: 120_000,
          isActive: true,
          sortOrder: 1,
        },
      ],
    });
    await inventory.create([
      {
        productId,
        variantId: originalVariantId,
        sku: 'PHASE13-M',
        onHand: 8,
        reserved: 0,
        sold: 2,
      },
      {
        productId,
        variantId: exchangeVariantId,
        sku: 'PHASE13-L',
        onHand: 5,
        reserved: 0,
        sold: 0,
      },
    ]);
    const deliveredAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await orders.create({
      orderNumber,
      idempotencyKey: 'phase13-order-idempotency-0001',
      idempotencyRequestHash: 'd'.repeat(64),
      sourceCartId: new Types.ObjectId(),
      customerId: customer._id,
      customer: { name: customer.name, email: customer.email },
      shippingAddress: {
        fullName: 'Phase 13 Customer',
        phone: '+919876543210',
        line1: '13 Return Street',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        countryCode: 'IN',
      },
      items: [
        {
          productId,
          variantId: originalVariantId,
          productName: 'Phase 13 Return Product',
          productSlug,
          sku: 'PHASE13-M',
          variantTitle: 'Medium',
          attributes: [{ name: 'size', value: 'M' }],
          unitPriceInPaise: 120_000,
          discountInPaise: 0,
          taxInPaise: 0,
          quantity: 2,
          lineTotalInPaise: 240_000,
        },
      ],
      totals: {
        subtotalInPaise: 240_000,
        itemDiscountInPaise: 0,
        couponDiscountInPaise: 0,
        shippingInPaise: 0,
        taxInPaise: 0,
        grandTotalInPaise: 240_000,
      },
      currency: 'INR',
      lifecycleStatus: OrderLifecycleStatus.Completed,
      financialStatus: FinancialStatus.Paid,
      fulfillmentStatus: FulfillmentStatus.Delivered,
      paymentExpiresAt: new Date(Date.now() - 60_000),
      shipping: {
        provider: ShippingProvider.Manual,
        status: ShipmentStatus.Delivered,
        courierName: 'Fixture Courier',
        trackingNumber: 'PHASE13-INBOUND',
        trackingEvents: [
          {
            status: ShipmentStatus.Delivered,
            message: 'Fixture shipment delivered',
            actorType: AuditActorType.System,
            occurredAt: deliveredAt,
          },
        ],
        lastEventAt: deliveredAt,
        shippedAt: new Date(deliveredAt.getTime() - 24 * 60 * 60 * 1000),
        deliveredAt,
      },
      statusHistory: [],
    });

    const baseUrl = `/api/v1/customer/orders/${orderNumber}/returns`;
    await request(httpServer).get(baseUrl).expect(401);
    await customerBrowser
      .get(baseUrl)
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          eligibility: {
            eligible: true,
            windowDays: 7,
            items: [
              {
                variantId: originalVariantId.toHexString(),
                availableQuantity: 2,
                exchangeOptions: [
                  {
                    variantId: exchangeVariantId.toHexString(),
                    currentlyAvailable: true,
                  },
                ],
              },
            ],
          },
          requests: [],
        });
      });

    const exchangeInput = {
      type: ReturnRequestType.Exchange,
      items: [
        {
          variantId: originalVariantId.toHexString(),
          quantity: 1,
          reason: ReturnReason.SizeIssue,
          reasonDetail: 'The delivered fit is smaller than expected.',
          requestedExchangeVariantId: exchangeVariantId.toHexString(),
        },
      ],
    };
    const createdResponse = await customerBrowser
      .post(baseUrl)
      .set('x-csrf-token', customerCsrf)
      .set('idempotency-key', 'phase13-exchange-request-0001')
      .send(exchangeInput)
      .expect(201);
    const created = createdResponse.body as ReturnBody;
    expect(created).toMatchObject({ status: ReturnRequestStatus.Requested, version: 0 });

    const adminBase = `/api/v1/admin/returns/${created.returnNumber}`;
    const evidenceUrl = `${baseUrl}/${created.returnNumber}/evidence`;
    const evidenceImage = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#6b3f2d' },
    })
      .png()
      .toBuffer();
    await request(httpServer).get(evidenceUrl).expect(401);
    const firstEvidenceResponse = await customerBrowser
      .post(evidenceUrl)
      .set('x-csrf-token', customerCsrf)
      .attach('file', evidenceImage, 'damaged-piece.png')
      .expect(201);
    const firstEvidence = (firstEvidenceResponse.body as { evidence: EvidenceBody }).evidence;
    expect(firstEvidence).toMatchObject({
      originalFilename: 'damaged-piece.png',
      mimeType: 'image/webp',
    });
    await customerBrowser
      .post(evidenceUrl)
      .set('x-csrf-token', customerCsrf)
      .attach('file', evidenceImage, 'duplicate.png')
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'RETURN_EVIDENCE_DUPLICATE' });
      });
    await customerBrowser
      .get(firstEvidence.contentUrl)
      .expect(200)
      .expect('Content-Type', /image\/webp/)
      .expect('Cache-Control', 'private, no-store');
    await customerBrowser
      .delete(`${evidenceUrl}/${firstEvidence.id}`)
      .set('x-csrf-token', customerCsrf)
      .expect(204);

    const replacementEvidenceResponse = await customerBrowser
      .post(evidenceUrl)
      .set('x-csrf-token', customerCsrf)
      .attach('file', evidenceImage, 'wrong-size.png')
      .expect(201);
    const replacementEvidence = (replacementEvidenceResponse.body as { evidence: EvidenceBody })
      .evidence;
    await customerBrowser
      .get(evidenceUrl)
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          evidence: [{ id: replacementEvidence.id, originalFilename: 'wrong-size.png' }],
        });
      });
    await ownerBrowser
      .get(`${adminBase}/evidence`)
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ evidence: [{ id: replacementEvidence.id }] });
      });
    await ownerBrowser
      .get(`${adminBase}/evidence/${replacementEvidence.id}/content`)
      .expect(200)
      .expect('Content-Type', /image\/webp/)
      .expect('Cache-Control', 'private, no-store');

    const requestAfterEvidence = await returns.findById(created.id).orFail();
    expect(requestAfterEvidence.evidenceCount).toBe(1);

    await customerBrowser
      .post(baseUrl)
      .set('x-csrf-token', customerCsrf)
      .set('idempotency-key', 'phase13-exchange-request-0001')
      .send(exchangeInput)
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect((body as ReturnBody).id).toBe(created.id);
      });
    await customerBrowser
      .post(baseUrl)
      .set('x-csrf-token', customerCsrf)
      .set('idempotency-key', 'phase13-over-quantity-0001')
      .send({
        type: ReturnRequestType.Return,
        items: [
          {
            variantId: originalVariantId.toHexString(),
            quantity: 2,
            reason: ReturnReason.ChangedMind,
          },
        ],
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'RETURN_QUANTITY_UNAVAILABLE' });
      });

    const approvedResponse = await ownerBrowser
      .patch(`${adminBase}/decision`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: requestAfterEvidence.get('version') as number,
        status: ReturnRequestStatus.Approved,
        customerMessage: 'Approved. Send the piece back in its original condition.',
      })
      .expect(200);
    const approved = approvedResponse.body as ReturnBody;
    expect(approved).toMatchObject({
      status: ReturnRequestStatus.Approved,
      version: (requestAfterEvidence.get('version') as number) + 1,
      exchangeReservation: { status: ExchangeReservationStatus.Active },
    });
    expect(await inventory.findOne({ variantId: exchangeVariantId }).lean()).toMatchObject({
      onHand: 5,
      reserved: 1,
      sold: 0,
    });
    expect(
      await reservations.countDocuments({
        returnRequestId: new Types.ObjectId(created.id),
        status: InventoryReservationStatus.Active,
      }),
    ).toBe(1);
    await customerBrowser
      .delete(`${evidenceUrl}/${replacementEvidence.id}`)
      .set('x-csrf-token', customerCsrf)
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'RETURN_EVIDENCE_LOCKED' });
      });

    const receivedResponse = await ownerBrowser
      .patch(`${adminBase}/receive`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: approved.version,
        items: [{ variantId: originalVariantId.toHexString(), restockQuantity: 1 }],
        customerMessage: 'Your returned piece passed inspection.',
      })
      .expect(200);
    const received = receivedResponse.body as ReturnBody;
    expect(received).toMatchObject({
      status: ReturnRequestStatus.Received,
      version: approved.version + 1,
      items: [{ restockedQuantity: 1 }],
    });
    expect(await inventory.findOne({ variantId: originalVariantId }).lean()).toMatchObject({
      onHand: 9,
      reserved: 0,
      sold: 1,
    });
    expect(
      await movements.countDocuments({
        referenceType: 'RETURN_REQUEST_RECEIPT',
        referenceId: created.id,
      }),
    ).toBe(1);

    const liveOrder = await orders.findOne({ orderNumber }).orFail();
    await ownerBrowser
      .patch(`/api/v1/admin/orders/${orderNumber}/fulfillment`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: liveOrder.get('version') as number,
        status: FulfillmentStatus.Returned,
        reason: 'Unsafe whole-order restock must be blocked',
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'ORDER_HAS_ITEM_RETURN_REQUESTS' });
      });

    const completedResponse = await ownerBrowser
      .patch(`${adminBase}/complete`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: received.version,
        resolutionType: 'EXCHANGE',
        courierName: 'Blue Dart',
        trackingNumber: 'BD-PHASE13-REPLACEMENT',
        trackingUrl: 'https://example.test/track/BD-PHASE13-REPLACEMENT',
        customerMessage: 'Your replacement is on the way.',
      })
      .expect(200);
    const completed = completedResponse.body as ReturnBody;
    expect(completed).toMatchObject({
      status: ReturnRequestStatus.Completed,
      resolution: { type: 'EXCHANGE', trackingNumber: 'BD-PHASE13-REPLACEMENT' },
      exchangeReservation: { status: ExchangeReservationStatus.Committed },
    });
    expect(await inventory.findOne({ variantId: exchangeVariantId }).lean()).toMatchObject({
      onHand: 4,
      reserved: 0,
      sold: 1,
    });
    expect(
      await movements.countDocuments({
        referenceId: created.id,
        referenceType: {
          $in: ['EXCHANGE_REPLACEMENT_RESERVE', 'EXCHANGE_REPLACEMENT_COMMIT'],
        },
      }),
    ).toBe(2);
    await ownerBrowser
      .patch(`${adminBase}/complete`)
      .set('x-csrf-token', ownerCsrf)
      .send({
        expectedVersion: completed.version,
        resolutionType: 'EXCHANGE',
        courierName: 'Blue Dart',
        trackingNumber: 'BD-DUPLICATE',
      })
      .expect(409);
    expect(await inventory.findOne({ variantId: exchangeVariantId }).lean()).toMatchObject({
      onHand: 4,
      reserved: 0,
      sold: 1,
    });

    const expiringResponse = await customerBrowser
      .post(baseUrl)
      .set('x-csrf-token', customerCsrf)
      .set('idempotency-key', 'phase15-expiring-exchange-0001')
      .send({
        type: ReturnRequestType.Exchange,
        items: [
          {
            variantId: originalVariantId.toHexString(),
            quantity: 1,
            reason: ReturnReason.SizeIssue,
            requestedExchangeVariantId: exchangeVariantId.toHexString(),
          },
        ],
      })
      .expect(201);
    const expiring = expiringResponse.body as ReturnBody;
    await inventory.updateOne({ variantId: exchangeVariantId }, { $set: { reserved: 4 } });
    await ownerBrowser
      .patch(`/api/v1/admin/returns/${expiring.returnNumber}/decision`)
      .set('x-csrf-token', ownerCsrf)
      .send({ expectedVersion: expiring.version, status: ReturnRequestStatus.Approved })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'EXCHANGE_TARGET_OUT_OF_STOCK' });
      });
    await inventory.updateOne({ variantId: exchangeVariantId }, { $set: { reserved: 0 } });
    const expiringApprovedResponse = await ownerBrowser
      .patch(`/api/v1/admin/returns/${expiring.returnNumber}/decision`)
      .set('x-csrf-token', ownerCsrf)
      .send({ expectedVersion: expiring.version, status: ReturnRequestStatus.Approved })
      .expect(200);
    expect(expiringApprovedResponse.body).toMatchObject({
      exchangeReservation: { status: ExchangeReservationStatus.Active },
    });
    await returns.collection.updateOne(
      { _id: new Types.ObjectId(expiring.id) },
      { $set: { exchangeReservationExpiresAt: new Date(Date.now() - 1_000) } },
    );
    await expect(returnService.expireExchangeReservations()).resolves.toBe(1);
    await expect(returns.findById(expiring.id)).resolves.toMatchObject({
      status: ReturnRequestStatus.Expired,
      exchangeReservationStatus: ExchangeReservationStatus.Expired,
    });
    expect(await inventory.findOne({ variantId: exchangeVariantId }).lean()).toMatchObject({
      onHand: 4,
      reserved: 0,
      sold: 1,
    });
    expect(
      await movements.countDocuments({
        referenceId: expiring.id,
        referenceType: 'EXCHANGE_REPLACEMENT_EXPIRE',
      }),
    ).toBe(1);

    const cancellableResponse = await customerBrowser
      .post(baseUrl)
      .set('x-csrf-token', customerCsrf)
      .set('idempotency-key', 'phase13-cancellable-return-0001')
      .send({
        type: ReturnRequestType.Return,
        items: [
          {
            variantId: originalVariantId.toHexString(),
            quantity: 1,
            reason: ReturnReason.Other,
            reasonDetail: 'Need to cancel this pending request during the test.',
          },
        ],
      })
      .expect(201);
    const cancellable = cancellableResponse.body as ReturnBody;
    await customerBrowser
      .post(`${baseUrl}/${cancellable.returnNumber}/cancel`)
      .set('x-csrf-token', customerCsrf)
      .send({ expectedVersion: cancellable.version })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ status: ReturnRequestStatus.Cancelled });
      });

    await customerBrowser
      .post(baseUrl)
      .set('x-csrf-token', customerCsrf)
      .set('idempotency-key', 'phase13-reallocated-return-0001')
      .send({
        type: ReturnRequestType.Return,
        items: [
          {
            variantId: originalVariantId.toHexString(),
            quantity: 1,
            reason: ReturnReason.QualityIssue,
          },
        ],
      })
      .expect(201);

    await customerBrowser
      .get(baseUrl)
      .expect(200)
      .expect(({ body }: request.Response) => {
        const result = body as {
          eligibility: { eligible: boolean; items: Array<{ availableQuantity: number }> };
          requests: ReturnBody[];
        };
        expect(result.eligibility).toMatchObject({
          eligible: false,
          items: [{ availableQuantity: 0 }],
        });
        expect(result.requests).toHaveLength(4);
      });

    const returnIndexes = (await returns.collection.indexes()).map((index) => index.name);
    expect(returnIndexes).toEqual(
      expect.arrayContaining([
        'uq_return_requests_number',
        'uq_return_requests_customer_idempotency',
        'ix_return_requests_admin_queue',
        'ix_return_requests_exchange_reservation_expiry',
      ]),
    );
    const reservationIndexes = (await reservations.collection.indexes()).map((index) => index.name);
    expect(reservationIndexes).toEqual(
      expect.arrayContaining([
        'uq_inventory_reservations_return_variant',
        'ix_inventory_reservations_return_status',
      ]),
    );
    const evidenceIndexes = (await evidence.collection.indexes()).map((index) => index.name);
    expect(evidenceIndexes).toEqual(
      expect.arrayContaining([
        'uq_return_evidence_storage_key',
        'uq_return_evidence_request_checksum',
        'ix_return_evidence_maintenance',
      ]),
    );
    await expect(
      evidence.collection.insertOne({
        returnRequestId: new Types.ObjectId(created.id),
        orderId: liveOrder._id,
        customerId: customer._id,
        storageProvider: 'LOCAL',
        storageKey: 'public/not-private.webp',
        originalFilename: 'unsafe.png',
        mimeType: 'image/webp',
        sizeBytes: 1,
        width: 1,
        height: 1,
        checksumSha256: 'a'.repeat(64),
        status: 'READY',
      }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      returns.collection.updateOne(
        { _id: new Types.ObjectId(created.id) },
        { $set: { evidenceCount: 1.5 } },
      ),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      returns.collection.updateOne(
        { _id: new Types.ObjectId(created.id) },
        {
          $set: {
            exchangeReservationStatus: ExchangeReservationStatus.Active,
            exchangeReservationExpiresAt: new Date(Date.now() + 60_000),
          },
          $unset: { exchangeReservationFinalizedAt: 1 },
        },
      ),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      reservations.collection.insertOne({
        reservationGroupId: `exchange:${created.id}`,
        orderId: liveOrder._id,
        returnRequestId: new Types.ObjectId(created.id),
        productId: productId,
        variantId: new Types.ObjectId(),
        quantity: 1,
        status: InventoryReservationStatus.Active,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: 121 });
  }, 60_000);
});
