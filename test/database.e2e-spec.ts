import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { MongoServerError } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { Product } from '../src/database/schemas/catalog.schema';
import { AuditLog, StoreSetting } from '../src/database/schemas/operations.schema';
import { AuditActorType } from '../src/domain/enums';

describe('MongoDB persistence foundation (e2e)', () => {
  let app: INestApplication;
  let connection: Connection;
  let products: Model<Product>;
  let settings: Model<StoreSetting>;
  let auditLogs: Model<AuditLog>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();

    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    connection = app.get<Connection>(getConnectionToken());
    products = app.get<Model<Product>>(getModelToken(Product.name));
    settings = app.get<Model<StoreSetting>>(getModelToken(StoreSetting.name));
    auditLogs = app.get<Model<AuditLog>>(getModelToken(AuditLog.name));

    await app.get(MigrationRunner).run();
    await products.deleteMany({ slug: /^phase2-e2e-/ });
    await settings.deleteMany({ key: /^phase2\.e2e\./ });
    await auditLogs.deleteMany({ resourceId: /^phase2-e2e-/ });
  }, 30000);

  afterAll(async () => {
    await products.deleteMany({ slug: /^phase2-e2e-/ });
    await settings.deleteMany({ key: /^phase2\.e2e\./ });
    await auditLogs.deleteMany({ resourceId: /^phase2-e2e-/ });
    await app.close();
  });

  it('creates controlled named indexes including global variant SKU uniqueness', async () => {
    await products.init();
    const indexes = await products.collection.indexes();
    const indexNames = indexes.map((index) => index.name);

    expect(indexNames).toContain('uq_products_slug');
    expect(indexNames).toContain('uq_products_variant_sku');
    expect(indexNames).toContain('tx_products_search');
    expect(indexNames).toContain('ix_products_storefront_newest');
    expect(indexNames).toContain('ix_products_storefront_variant_price');
  });

  it('enforces unique product slugs at database level', async () => {
    const baseProduct = {
      name: 'Phase 2 E2E Product',
      slug: 'phase2-e2e-unique-slug',
      description: 'Database uniqueness integration test.',
      variants: [
        {
          sku: 'PHASE2-E2E-SKU-1',
          title: 'Default',
          priceInPaise: 10000,
        },
      ],
    };

    await products.create(baseProduct);

    await expect(
      products.create({
        ...baseProduct,
        variants: [
          {
            sku: 'PHASE2-E2E-SKU-2',
            title: 'Alternative',
            priceInPaise: 12000,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects invalid inventory written outside Mongoose', async () => {
    const database = connection.db;
    if (!database) {
      throw new Error('Test database is unavailable');
    }

    try {
      await database.collection('inventory_levels').insertOne({
        productId: new Types.ObjectId(),
        variantId: new Types.ObjectId(),
        sku: 'PHASE2-E2E-INVALID-STOCK',
        onHand: -1,
        reserved: 0,
        sold: 0,
      });
      throw new Error('Invalid inventory document unexpectedly succeeded');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(MongoServerError);
      expect((error as MongoServerError).code).toBe(121);
    }
  });

  it('rolls back writes across collections in a MongoDB transaction', async () => {
    const settingKey = 'phase2.e2e.transaction';
    const resourceId = 'phase2-e2e-transaction';

    await expect(
      connection.transaction(async (session): Promise<void> => {
        await settings.create([{ key: settingKey, value: true, isPublic: false }], { session });
        await auditLogs.create(
          [
            {
              actorType: AuditActorType.System,
              action: 'PHASE2_TRANSACTION_TEST',
              resourceType: 'TEST',
              resourceId,
            },
          ],
          { session },
        );
        throw new Error('force-rollback');
      }),
    ).rejects.toThrow('force-rollback');

    await expect(settings.countDocuments({ key: settingKey })).resolves.toBe(0);
    await expect(auditLogs.countDocuments({ resourceId })).resolves.toBe(0);
  });
});
