import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const integerExpression = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, Number.MIN_SAFE_INTEGER] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

async function applyValidator(
  context: MigrationContext,
  collection: string,
  validator: Document,
): Promise<void> {
  await context.database.command({
    collMod: collection,
    validator,
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

export const catalogMediaConstraintsMigration: DatabaseMigration = {
  id: '004-catalog-media-constraints',
  description: 'Apply admin catalog, media, and idempotent inventory-adjustment constraints',
  async up(context): Promise<void> {
    await context.connection.model('Category').createIndexes();
    await context.connection.model('MediaAsset').createIndexes();
    await context.connection.model('InventoryMovement').createIndexes();

    await applyValidator(context, 'categories', {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: ['name', 'slug', 'status', 'sortOrder'],
            properties: {
              name: { bsonType: 'string', minLength: 1, maxLength: 120 },
              slug: { bsonType: 'string', minLength: 1, maxLength: 160 },
              description: { bsonType: 'string', maxLength: 1000 },
              parentId: { bsonType: 'objectId' },
              imageMediaId: { bsonType: 'objectId' },
              status: { enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
              sortOrder: { bsonType: 'number', minimum: 0 },
              referenceRevision: { bsonType: 'number', minimum: 0 },
            },
          },
        },
        { $expr: integerExpression('$sortOrder') },
      ],
    });

    await applyValidator(context, 'media_assets', {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'storageProvider',
          'storageKey',
          'originalFilename',
          'mimeType',
          'sizeBytes',
          'checksumSha256',
          'status',
          'variants',
        ],
        properties: {
          storageProvider: { enum: ['LOCAL'] },
          storageKey: { bsonType: 'string', minLength: 1, maxLength: 500 },
          originalFilename: { bsonType: 'string', minLength: 1, maxLength: 255 },
          mimeType: { enum: ['image/webp'] },
          sizeBytes: { bsonType: 'number', minimum: 1 },
          checksumSha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
          width: { bsonType: 'number', minimum: 1 },
          height: { bsonType: 'number', minimum: 1 },
          status: { enum: ['PENDING', 'READY', 'DELETED'] },
          variants: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['name', 'storageKey', 'width', 'height', 'sizeBytes'],
              properties: {
                name: { enum: ['thumbnail', 'card', 'large'] },
                storageKey: { bsonType: 'string', minLength: 1, maxLength: 500 },
                width: { bsonType: 'number', minimum: 1 },
                height: { bsonType: 'number', minimum: 1 },
                sizeBytes: { bsonType: 'number', minimum: 1 },
              },
            },
          },
          createdBy: { bsonType: 'objectId' },
          deletedAt: { bsonType: 'date' },
          referenceRevision: { bsonType: 'number', minimum: 0 },
        },
      },
    });

    await applyValidator(context, 'inventory_movements', {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: [
              'productId',
              'variantId',
              'type',
              'deltaOnHand',
              'deltaReserved',
              'deltaSold',
              'referenceType',
              'referenceId',
            ],
            properties: {
              productId: { bsonType: 'objectId' },
              variantId: { bsonType: 'objectId' },
              type: {
                enum: ['RESTOCK', 'RESERVE', 'RELEASE', 'SALE', 'ADJUSTMENT', 'RETURN'],
              },
              deltaOnHand: { bsonType: 'number' },
              deltaReserved: { bsonType: 'number' },
              deltaSold: { bsonType: 'number' },
              referenceType: { bsonType: 'string', minLength: 1, maxLength: 50 },
              referenceId: { bsonType: 'string', minLength: 1, maxLength: 100 },
              actorId: { bsonType: 'objectId' },
              note: { bsonType: 'string', maxLength: 500 },
            },
          },
        },
        {
          $expr: {
            $and: [
              integerExpression('$deltaOnHand'),
              integerExpression('$deltaReserved'),
              integerExpression('$deltaSold'),
            ],
          },
        },
      ],
    });
  },
};
