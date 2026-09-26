import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const nonNegativeSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

const positiveSafeInteger = (field: string): Document => ({
  $and: [nonNegativeSafeInteger(field), { $gte: [field, 1] }],
});

async function ensureCollection(context: MigrationContext): Promise<void> {
  const exists = await context.database.listCollections({ name: 'return_requests' }).hasNext();
  if (!exists) await context.connection.model('ReturnRequest').createCollection();
}

export const returnExchangeRequestsMigration: DatabaseMigration = {
  id: '013-return-exchange-requests',
  description: 'Add concurrency-safe item return and exchange request operations',
  async up(context): Promise<void> {
    await ensureCollection(context);
    await context.database
      .collection('orders')
      .updateMany(
        { returnAllocationRevision: { $exists: false } },
        { $set: { returnAllocationRevision: 0 } },
      );
    await context.connection.model('ReturnRequest').createIndexes();
    await context.connection.model('InventoryMovement').createIndexes();

    await context.database.command({
      collMod: 'return_requests',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'returnNumber',
                'orderId',
                'orderNumber',
                'customerId',
                'type',
                'status',
                'items',
                'idempotencyKey',
                'idempotencyRequestHash',
                'requestedAt',
                'statusHistory',
              ],
              properties: {
                returnNumber: { bsonType: 'string', minLength: 1, maxLength: 40 },
                orderId: { bsonType: 'objectId' },
                orderNumber: { bsonType: 'string', minLength: 1, maxLength: 40 },
                customerId: { bsonType: 'objectId' },
                type: { enum: ['RETURN', 'EXCHANGE'] },
                status: {
                  enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'RECEIVED', 'COMPLETED'],
                },
                items: {
                  bsonType: 'array',
                  minItems: 1,
                  maxItems: 50,
                  items: {
                    bsonType: 'object',
                    required: [
                      'productId',
                      'variantId',
                      'productName',
                      'sku',
                      'variantTitle',
                      'quantity',
                      'reason',
                      'estimatedValueInPaise',
                      'restockedQuantity',
                    ],
                    properties: {
                      productId: { bsonType: 'objectId' },
                      variantId: { bsonType: 'objectId' },
                      quantity: { bsonType: 'number', minimum: 1, maximum: 10 },
                      reason: {
                        enum: [
                          'SIZE_ISSUE',
                          'DAMAGED',
                          'WRONG_ITEM',
                          'QUALITY_ISSUE',
                          'CHANGED_MIND',
                          'OTHER',
                        ],
                      },
                      estimatedValueInPaise: { bsonType: 'number', minimum: 0 },
                      restockedQuantity: { bsonType: 'number', minimum: 0 },
                    },
                  },
                },
                idempotencyKey: { bsonType: 'string', minLength: 16, maxLength: 160 },
                idempotencyRequestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                requestedAt: { bsonType: 'date' },
                statusHistory: { bsonType: 'array', minItems: 1 },
                decidedAt: { bsonType: 'date' },
                receivedAt: { bsonType: 'date' },
                completedAt: { bsonType: 'date' },
                cancelledAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $and: [
                {
                  $allElementsTrue: {
                    $map: {
                      input: '$items',
                      as: 'item',
                      in: {
                        $and: [
                          positiveSafeInteger('$$item.quantity'),
                          nonNegativeSafeInteger('$$item.estimatedValueInPaise'),
                          nonNegativeSafeInteger('$$item.restockedQuantity'),
                          { $lte: ['$$item.restockedQuantity', '$$item.quantity'] },
                        ],
                      },
                    },
                  },
                },
                {
                  $eq: [{ $size: '$items' }, { $size: { $setUnion: ['$items.variantId', []] } }],
                },
                {
                  $or: [
                    { $ne: ['$type', 'EXCHANGE'] },
                    {
                      $allElementsTrue: {
                        $map: {
                          input: '$items',
                          as: 'item',
                          in: { $eq: [{ $type: '$$item.requestedExchangeVariant' }, 'object'] },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
