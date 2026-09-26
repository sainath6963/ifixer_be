import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const nonNegativeIntegerExpression = (field: string): Document => ({
  $and: [
    { $gte: [field, 0] },
    { $eq: [{ $trunc: field }, field] },
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

export const applyCriticalValidatorsMigration: DatabaseMigration = {
  id: '002-apply-critical-database-validators',
  description: 'Enforce critical product, inventory, order, payment, and webhook invariants',
  async up(context): Promise<void> {
    await applyValidator(context, 'products', {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: ['name', 'slug', 'description', 'variants', 'status'],
            properties: {
              name: { bsonType: 'string', minLength: 1, maxLength: 180 },
              slug: { bsonType: 'string', minLength: 1, maxLength: 220 },
              description: { bsonType: 'string', minLength: 1, maxLength: 5000 },
              variants: {
                bsonType: 'array',
                minItems: 1,
                items: {
                  bsonType: 'object',
                  required: ['variantId', 'sku', 'title', 'priceInPaise', 'isActive'],
                  properties: {
                    variantId: { bsonType: 'objectId' },
                    sku: { bsonType: 'string', minLength: 1, maxLength: 100 },
                    title: { bsonType: 'string', minLength: 1, maxLength: 160 },
                    priceInPaise: { bsonType: 'number', minimum: 0 },
                    compareAtPriceInPaise: { bsonType: 'number', minimum: 0 },
                    isActive: { bsonType: 'bool' },
                  },
                },
              },
              status: { enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
            },
          },
        },
        {
          $expr: {
            $allElementsTrue: {
              $map: {
                input: '$variants',
                as: 'variant',
                in: nonNegativeIntegerExpression('$$variant.priceInPaise'),
              },
            },
          },
        },
      ],
    });

    await applyValidator(context, 'inventory_levels', {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: ['productId', 'variantId', 'sku', 'onHand', 'reserved', 'sold'],
            properties: {
              productId: { bsonType: 'objectId' },
              variantId: { bsonType: 'objectId' },
              sku: { bsonType: 'string', minLength: 1, maxLength: 100 },
              onHand: { bsonType: 'number', minimum: 0 },
              reserved: { bsonType: 'number', minimum: 0 },
              sold: { bsonType: 'number', minimum: 0 },
            },
          },
        },
        {
          $expr: {
            $and: [
              nonNegativeIntegerExpression('$onHand'),
              nonNegativeIntegerExpression('$reserved'),
              nonNegativeIntegerExpression('$sold'),
              { $lte: ['$reserved', '$onHand'] },
            ],
          },
        },
      ],
    });

    await applyValidator(context, 'inventory_reservations', {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: [
              'reservationGroupId',
              'productId',
              'variantId',
              'quantity',
              'status',
              'expiresAt',
            ],
            properties: {
              reservationGroupId: { bsonType: 'string', minLength: 1, maxLength: 100 },
              productId: { bsonType: 'objectId' },
              variantId: { bsonType: 'objectId' },
              quantity: { bsonType: 'number', minimum: 1 },
              status: { enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'] },
              expiresAt: { bsonType: 'date' },
            },
          },
        },
        { $expr: nonNegativeIntegerExpression('$quantity') },
      ],
    });

    await applyValidator(context, 'orders', {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'orderNumber',
          'idempotencyKey',
          'customer',
          'shippingAddress',
          'items',
          'totals',
          'currency',
          'lifecycleStatus',
          'financialStatus',
          'fulfillmentStatus',
          'paymentExpiresAt',
        ],
        properties: {
          orderNumber: { bsonType: 'string', minLength: 1, maxLength: 40 },
          idempotencyKey: { bsonType: 'string', minLength: 1, maxLength: 160 },
          customer: { bsonType: 'object' },
          shippingAddress: { bsonType: 'object' },
          items: { bsonType: 'array', minItems: 1 },
          totals: {
            bsonType: 'object',
            required: ['subtotalInPaise', 'grandTotalInPaise'],
            properties: {
              subtotalInPaise: { bsonType: 'number', minimum: 0 },
              grandTotalInPaise: { bsonType: 'number', minimum: 0 },
            },
          },
          currency: { enum: ['INR'] },
          lifecycleStatus: {
            enum: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'COMPLETED'],
          },
          financialStatus: {
            enum: ['UNPAID', 'PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED'],
          },
          fulfillmentStatus: {
            enum: ['UNFULFILLED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'],
          },
          paymentExpiresAt: { bsonType: 'date' },
        },
      },
    });

    await applyValidator(context, 'payment_attempts', {
      $and: [
        {
          $jsonSchema: {
            bsonType: 'object',
            required: [
              'orderId',
              'orderNumber',
              'attemptNumber',
              'idempotencyKey',
              'provider',
              'amountInPaise',
              'currency',
              'status',
            ],
            properties: {
              orderId: { bsonType: 'objectId' },
              attemptNumber: { bsonType: 'number', minimum: 1 },
              provider: { enum: ['RAZORPAY'] },
              amountInPaise: { bsonType: 'number', minimum: 1 },
              currency: { enum: ['INR'] },
              status: {
                enum: ['CREATING', 'CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
              },
            },
          },
        },
        { $expr: nonNegativeIntegerExpression('$amountInPaise') },
      ],
    });

    await applyValidator(context, 'webhook_events', {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'provider',
          'eventId',
          'eventType',
          'payloadHashSha256',
          'payload',
          'status',
          'receivedAt',
        ],
        properties: {
          provider: { enum: ['RAZORPAY'] },
          eventId: { bsonType: 'string', minLength: 1, maxLength: 160 },
          eventType: { bsonType: 'string', minLength: 1, maxLength: 160 },
          payloadHashSha256: {
            bsonType: 'string',
            pattern: '^[a-f0-9]{64}$',
          },
          payload: { bsonType: 'object' },
          status: { enum: ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'] },
          receivedAt: { bsonType: 'date' },
        },
      },
    });
  },
};
