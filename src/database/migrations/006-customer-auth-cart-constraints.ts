import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const positiveIntegerExpression = (field: string): Document => ({
  $and: [{ $eq: [{ $trunc: field }, field] }, { $gte: [field, 1] }, { $lte: [field, 10] }],
});

async function ensureCollection(context: MigrationContext, collectionName: string): Promise<void> {
  const exists = await context.database.listCollections({ name: collectionName }).hasNext();
  if (!exists) {
    await context.database.createCollection(collectionName);
  }
}

export const customerAuthCartConstraintsMigration: DatabaseMigration = {
  id: '006-customer-auth-cart-constraints',
  description: 'Add customer credentials, refresh sessions, and persistent cart constraints',
  async up(context): Promise<void> {
    await ensureCollection(context, 'customer_sessions');
    await ensureCollection(context, 'carts');
    await context.connection.model('Customer').createIndexes();
    await context.connection.model('CustomerSession').createIndexes();
    await context.connection.model('Cart').createIndexes();

    await context.database.command({
      collMod: 'customers',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['status', 'addresses'],
          properties: {
            name: { bsonType: 'string', minLength: 1, maxLength: 120 },
            email: { bsonType: 'string', minLength: 3, maxLength: 254 },
            mobile: { bsonType: 'string', minLength: 8, maxLength: 16 },
            passwordHash: { bsonType: 'string', minLength: 20 },
            status: { enum: ['ACTIVE', 'DISABLED'] },
            addresses: { bsonType: 'array' },
            lastLoginAt: { bsonType: 'date' },
            passwordChangedAt: { bsonType: 'date' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await context.database.command({
      collMod: 'customer_sessions',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['customerId', 'tokenHash', 'refreshGeneration', 'expiresAt'],
              properties: {
                customerId: { bsonType: 'objectId' },
                tokenHash: { bsonType: 'string', minLength: 64, maxLength: 64 },
                refreshGeneration: { bsonType: 'number', minimum: 0 },
                expiresAt: { bsonType: 'date' },
                revokedAt: { bsonType: 'date' },
                reuseDetectedAt: { bsonType: 'date' },
              },
            },
          },
          { $expr: { $eq: [{ $trunc: '$refreshGeneration' }, '$refreshGeneration'] } },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await context.database.command({
      collMod: 'carts',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['items', 'status', 'expiresAt'],
              properties: {
                customerId: { bsonType: 'objectId' },
                guestTokenHash: { bsonType: 'string', minLength: 64, maxLength: 64 },
                items: {
                  bsonType: 'array',
                  maxItems: 50,
                  items: {
                    bsonType: 'object',
                    required: ['productId', 'variantId', 'quantity', 'addedAt'],
                    properties: {
                      productId: { bsonType: 'objectId' },
                      variantId: { bsonType: 'objectId' },
                      quantity: { bsonType: 'number', minimum: 1, maximum: 10 },
                      addedAt: { bsonType: 'date' },
                    },
                  },
                },
                status: { enum: ['ACTIVE', 'CONVERTED', 'ABANDONED'] },
                expiresAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $eq: [
                {
                  $add: [
                    { $cond: [{ $eq: [{ $type: '$customerId' }, 'objectId'] }, 1, 0] },
                    { $cond: [{ $eq: [{ $type: '$guestTokenHash' }, 'string'] }, 1, 0] },
                  ],
                },
                1,
              ],
            },
          },
          {
            $expr: {
              $allElementsTrue: {
                $map: {
                  input: '$items',
                  as: 'item',
                  in: positiveIntegerExpression('$$item.quantity'),
                },
              },
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
