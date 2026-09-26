import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { dirname, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { Model, Types } from 'mongoose';
import sharp from 'sharp';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { Category, MediaAsset, Product } from '../src/database/schemas/catalog.schema';
import { AdminSession, AdminUser } from '../src/database/schemas/identity.schema';
import { InventoryLevel, InventoryMovement } from '../src/database/schemas/inventory.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { AccountStatus, AdminRole, ProductStatus } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';

interface CsrfBody {
  csrfToken: string;
}

interface CategoryBody {
  category: { id: string; status: ProductStatus; version: number };
}

interface MediaBody {
  media: {
    id: string;
    mimeType: string;
    storageKey?: string;
    variants: Array<{ name: string; url: string }>;
  };
}

interface ProductBody {
  product: {
    id: string;
    version: number;
    status: ProductStatus;
    variants: Array<{ variantId: string; sku: string }>;
    inventory: Array<{ variantId: string; sku: string; onHand: number; available: number }>;
  };
}

describe('Admin catalog and local media (e2e)', () => {
  const email = 'phase4-admin@richculture.test';
  const password = 'Phase4-admin-password';
  const startedAt = new Date();
  let app: INestApplication;
  let httpServer: Server;
  let adminUsers: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let categories: Model<Category>;
  let products: Model<Product>;
  let mediaAssets: Model<MediaAsset>;
  let inventory: Model<InventoryLevel>;
  let movements: Model<InventoryMovement>;
  let auditLogs: Model<AuditLog>;
  let adminId: Types.ObjectId;
  const mediaDirectories = new Set<string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    adminUsers = app.get(getModelToken(AdminUser.name));
    adminSessions = app.get(getModelToken(AdminSession.name));
    categories = app.get(getModelToken(Category.name));
    products = app.get(getModelToken(Product.name));
    mediaAssets = app.get(getModelToken(MediaAsset.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    movements = app.get(getModelToken(InventoryMovement.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();

    const existingAdmin = await adminUsers.findOne({ email });
    if (existingAdmin) {
      await adminSessions.deleteMany({ adminUserId: existingAdmin._id });
      await adminUsers.deleteOne({ _id: existingAdmin._id });
    }
    const passwordHash = await app.get(PasswordService).hash(password);
    const created = await adminUsers.create({
      name: 'Phase 4 Admin',
      email,
      passwordHash,
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    adminId = created._id;
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    const phaseProducts = await products.find({ slug: /^phase4-/ }).select('_id');
    const productIds = phaseProducts.map((product) => product._id);
    await movements.deleteMany({ productId: { $in: productIds } });
    await inventory.deleteMany({ productId: { $in: productIds } });
    await products.deleteMany({ _id: { $in: productIds } });
    await categories.deleteMany({ slug: /^phase4-/ });
    await mediaAssets.deleteMany({ originalFilename: /^phase4-/ });
    await adminSessions.deleteMany({ adminUserId: adminId });
    await adminUsers.deleteOne({ _id: adminId });
    await auditLogs.deleteMany({ occurredAt: { $gte: startedAt }, actorId: adminId });
    for (const directory of mediaDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    await app.close();
  });

  it('manages categories, products, variants, images, publishing, and stock invariants', async () => {
    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/admin/auth/csrf').expect(200);
    const csrf = (csrfResponse.body as CsrfBody).csrfToken;
    await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);

    const categoryResponse = await browser
      .post('/api/v1/admin/categories')
      .set('x-csrf-token', csrf)
      .send({ name: 'Phase 4 Shirts', slug: 'phase4-shirts', sortOrder: 10 })
      .expect(201);
    const category = (categoryResponse.body as CategoryBody).category;
    expect(category).toMatchObject({ status: ProductStatus.Draft, version: 0 });

    const activeCategoryResponse = await browser
      .patch(`/api/v1/admin/categories/${category.id}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: 0, status: ProductStatus.Active })
      .expect(200);
    expect((activeCategoryResponse.body as CategoryBody).category.version).toBe(1);

    await browser
      .post('/api/v1/admin/media/images')
      .set('x-csrf-token', csrf)
      .attach('file', Buffer.from('not-an-image'), 'phase4-invalid.jpg')
      .expect(400);

    const imageBuffer = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: '#6b412f' },
    })
      .png()
      .toBuffer();
    const uploadResponse = await browser
      .post('/api/v1/admin/media/images')
      .set('x-csrf-token', csrf)
      .attach('file', imageBuffer, 'phase4-product.png')
      .expect(201);
    const media = (uploadResponse.body as MediaBody).media;
    expect(media.mimeType).toBe('image/webp');
    expect(media.storageKey).toBeUndefined();
    expect(media.variants.map((variant) => variant.name)).toEqual(['thumbnail', 'card', 'large']);
    const mediaDocument = await mediaAssets.findById(media.id).orFail();
    mediaDirectories.add(
      dirname(resolve('/tmp/rich-culture-test-media', mediaDocument.storageKey)),
    );

    await request(httpServer)
      .get(`/api/v1/media/${media.id}/thumbnail`)
      .expect('Content-Type', /image\/webp/)
      .expect('Cache-Control', 'public, max-age=31536000, immutable')
      .expect(200);

    const createProductResponse = await browser
      .post('/api/v1/admin/products')
      .set('x-csrf-token', csrf)
      .send({
        name: 'Phase 4 Linen Shirt',
        slug: 'phase4-linen-shirt',
        description: 'A test linen shirt for the transactional catalog flow.',
        categoryIds: [category.id],
        variants: [
          {
            sku: 'PHASE4-LINEN-BLUE-M',
            title: 'Blue / M',
            attributes: [
              { name: 'color', value: 'Blue' },
              { name: 'size', value: 'M' },
            ],
            priceInPaise: 249900,
            compareAtPriceInPaise: 299900,
            initialOnHand: 10,
            reorderPoint: 2,
          },
        ],
        tags: ['linen', 'shirt'],
      })
      .expect(201);
    let product = (createProductResponse.body as ProductBody).product;
    const firstVariantId = product.variants[0].variantId;
    expect(product).toMatchObject({
      status: ProductStatus.Draft,
      version: 0,
      inventory: [{ onHand: 10, available: 10 }],
    });

    await browser
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: 0, status: ProductStatus.Active })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PRODUCT_PRIMARY_IMAGE_REQUIRED' });
      });

    const imageResponse = await browser
      .put(`/api/v1/admin/products/${product.id}/images`)
      .set('x-csrf-token', csrf)
      .send({
        expectedProductVersion: 0,
        images: [{ mediaAssetId: media.id, altText: 'Brown linen shirt', isPrimary: true }],
      })
      .expect(200);
    product = (imageResponse.body as ProductBody).product;
    expect(product.version).toBe(1);

    const publishResponse = await browser
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: 1, status: ProductStatus.Active, isFeatured: true })
      .expect(200);
    product = (publishResponse.body as ProductBody).product;
    expect(product).toMatchObject({ status: ProductStatus.Active, version: 2 });

    await browser
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: 1, name: 'Stale update' })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PRODUCT_VERSION_CONFLICT' });
      });

    const adjustmentUrl = `/api/v1/admin/products/${product.id}/variants/${firstVariantId}/inventory-adjustments`;
    const adjustment = {
      deltaOnHand: -3,
      idempotencyKey: 'phase4-adjust-0001',
      note: 'Cycle count',
    };
    await browser
      .post(adjustmentUrl)
      .set('x-csrf-token', csrf)
      .send(adjustment)
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ inventory: { onHand: 7, available: 7 } });
      });
    await browser
      .post(adjustmentUrl)
      .set('x-csrf-token', csrf)
      .send(adjustment)
      .expect(201)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ inventory: { onHand: 7 } });
      });
    await browser
      .post(adjustmentUrl)
      .set('x-csrf-token', csrf)
      .send({ ...adjustment, deltaOnHand: -2 })
      .expect(409);
    await browser
      .post(adjustmentUrl)
      .set('x-csrf-token', csrf)
      .send({ deltaOnHand: -100, idempotencyKey: 'phase4-adjust-0002', note: 'Invalid count' })
      .expect(409);

    const variantResponse = await browser
      .patch(`/api/v1/admin/products/${product.id}/variants/${firstVariantId}`)
      .set('x-csrf-token', csrf)
      .send({ expectedProductVersion: 2, sku: 'PHASE4-LINEN-BLUE-M-NEW' })
      .expect(200);
    product = (variantResponse.body as ProductBody).product;
    expect(product).toMatchObject({ version: 3 });
    expect(product.inventory[0]).toMatchObject({ sku: 'PHASE4-LINEN-BLUE-M-NEW', onHand: 7 });

    await browser
      .post(`/api/v1/admin/products/${product.id}/variants`)
      .set('x-csrf-token', csrf)
      .send({
        expectedProductVersion: 3,
        sku: 'PHASE4-LINEN-BLUE-M-NEW',
        title: 'Duplicate SKU',
        attributes: [{ name: 'size', value: 'XL' }],
        priceInPaise: 249900,
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PRODUCT_SKU_CONFLICT' });
      });

    await browser
      .post(`/api/v1/admin/products/${product.id}/variants`)
      .set('x-csrf-token', csrf)
      .send({
        expectedProductVersion: 3,
        sku: 'PHASE4-LINEN-OTHER',
        title: 'Duplicate attributes',
        attributes: [
          { name: 'size', value: 'M' },
          { name: 'color', value: 'Blue' },
        ],
        priceInPaise: 249900,
      })
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PRODUCT_VARIANT_ATTRIBUTES_CONFLICT' });
      });

    const addVariantResponse = await browser
      .post(`/api/v1/admin/products/${product.id}/variants`)
      .set('x-csrf-token', csrf)
      .send({
        expectedProductVersion: 3,
        sku: 'PHASE4-LINEN-BLUE-L',
        title: 'Blue / L',
        attributes: [
          { name: 'color', value: 'Blue' },
          { name: 'size', value: 'L' },
        ],
        priceInPaise: 249900,
        initialOnHand: 2,
      })
      .expect(201);
    product = (addVariantResponse.body as ProductBody).product;
    expect(product.version).toBe(4);
    expect(product.inventory).toHaveLength(2);

    await browser
      .delete(`/api/v1/admin/media/${media.id}`)
      .set('x-csrf-token', csrf)
      .expect(409)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'MEDIA_IN_USE' });
      });

    const unpublishResponse = await browser
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: 4, status: ProductStatus.Draft, isFeatured: false })
      .expect(200);
    product = (unpublishResponse.body as ProductBody).product;
    const detachResponse = await browser
      .put(`/api/v1/admin/products/${product.id}/images`)
      .set('x-csrf-token', csrf)
      .send({ expectedProductVersion: product.version, images: [] })
      .expect(200);
    product = (detachResponse.body as ProductBody).product;

    await browser.delete(`/api/v1/admin/media/${media.id}`).set('x-csrf-token', csrf).expect(204);
    await request(httpServer).get(`/api/v1/media/${media.id}/thumbnail`).expect(404);

    await browser
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('x-csrf-token', csrf)
      .send({ expectedVersion: product.version, status: ProductStatus.Archived })
      .expect(200);

    const actions = await auditLogs.distinct('action', { actorId: adminId });
    expect(actions).toEqual(
      expect.arrayContaining([
        'CATEGORY_CREATED',
        'MEDIA_IMAGE_UPLOADED',
        'PRODUCT_CREATED',
        'PRODUCT_IMAGES_REPLACED',
        'PRODUCT_UPDATED',
        'INVENTORY_ADJUSTED',
        'PRODUCT_VARIANT_CREATED',
        'MEDIA_IMAGE_DELETED',
      ]),
    );
  }, 60_000);
});
