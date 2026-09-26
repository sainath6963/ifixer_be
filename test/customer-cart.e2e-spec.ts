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
import { InventoryLevel } from '../src/database/schemas/inventory.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { AccountStatus, ProductStatus } from '../src/domain/enums';
import {
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_CART_COOKIE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
} from '../src/modules/customer/customer.constants';

interface CsrfBody {
  csrfToken: string;
  expiresInSeconds: number;
}

interface CartBody {
  cart: {
    id?: string;
    version: number;
    items: Array<{
      productId: string;
      variantId: string;
      quantity: number;
      availability: string;
      unitPriceInPaise?: number;
      lineTotalInPaise?: number;
    }>;
    distinctItemCount: number;
    totalQuantity: number;
    subtotalInPaise: number;
    readyForCheckout: boolean;
  };
}

function responseCookie(response: request.Response, name: string): string {
  const headers = response.headers as Record<string, string | string[] | undefined>;
  const setCookies = headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie`);
  return cookie.split(';', 1)[0];
}

function fullResponseCookie(response: request.Response, name: string): string {
  const headers = response.headers as Record<string, string | string[] | undefined>;
  const setCookies = headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie`);
  return cookie;
}

describe('Customer authentication and persistent cart (e2e)', () => {
  const email = 'phase6-customer@richculture.test';
  const originalPassword = 'Phase6-original-password';
  const changedPassword = 'Phase6-changed-password';
  const productSlug = 'phase6-e2e-shopping-product';
  const sku = 'PHASE6-E2E-SHOPPING';
  const startedAt = new Date();
  let app: INestApplication;
  let httpServer: Server;
  let customers: Model<Customer>;
  let customerSessions: Model<CustomerSession>;
  let carts: Model<Cart>;
  let products: Model<Product>;
  let inventory: Model<InventoryLevel>;
  let auditLogs: Model<AuditLog>;
  let productId: Types.ObjectId;
  let variantId: Types.ObjectId;

  const cleanFixtures = async (): Promise<void> => {
    const customerDocuments = await customers.find({ email }).select('_id');
    const customerIds = customerDocuments.map((customer) => customer._id);
    const productDocuments = await products.find({ slug: productSlug }).select('_id');
    const productIds = productDocuments.map((product) => product._id);
    await carts.deleteMany({
      $or: [{ customerId: { $in: customerIds } }, { 'items.productId': { $in: productIds } }],
    });
    await customerSessions.deleteMany({ customerId: { $in: customerIds } });
    await customers.deleteMany({ _id: { $in: customerIds } });
    await inventory.deleteMany({ productId: { $in: productIds } });
    await products.deleteMany({ _id: { $in: productIds } });
    await auditLogs.deleteMany({
      action: { $in: [/^CUSTOMER_/, /^CART_/] },
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
    customers = app.get(getModelToken(Customer.name));
    customerSessions = app.get(getModelToken(CustomerSession.name));
    carts = app.get(getModelToken(Cart.name));
    products = app.get(getModelToken(Product.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    variantId = new Types.ObjectId();
    const product = await products.create({
      name: 'Phase 6 Shopping Product',
      slug: productSlug,
      description: 'Product used to verify guest and customer cart behavior.',
      categoryIds: [],
      variants: [
        {
          variantId,
          sku,
          title: 'Default',
          attributes: [{ name: 'style', value: 'Default' }],
          priceInPaise: 159900,
          isActive: true,
          sortOrder: 0,
        },
      ],
      images: [],
      tags: ['phase6'],
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

  it('creates the expected customer-session and cart indexes', async () => {
    const sessionIndexes = (await customerSessions.collection.indexes()).map((index) => index.name);
    const cartIndexes = (await carts.collection.indexes()).map((index) => index.name);
    expect(sessionIndexes).toEqual(
      expect.arrayContaining([
        'uq_customer_sessions_token_hash',
        'ix_customer_sessions_customer_revoked',
        'ttl_customer_sessions_expiry',
      ]),
    );
    expect(cartIndexes).toEqual(
      expect.arrayContaining([
        'uq_carts_active_customer',
        'uq_carts_guest_token_hash',
        'ttl_carts_expiry',
      ]),
    );
  });

  it('protects customer login and cart mutations with customer-scoped CSRF', async () => {
    await request(httpServer)
      .post('/api/v1/customer/auth/login')
      .send({ email: 'missing@richculture.test', password: originalPassword })
      .expect(403)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_CSRF_TOKEN_INVALID' });
      });

    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    const csrf = (csrfResponse.body as CsrfBody).csrfToken;
    await browser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email: 'missing@richculture.test', password: originalPassword })
      .expect(401)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          code: 'CUSTOMER_CREDENTIALS_INVALID',
          message: 'Invalid email or password',
        });
      });
    await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .send({ productId: productId.toHexString(), quantity: 1, expectedVersion: 0 })
      .expect(403);
  });

  it('persists a safe guest cart, merges it on registration, and secures session rotation', async () => {
    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    let csrf = (csrfResponse.body as CsrfBody).csrfToken;
    const csrfCookie = responseCookie(csrfResponse, CUSTOMER_CSRF_COOKIE);

    await browser
      .get('/api/v1/cart')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          cart: { version: 0, items: [], subtotalInPaise: 0, readyForCheckout: false },
        });
      });

    const firstSet = await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrf)
      .send({ productId: productId.toHexString(), quantity: 1, expectedVersion: 0 })
      .expect(200);
    const firstCart = (firstSet.body as CartBody).cart;
    expect(firstCart).toMatchObject({
      version: 1,
      distinctItemCount: 1,
      totalQuantity: 1,
      subtotalInPaise: 159900,
      readyForCheckout: true,
      items: [
        {
          productId: productId.toHexString(),
          variantId: variantId.toHexString(),
          quantity: 1,
          availability: 'AVAILABLE',
          unitPriceInPaise: 159900,
          lineTotalInPaise: 159900,
        },
      ],
    });
    const guestSetCookie = fullResponseCookie(firstSet, CUSTOMER_CART_COOKIE);
    expect(guestSetCookie).toContain('HttpOnly');
    expect(guestSetCookie).toContain('Path=/api/v1');
    const rawGuestToken = responseCookie(firstSet, CUSTOMER_CART_COOKIE).split('=', 2)[1];
    const guestDocument = await carts
      .findOne({ 'items.productId': productId })
      .select('+guestTokenHash')
      .orFail();
    expect(guestDocument.guestTokenHash).toHaveLength(64);
    expect(guestDocument.guestTokenHash).not.toBe(rawGuestToken);
    const serializedCart = JSON.stringify(firstSet.body);
    for (const privateField of ['onHand', 'reserved', 'sold', 'guestTokenHash', 'storageKey']) {
      expect(serializedCart).not.toContain(privateField);
    }

    await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrf)
      .send({ productId: productId.toHexString(), quantity: 6, expectedVersion: 1 })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'CART_INSUFFICIENT_STOCK' });
      });
    await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrf)
      .send({ productId: productId.toHexString(), quantity: 2, expectedVersion: 0 })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'CART_VERSION_CONFLICT' });
      });
    const secondSet = await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrf)
      .send({ productId: productId.toHexString(), quantity: 2, expectedVersion: 1 })
      .expect(200);
    expect((secondSet.body as CartBody).cart).toMatchObject({
      version: 2,
      totalQuantity: 2,
      subtotalInPaise: 319800,
    });

    const registerResponse = await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrf)
      .send({ name: 'Phase 6 Customer', email, password: originalPassword })
      .expect(201);
    expect(registerResponse.body).toMatchObject({ customer: { name: 'Phase 6 Customer', email } });
    const accessSetCookie = fullResponseCookie(registerResponse, CUSTOMER_ACCESS_COOKIE);
    const refreshSetCookie = fullResponseCookie(registerResponse, CUSTOMER_REFRESH_COOKIE);
    expect(accessSetCookie).toContain('HttpOnly');
    expect(accessSetCookie).toContain('Path=/api/v1');
    expect(refreshSetCookie).toContain('HttpOnly');
    expect(refreshSetCookie).toContain('Path=/api/v1/customer/auth');
    expect(fullResponseCookie(registerResponse, CUSTOMER_CART_COOKIE)).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    const oldRefreshCookie = responseCookie(registerResponse, CUSTOMER_REFRESH_COOKIE);
    const customer = await customers.findOne({ email }).select('+passwordHash').orFail();
    expect(customer.status).toBe(AccountStatus.Active);
    expect(customer.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(await carts.countDocuments({ customerId: customer._id })).toBe(1);
    expect(await carts.countDocuments({ guestTokenHash: guestDocument.guestTokenHash })).toBe(0);

    await browser
      .get('/api/v1/cart')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ cart: { totalQuantity: 2, subtotalInPaise: 319800 } });
      });
    await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrf)
      .send({ name: 'Duplicate', email, password: originalPassword })
      .expect(409);

    const refreshResponse = await browser
      .post('/api/v1/customer/auth/refresh')
      .set('x-csrf-token', csrf)
      .expect(200);
    const rotatedAccessCookie = responseCookie(refreshResponse, CUSTOMER_ACCESS_COOKIE);
    await request(httpServer)
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', [csrfCookie, oldRefreshCookie])
      .set('x-csrf-token', csrf)
      .expect(401);
    await request(httpServer)
      .get('/api/v1/customer/auth/me')
      .set('Cookie', rotatedAccessCookie)
      .expect(401);

    await browser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password: originalPassword })
      .expect(200);
    await browser
      .patch('/api/v1/customer/auth/password')
      .set('x-csrf-token', csrf)
      .send({ currentPassword: originalPassword, newPassword: changedPassword })
      .expect(204);
    await browser.get('/api/v1/customer/auth/me').expect(401);

    const renewedCsrf = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    csrf = (renewedCsrf.body as CsrfBody).csrfToken;
    await browser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password: changedPassword })
      .expect(200);
    const currentCartResponse = await browser.get('/api/v1/cart').expect(200);
    const currentCart = (currentCartResponse.body as CartBody).cart;
    const removeResponse = await browser
      .delete(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: currentCart.version })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ cart: { items: [], totalQuantity: 0 } });
      });
    const removedCart = (removeResponse.body as CartBody).cart;
    await carts.updateOne(
      { _id: removedCart.id },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );
    await browser
      .put(`/api/v1/cart/items/${variantId.toHexString()}`)
      .set('x-csrf-token', csrf)
      .send({ productId: productId.toHexString(), quantity: 1, expectedVersion: 0 })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ cart: { totalQuantity: 1, readyForCheckout: true } });
      });
    expect(await carts.countDocuments({ customerId: customer._id })).toBe(1);
    await browser.post('/api/v1/customer/auth/logout-all').set('x-csrf-token', csrf).expect(204);
    await browser.get('/api/v1/customer/auth/me').expect(401);

    const actions = await auditLogs.distinct('action', {
      $or: [{ actorId: customer._id }, { action: /^CART_/ }],
      occurredAt: { $gte: startedAt },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        'CART_ITEM_SET',
        'CART_ITEM_REMOVED',
        'CUSTOMER_REGISTERED',
        'CUSTOMER_REFRESH_ROTATED',
        'CUSTOMER_REFRESH_REUSE_DETECTED',
        'CUSTOMER_PASSWORD_CHANGED',
        'CUSTOMER_LOGOUT_ALL',
      ]),
    );
  }, 60_000);
});
