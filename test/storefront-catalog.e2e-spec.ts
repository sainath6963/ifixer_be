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
import { Category, MediaAsset, Product } from '../src/database/schemas/catalog.schema';
import { InventoryLevel } from '../src/database/schemas/inventory.schema';
import { StoreSetting } from '../src/database/schemas/operations.schema';
import { MediaStatus, ProductStatus, StorageProvider } from '../src/domain/enums';

interface ProductPageBody {
  items: Array<{
    id: string;
    name: string;
    slug: string;
    priceRange: { minInPaise: number; maxInPaise: number; currency: string };
    availability: string;
    primaryImage?: { mediaAssetId: string; sources: Record<string, string> };
  }>;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ProductDetailBody {
  product: {
    slug: string;
    primaryImage?: { mediaAssetId: string };
    images: Array<{ mediaAssetId: string }>;
    variants: Array<{ variantId: string; sku: string; availability: string }>;
    availability: string;
  };
}

describe('Public storefront catalog (e2e)', () => {
  const prefix = 'phase5-e2e';
  let app: INestApplication;
  let httpServer: Server;
  let categories: Model<Category>;
  let products: Model<Product>;
  let mediaAssets: Model<MediaAsset>;
  let inventory: Model<InventoryLevel>;
  let settings: Model<StoreSetting>;
  let rootCategoryId: Types.ObjectId;
  let childCategoryId: Types.ObjectId;
  let primaryMediaId: Types.ObjectId;
  let secondaryMediaId: Types.ObjectId;
  let linenProductId: Types.ObjectId;
  let linenInStockVariantId: Types.ObjectId;

  const cleanFixtures = async (): Promise<void> => {
    const fixtureProducts = await products.find({ slug: new RegExp(`^${prefix}-`) }).select('_id');
    const productIds = fixtureProducts.map((product) => product._id);
    await inventory.deleteMany({ productId: { $in: productIds } });
    await products.deleteMany({ _id: { $in: productIds } });
    await categories.deleteMany({ slug: new RegExp(`^${prefix}-`) });
    await mediaAssets.deleteMany({ originalFilename: new RegExp(`^${prefix}-`) });
    await settings.deleteMany({ key: new RegExp(`^${prefix}\\.`) });
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
    categories = app.get(getModelToken(Category.name));
    products = app.get(getModelToken(Product.name));
    mediaAssets = app.get(getModelToken(MediaAsset.name));
    inventory = app.get(getModelToken(InventoryLevel.name));
    settings = app.get(getModelToken(StoreSetting.name));
    await app.get(MigrationRunner).run();
    await cleanFixtures();

    const primaryMedia = await mediaAssets.create({
      storageProvider: StorageProvider.Local,
      storageKey: `${prefix}/primary/original.webp`,
      originalFilename: `${prefix}-primary.webp`,
      mimeType: 'image/webp',
      sizeBytes: 100,
      checksumSha256: 'a'.repeat(64),
      width: 1200,
      height: 900,
      status: MediaStatus.Ready,
      variants: [
        {
          name: 'thumbnail',
          storageKey: `${prefix}/primary/thumbnail.webp`,
          width: 240,
          height: 180,
          sizeBytes: 10,
        },
        {
          name: 'card',
          storageKey: `${prefix}/primary/card.webp`,
          width: 640,
          height: 480,
          sizeBytes: 20,
        },
        {
          name: 'large',
          storageKey: `${prefix}/primary/large.webp`,
          width: 1200,
          height: 900,
          sizeBytes: 30,
        },
      ],
    });
    const secondaryMedia = await mediaAssets.create({
      storageProvider: StorageProvider.Local,
      storageKey: `${prefix}/secondary/original.webp`,
      originalFilename: `${prefix}-secondary.webp`,
      mimeType: 'image/webp',
      sizeBytes: 100,
      checksumSha256: 'b'.repeat(64),
      width: 1200,
      height: 900,
      status: MediaStatus.Ready,
      variants: [
        {
          name: 'thumbnail',
          storageKey: `${prefix}/secondary/thumbnail.webp`,
          width: 240,
          height: 180,
          sizeBytes: 10,
        },
        {
          name: 'card',
          storageKey: `${prefix}/secondary/card.webp`,
          width: 640,
          height: 480,
          sizeBytes: 20,
        },
        {
          name: 'large',
          storageKey: `${prefix}/secondary/large.webp`,
          width: 1200,
          height: 900,
          sizeBytes: 30,
        },
      ],
    });
    primaryMediaId = primaryMedia._id;
    secondaryMediaId = secondaryMedia._id;

    const rootCategory = await categories.create({
      name: 'Phase 5 Clothing',
      slug: `${prefix}-clothing`,
      description: 'Active root category',
      imageMediaId: primaryMediaId,
      status: ProductStatus.Active,
      sortOrder: 1,
    });
    const childCategory = await categories.create({
      name: 'Phase 5 Shirts',
      slug: `${prefix}-shirts`,
      parentId: rootCategory._id,
      status: ProductStatus.Active,
      sortOrder: 1,
    });
    await categories.create({
      name: 'Phase 5 Hidden',
      slug: `${prefix}-hidden`,
      parentId: rootCategory._id,
      status: ProductStatus.Draft,
      sortOrder: 2,
    });
    rootCategoryId = rootCategory._id;
    childCategoryId = childCategory._id;

    const inStockVariantId = new Types.ObjectId();
    const inactiveVariantId = new Types.ObjectId();
    const outOfStockVariantId = new Types.ObjectId();
    const linenProduct = await products.create({
      name: 'Phase 5 Premium Linen Shirt',
      slug: `${prefix}-premium-linen-shirt`,
      description: 'Breathable premium linen shirt for warm summer days.',
      categoryIds: [childCategoryId],
      variants: [
        {
          variantId: inStockVariantId,
          sku: 'PHASE5-E2E-LINEN-M',
          title: 'Natural / M',
          attributes: [{ name: 'size', value: 'M' }],
          priceInPaise: 249900,
          isActive: true,
          sortOrder: 1,
        },
        {
          variantId: inactiveVariantId,
          sku: 'PHASE5-E2E-LINEN-L-INACTIVE',
          title: 'Natural / L',
          attributes: [{ name: 'size', value: 'L' }],
          priceInPaise: 299900,
          isActive: false,
          sortOrder: 2,
        },
        {
          variantId: outOfStockVariantId,
          sku: 'PHASE5-E2E-LINEN-XL',
          title: 'Natural / XL',
          attributes: [{ name: 'size', value: 'XL' }],
          priceInPaise: 349900,
          isActive: true,
          sortOrder: 3,
        },
      ],
      images: [
        {
          mediaAssetId: secondaryMediaId,
          altText: 'Secondary linen view',
          isPrimary: false,
          sortOrder: 0,
        },
        {
          mediaAssetId: primaryMediaId,
          altText: 'Primary linen view',
          isPrimary: true,
          sortOrder: 5,
        },
      ],
      tags: ['linen', 'summer'],
      status: ProductStatus.Active,
      isFeatured: true,
      publishedAt: new Date(Date.now() - 60_000),
    });
    linenProductId = linenProduct._id;
    linenInStockVariantId = inStockVariantId;
    await inventory.create([
      {
        productId: linenProductId,
        variantId: inStockVariantId,
        sku: 'PHASE5-E2E-LINEN-M',
        onHand: 5,
        reserved: 2,
        sold: 1,
      },
      {
        productId: linenProductId,
        variantId: inactiveVariantId,
        sku: 'PHASE5-E2E-LINEN-L-INACTIVE',
        onHand: 10,
        reserved: 0,
        sold: 0,
      },
      {
        productId: linenProductId,
        variantId: outOfStockVariantId,
        sku: 'PHASE5-E2E-LINEN-XL',
        onHand: 3,
        reserved: 3,
        sold: 0,
      },
    ]);

    const lowerPriceVariantId = new Types.ObjectId();
    const lowerPriceProduct = await products.create({
      name: 'Phase 5 Cotton Tee',
      slug: `${prefix}-cotton-tee`,
      description: 'Everyday cotton tee.',
      categoryIds: [rootCategoryId],
      variants: [
        {
          variantId: lowerPriceVariantId,
          sku: 'PHASE5-E2E-COTTON',
          title: 'Default',
          attributes: [{ name: 'style', value: 'Default' }],
          priceInPaise: 129900,
          isActive: true,
        },
      ],
      images: [],
      tags: ['cotton'],
      status: ProductStatus.Active,
      isFeatured: false,
      publishedAt: new Date(Date.now() - 120_000),
    });
    await inventory.create({
      productId: lowerPriceProduct._id,
      variantId: lowerPriceVariantId,
      sku: 'PHASE5-E2E-COTTON',
      onHand: 0,
      reserved: 0,
      sold: 0,
    });

    await products.create([
      {
        name: 'Phase 5 Draft Linen',
        slug: `${prefix}-draft-linen`,
        description: 'Draft products must remain private.',
        categoryIds: [childCategoryId],
        variants: [
          {
            sku: 'PHASE5-E2E-DRAFT',
            title: 'Default',
            attributes: [{ name: 'style', value: 'Draft' }],
            priceInPaise: 10000,
            isActive: true,
          },
        ],
        status: ProductStatus.Draft,
      },
      {
        name: 'Phase 5 Future Linen',
        slug: `${prefix}-future-linen`,
        description: 'Future publication must remain private.',
        categoryIds: [childCategoryId],
        variants: [
          {
            sku: 'PHASE5-E2E-FUTURE',
            title: 'Default',
            attributes: [{ name: 'style', value: 'Future' }],
            priceInPaise: 10000,
            isActive: true,
          },
        ],
        status: ProductStatus.Active,
        publishedAt: new Date(Date.now() + 3_600_000),
      },
    ]);
    await settings.create([
      { key: `${prefix}.announcement`, value: 'Free shipping', isPublic: true },
      { key: `${prefix}.privateSecret`, value: 'never-expose', isPublic: false },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('returns only the active category tree and public media URLs', async () => {
    const response = await request(httpServer)
      .get('/api/v1/catalog/categories')
      .expect('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
      .expect(200);
    const body = response.body as {
      categories: Array<{ slug: string; image?: object; children: Array<{ slug: string }> }>;
    };
    const root = body.categories.find((category) => category.slug === `${prefix}-clothing`);
    expect(root).toBeDefined();
    expect(root?.children.map((child) => child.slug)).toEqual([`${prefix}-shirts`]);
    expect(root?.image).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('storageKey');
  });

  it('lists descendants, filters by active-variant price, and reports advisory availability', async () => {
    const response = await request(httpServer)
      .get('/api/v1/catalog/products')
      .query({
        category: `${prefix}-clothing`,
        minPriceInPaise: 200000,
        maxPriceInPaise: 300000,
      })
      .expect('Cache-Control', 'public, max-age=15, stale-while-revalidate=30')
      .expect(200);
    const body = response.body as ProductPageBody;
    expect(body).toMatchObject({ page: 1, limit: 24, total: 1, totalPages: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      slug: `${prefix}-premium-linen-shirt`,
      priceRange: { minInPaise: 249900, maxInPaise: 249900, currency: 'INR' },
      availability: 'IN_STOCK',
    });
  });

  it('supports price sorting, text relevance, and the featured subset', async () => {
    const sorted = await request(httpServer)
      .get('/api/v1/catalog/products')
      .query({ sort: 'price-asc' })
      .expect(200);
    const sortedBody = sorted.body as ProductPageBody;
    const fixtureSlugs = sortedBody.items
      .map((item) => item.slug)
      .filter((slug) => slug.startsWith(prefix));
    expect(fixtureSlugs).toEqual([`${prefix}-cotton-tee`, `${prefix}-premium-linen-shirt`]);

    const search = await request(httpServer)
      .get('/api/v1/catalog/products')
      .query({ search: 'premium linen', sort: 'relevance' })
      .expect(200);
    const searchBody = search.body as ProductPageBody;
    expect(searchBody.items.map((item) => item.slug)).toContain(`${prefix}-premium-linen-shirt`);
    expect(searchBody.items.map((item) => item.slug)).not.toContain(`${prefix}-draft-linen`);
    expect(searchBody.items.map((item) => item.slug)).not.toContain(`${prefix}-future-linen`);

    const featured = await request(httpServer).get('/api/v1/catalog/products/featured').expect(200);
    const featuredBody = featured.body as ProductPageBody;
    expect(featuredBody.items.map((item) => item.slug)).toContain(`${prefix}-premium-linen-shirt`);
    expect(featuredBody.items.map((item) => item.slug)).not.toContain(`${prefix}-cotton-tee`);
  });

  it('returns safe active variants and the explicitly selected primary image', async () => {
    const response = await request(httpServer)
      .get(`/api/v1/catalog/products/${prefix}-premium-linen-shirt`)
      .expect(200);
    const body = response.body as ProductDetailBody;
    expect(body.product.primaryImage?.mediaAssetId).toBe(primaryMediaId.toHexString());
    expect(body.product.images[0].mediaAssetId).toBe(secondaryMediaId.toHexString());
    expect(body.product.variants).toHaveLength(2);
    expect(body.product.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: linenInStockVariantId.toHexString(),
          availability: 'IN_STOCK',
        }),
        expect.objectContaining({ availability: 'OUT_OF_STOCK' }),
      ]),
    );
    const serialized = JSON.stringify(body);
    for (const privateField of [
      'storageKey',
      'onHand',
      'reserved',
      'sold',
      'referenceRevision',
      'createdBy',
    ]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it('does not expose unpublished products or private store settings', async () => {
    await request(httpServer).get(`/api/v1/catalog/products/${prefix}-draft-linen`).expect(404);
    await request(httpServer).get(`/api/v1/catalog/products/${prefix}-future-linen`).expect(404);

    const response = await request(httpServer).get('/api/v1/catalog/config').expect(200);
    const body = response.body as { settings: Record<string, unknown> };
    expect(body.settings[`${prefix}.announcement`]).toBe('Free shipping');
    expect(body.settings[`${prefix}.privateSecret`]).toBeUndefined();
  });

  it('validates public filters and uses the storefront newest index', async () => {
    await request(httpServer)
      .get('/api/v1/catalog/products')
      .query({ minPriceInPaise: 50000, maxPriceInPaise: 10000 })
      .expect(400)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PRICE_RANGE_INVALID' });
      });

    const explanation = await products.collection
      .find({ status: ProductStatus.Active, publishedAt: { $lte: new Date() } })
      .sort({ publishedAt: -1, _id: -1 })
      .hint('ix_products_storefront_newest')
      .explain('executionStats');
    expect(JSON.stringify(explanation)).toContain('ix_products_storefront_newest');
  });
});
