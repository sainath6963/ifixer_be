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
import { Order } from '../src/database/schemas/order.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { ProductReview, ProductReviewSummary } from '../src/database/schemas/product-review.schema';
import {
  AccountStatus,
  AdminRole,
  AuditActorType,
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  ProductReviewStatus,
  ProductStatus,
  ShipmentStatus,
  ShippingProvider,
} from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';

interface ReviewBody {
  id: string;
  productId: string;
  orderNumber: string;
  rating: number;
  status: ProductReviewStatus;
  rejectionReason?: string;
  version: number;
}

describe('Verified product reviews (e2e)', () => {
  const customerEmail = 'phase17-customer@richculture.test';
  const customerPassword = 'Phase17-customer-password';
  const ownerEmail = 'phase17-owner@richculture.test';
  const ownerPassword = 'Phase17-owner-password';
  const productSlug = 'phase17-review-product';
  const orderNumber = 'RC-20260810-R3V1EW1701';
  const startedAt = new Date();
  const productId = new Types.ObjectId();
  const variantId = new Types.ObjectId();

  let app: INestApplication;
  let httpServer: Server;
  let products: Model<Product>;
  let orders: Model<Order>;
  let customers: Model<Customer>;
  let customerSessions: Model<CustomerSession>;
  let admins: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let reviews: Model<ProductReview>;
  let summaries: Model<ProductReviewSummary>;
  let audits: Model<AuditLog>;

  async function cleanup(): Promise<void> {
    const customer = await customers.findOne({ email: customerEmail }).select('_id');
    const admin = await admins.findOne({ email: ownerEmail }).select('_id');
    await reviews.deleteMany({ productId });
    await summaries.deleteMany({ productId });
    await orders.deleteMany({ orderNumber });
    await products.deleteMany({ _id: productId });
    if (customer) {
      await customerSessions.deleteMany({ customerId: customer._id });
      await customers.deleteOne({ _id: customer._id });
    }
    if (admin) {
      await adminSessions.deleteMany({ adminUserId: admin._id });
      await admins.deleteOne({ _id: admin._id });
    }
    await audits.deleteMany({
      resourceType: 'PRODUCT_REVIEW',
      occurredAt: { $gte: startedAt },
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
    products = app.get(getModelToken(Product.name));
    orders = app.get(getModelToken(Order.name));
    customers = app.get(getModelToken(Customer.name));
    customerSessions = app.get(getModelToken(CustomerSession.name));
    admins = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    reviews = app.get(getModelToken(ProductReview.name));
    summaries = app.get(getModelToken(ProductReviewSummary.name));
    audits = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();
    await cleanup();
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanup();
    await app.close();
  });

  it('submits, moderates, revises, republishes, and withdraws one verified review', async () => {
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
      name: 'Phase 17 Review Product',
      slug: productSlug,
      description: 'A published product used to verify the review moderation lifecycle.',
      status: ProductStatus.Active,
      publishedAt: new Date(),
      variants: [
        {
          variantId,
          sku: 'PHASE17-REVIEW-M',
          title: 'Medium',
          attributes: [{ name: 'size', value: 'M' }],
          priceInPaise: 149_900,
          isActive: true,
        },
      ],
    });
    const deliveredAt = new Date(Date.now() - 86_400_000);
    await orders.create({
      orderNumber,
      idempotencyKey: 'phase17-review-order-idempotency',
      idempotencyRequestHash: '7'.repeat(64),
      sourceCartId: new Types.ObjectId(),
      customerId: customer._id,
      customer: { name: customer.name, email: customer.email },
      shippingAddress: {
        fullName: 'Asha Kulkarni',
        phone: '+919876543210',
        line1: '17 Review Lane',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        countryCode: 'IN',
      },
      items: [
        {
          productId,
          variantId,
          productName: 'Phase 17 Review Product',
          productSlug,
          sku: 'PHASE17-REVIEW-M',
          variantTitle: 'Medium',
          attributes: [{ name: 'size', value: 'M' }],
          unitPriceInPaise: 149_900,
          discountInPaise: 0,
          taxInPaise: 0,
          quantity: 1,
          lineTotalInPaise: 149_900,
        },
      ],
      totals: {
        subtotalInPaise: 149_900,
        itemDiscountInPaise: 0,
        couponDiscountInPaise: 0,
        shippingInPaise: 0,
        taxInPaise: 0,
        grandTotalInPaise: 149_900,
      },
      currency: 'INR',
      lifecycleStatus: OrderLifecycleStatus.Completed,
      financialStatus: FinancialStatus.Paid,
      fulfillmentStatus: FulfillmentStatus.Delivered,
      paymentExpiresAt: new Date(Date.now() - 60_000),
      shipping: {
        provider: ShippingProvider.Manual,
        status: ShipmentStatus.Delivered,
        courierName: 'Phase 17 Courier',
        trackingNumber: 'PHASE17REVIEWTRACKING',
        trackingEvents: [
          {
            status: ShipmentStatus.Delivered,
            message: 'Fixture shipment delivered',
            actorType: AuditActorType.System,
            occurredAt: deliveredAt,
          },
        ],
        lastEventAt: deliveredAt,
        shippedAt: new Date(deliveredAt.getTime() - 86_400_000),
        deliveredAt,
      },
    });

    await customerBrowser
      .get(`/api/v1/customer/reviews/product/${productId.toHexString()}`)
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ eligible: true, deliveredOrderNumber: orderNumber });
      });
    const reviewInput = {
      productId: productId.toHexString(),
      rating: 5,
      title: 'Beautiful finish',
      body: 'The fabric, cut and finishing all feel exceptionally considered.',
    };
    await customerBrowser.post('/api/v1/customer/reviews').send(reviewInput).expect(403);
    const createdResponse = await customerBrowser
      .post('/api/v1/customer/reviews')
      .set('x-csrf-token', customerCsrf)
      .send(reviewInput)
      .expect(201);
    const created = createdResponse.body as ReviewBody;
    expect(created).toMatchObject({
      productId: productId.toHexString(),
      orderNumber,
      rating: 5,
      status: ProductReviewStatus.Pending,
      version: 0,
    });
    await customerBrowser
      .post('/api/v1/customer/reviews')
      .set('x-csrf-token', customerCsrf)
      .send(reviewInput)
      .expect(409);
    await request(httpServer)
      .get(`/api/v1/catalog/products/${productId.toHexString()}/reviews`)
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ total: 0, summary: { reviewCount: 0, averageRating: 0 } });
      });

    const passwordHash = await app.get(PasswordService).hash(ownerPassword);
    await admins.create({
      name: 'Phase 17 Owner',
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
      .get('/api/v1/admin/reviews?status=PENDING&search=Beautiful')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ total: 1, items: [{ id: created.id }] });
      });
    const publishedResponse = await adminBrowser
      .patch(`/api/v1/admin/reviews/${created.id}/moderation`)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 0, status: ProductReviewStatus.Published })
      .expect(200);
    expect(publishedResponse.body).toMatchObject({
      status: ProductReviewStatus.Published,
      version: 1,
    });
    await request(httpServer)
      .get(`/api/v1/catalog/products/${productId.toHexString()}/reviews`)
      .expect(200)
      .expect(({ body }: request.Response) => {
        const reviewPage = body as { items: Array<Record<string, unknown>> };
        expect(reviewPage).toMatchObject({
          total: 1,
          summary: { reviewCount: 1, averageRating: 5 },
          items: [{ displayName: 'Asha K.', verifiedPurchase: true }],
        });
        expect(reviewPage.items[0]).not.toHaveProperty('customerId');
        expect(reviewPage.items[0]).not.toHaveProperty('orderNumber');
      });

    const revisedResponse = await customerBrowser
      .patch(`/api/v1/customer/reviews/${created.id}`)
      .set('x-csrf-token', customerCsrf)
      .send({
        expectedVersion: 1,
        rating: 4,
        title: 'Beautiful, with one small caveat',
        body: 'The finish is excellent, though the fit runs slightly relaxed.',
      })
      .expect(200);
    expect(revisedResponse.body).toMatchObject({ status: ProductReviewStatus.Pending, version: 2 });
    expect(await summaries.findOne({ productId }).lean()).toMatchObject({
      reviewCount: 0,
      ratingTotal: 0,
    });
    await adminBrowser
      .patch(`/api/v1/admin/reviews/${created.id}/moderation`)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 2, status: ProductReviewStatus.Rejected })
      .expect(400);
    const rejectedResponse = await adminBrowser
      .patch(`/api/v1/admin/reviews/${created.id}/moderation`)
      .set('x-csrf-token', adminCsrf)
      .send({
        expectedVersion: 2,
        status: ProductReviewStatus.Rejected,
        rejectionReason: 'Please remove delivery feedback and focus on the product.',
      })
      .expect(200);
    expect(rejectedResponse.body).toMatchObject({
      status: ProductReviewStatus.Rejected,
      version: 3,
    });
    const resubmittedResponse = await customerBrowser
      .patch(`/api/v1/customer/reviews/${created.id}`)
      .set('x-csrf-token', customerCsrf)
      .send({
        expectedVersion: 3,
        rating: 4,
        title: 'Beautiful relaxed fit',
        body: 'The fabric and finish are excellent, with a comfortable relaxed cut.',
      })
      .expect(200);
    expect(resubmittedResponse.body).toMatchObject({
      status: ProductReviewStatus.Pending,
      version: 4,
    });
    await adminBrowser
      .patch(`/api/v1/admin/reviews/${created.id}/moderation`)
      .set('x-csrf-token', adminCsrf)
      .send({ expectedVersion: 4, status: ProductReviewStatus.Published })
      .expect(200);
    const withdrawnResponse = await customerBrowser
      .post(`/api/v1/customer/reviews/${created.id}/withdraw`)
      .set('x-csrf-token', customerCsrf)
      .send({ expectedVersion: 5 })
      .expect(201);
    expect(withdrawnResponse.body).toMatchObject({
      status: ProductReviewStatus.Withdrawn,
      version: 6,
    });
    expect(await summaries.findOne({ productId }).lean()).toMatchObject({
      reviewCount: 0,
      ratingTotal: 0,
    });
    expect(
      await audits.distinct('action', {
        resourceType: 'PRODUCT_REVIEW',
        occurredAt: { $gte: startedAt },
      }),
    ).toEqual(
      expect.arrayContaining([
        'PRODUCT_REVIEW_SUBMITTED',
        'PRODUCT_REVIEW_UPDATED',
        'PRODUCT_REVIEW_PUBLISHED',
        'PRODUCT_REVIEW_REJECTED',
        'PRODUCT_REVIEW_WITHDRAWN',
      ]),
    );
  }, 60_000);
});
