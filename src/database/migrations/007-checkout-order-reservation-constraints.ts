import type { Document } from 'mongodb';

import type { DatabaseMigration } from './migration';

const nonNegativeIntegerExpression = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

const positiveIntegerExpression = (field: string): Document => ({
  $and: [nonNegativeIntegerExpression(field), { $gte: [field, 1] }],
});

export const checkoutOrderReservationConstraintsMigration: DatabaseMigration = {
  id: '007-checkout-order-reservation-constraints',
  description: 'Add idempotent checkout snapshots and reservation transition constraints',
  async up(context): Promise<void> {
    await context.connection.model('Order').createIndexes();
    await context.connection.model('InventoryReservation').createIndexes();
    await context.connection.model('InventoryMovement').createIndexes();

    await context.database.command({
      collMod: 'orders',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'orderNumber',
                'idempotencyKey',
                'idempotencyRequestHash',
                'sourceCartId',
                'customerId',
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
                idempotencyKey: { bsonType: 'string', minLength: 16, maxLength: 160 },
                idempotencyRequestHash: {
                  bsonType: 'string',
                  pattern: '^[a-f0-9]{64}$',
                },
                sourceCartId: { bsonType: 'objectId' },
                customerId: { bsonType: 'objectId' },
                customer: { bsonType: 'object' },
                shippingAddress: {
                  bsonType: 'object',
                  required: [
                    'fullName',
                    'phone',
                    'line1',
                    'city',
                    'state',
                    'postalCode',
                    'countryCode',
                  ],
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
                      'productSlug',
                      'sku',
                      'variantTitle',
                      'unitPriceInPaise',
                      'discountInPaise',
                      'taxInPaise',
                      'quantity',
                      'lineTotalInPaise',
                    ],
                    properties: {
                      productId: { bsonType: 'objectId' },
                      variantId: { bsonType: 'objectId' },
                      unitPriceInPaise: { bsonType: 'number', minimum: 0 },
                      discountInPaise: { bsonType: 'number', minimum: 0 },
                      taxInPaise: { bsonType: 'number', minimum: 0 },
                      quantity: { bsonType: 'number', minimum: 1, maximum: 10 },
                      lineTotalInPaise: { bsonType: 'number', minimum: 0 },
                    },
                  },
                },
                totals: {
                  bsonType: 'object',
                  required: [
                    'subtotalInPaise',
                    'itemDiscountInPaise',
                    'couponDiscountInPaise',
                    'shippingInPaise',
                    'taxInPaise',
                    'grandTotalInPaise',
                  ],
                  properties: {
                    subtotalInPaise: { bsonType: 'number', minimum: 0 },
                    itemDiscountInPaise: { bsonType: 'number', minimum: 0 },
                    couponDiscountInPaise: { bsonType: 'number', minimum: 0 },
                    shippingInPaise: { bsonType: 'number', minimum: 0 },
                    taxInPaise: { bsonType: 'number', minimum: 0 },
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
                  enum: [
                    'UNFULFILLED',
                    'PROCESSING',
                    'SHIPPED',
                    'DELIVERED',
                    'CANCELLED',
                    'RETURNED',
                  ],
                },
                paymentExpiresAt: { bsonType: 'date' },
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
                          nonNegativeIntegerExpression('$$item.unitPriceInPaise'),
                          nonNegativeIntegerExpression('$$item.discountInPaise'),
                          nonNegativeIntegerExpression('$$item.taxInPaise'),
                          positiveIntegerExpression('$$item.quantity'),
                          nonNegativeIntegerExpression('$$item.lineTotalInPaise'),
                          {
                            $eq: [
                              '$$item.lineTotalInPaise',
                              {
                                $add: [
                                  {
                                    $subtract: [
                                      {
                                        $multiply: ['$$item.unitPriceInPaise', '$$item.quantity'],
                                      },
                                      '$$item.discountInPaise',
                                    ],
                                  },
                                  '$$item.taxInPaise',
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
                {
                  $eq: [
                    '$totals.subtotalInPaise',
                    {
                      $reduce: {
                        input: '$items',
                        initialValue: 0,
                        in: {
                          $add: [
                            '$$value',
                            { $multiply: ['$$this.unitPriceInPaise', '$$this.quantity'] },
                          ],
                        },
                      },
                    },
                  ],
                },
                {
                  $eq: [
                    '$totals.grandTotalInPaise',
                    {
                      $add: [
                        {
                          $subtract: [
                            {
                              $subtract: ['$totals.subtotalInPaise', '$totals.itemDiscountInPaise'],
                            },
                            '$totals.couponDiscountInPaise',
                          ],
                        },
                        '$totals.shippingInPaise',
                        '$totals.taxInPaise',
                      ],
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
