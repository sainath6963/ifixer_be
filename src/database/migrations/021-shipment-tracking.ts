import type { Document } from 'mongodb';

import type { DatabaseMigration } from './migration';

export const shipmentTrackingMigration: DatabaseMigration = {
  id: '021-shipment-tracking',
  description: 'Backfill provider-neutral shipment state and enforce chronological tracking data',
  async up(context): Promise<void> {
    await context.database
      .collection('orders')
      .updateMany({ shipping: { $type: 'object' }, 'shipping.provider': { $exists: false } }, [
        {
          $set: {
            'shipping.provider': 'MANUAL',
            'shipping.status': {
              $switch: {
                branches: [
                  { case: { $eq: ['$fulfillmentStatus', 'DELIVERED'] }, then: 'DELIVERED' },
                  { case: { $eq: ['$fulfillmentStatus', 'SHIPPED'] }, then: 'IN_TRANSIT' },
                ],
                default: 'READY_TO_SHIP',
              },
            },
            'shipping.courierName': {
              $ifNull: ['$shipping.courierName', 'Legacy courier'],
            },
            'shipping.trackingNumber': {
              $ifNull: ['$shipping.trackingNumber', { $concat: ['LEGACY-', '$orderNumber'] }],
            },
            'shipping.shippedAt': {
              $cond: [
                { $in: ['$fulfillmentStatus', ['SHIPPED', 'DELIVERED']] },
                { $ifNull: ['$shipping.shippedAt', '$updatedAt'] },
                '$$REMOVE',
              ],
            },
            'shipping.deliveredAt': {
              $cond: [
                { $eq: ['$fulfillmentStatus', 'DELIVERED'] },
                { $ifNull: ['$shipping.deliveredAt', '$updatedAt'] },
                '$$REMOVE',
              ],
            },
          },
        },
        {
          $set: {
            'shipping.lastEventAt': {
              $ifNull: ['$shipping.deliveredAt', '$shipping.shippedAt', '$updatedAt', '$createdAt'],
            },
            'shipping.trackingEvents': [
              {
                status: '$shipping.status',
                message: 'Shipment history migrated from the legacy fulfillment record',
                actorType: 'SYSTEM',
                occurredAt: {
                  $ifNull: [
                    '$shipping.deliveredAt',
                    '$shipping.shippedAt',
                    '$updatedAt',
                    '$createdAt',
                  ],
                },
              },
            ],
          },
        },
      ]);

    const orderInfo = await context.database
      .listCollections({ name: 'orders' }, { nameOnly: false })
      .next();
    const existingValidator = (orderInfo?.options?.validator ?? {}) as Document;
    await context.database.command({
      collMod: 'orders',
      validator: {
        $and: [
          existingValidator,
          {
            $jsonSchema: {
              bsonType: 'object',
              properties: {
                shipping: {
                  bsonType: 'object',
                  required: [
                    'provider',
                    'status',
                    'courierName',
                    'trackingNumber',
                    'trackingEvents',
                    'lastEventAt',
                  ],
                  properties: {
                    provider: { enum: ['MANUAL'] },
                    status: {
                      enum: [
                        'READY_TO_SHIP',
                        'IN_TRANSIT',
                        'OUT_FOR_DELIVERY',
                        'DELIVERY_EXCEPTION',
                        'DELIVERED',
                      ],
                    },
                    courierName: { bsonType: 'string', minLength: 2, maxLength: 100 },
                    trackingNumber: { bsonType: 'string', minLength: 3, maxLength: 160 },
                    trackingUrl: {
                      bsonType: 'string',
                      pattern: '^https://[^\\s]+$',
                      maxLength: 500,
                    },
                    serviceLevel: { bsonType: 'string', minLength: 2, maxLength: 100 },
                    estimatedDeliveryAt: { bsonType: 'date' },
                    trackingEvents: {
                      bsonType: 'array',
                      minItems: 1,
                      maxItems: 100,
                      items: {
                        bsonType: 'object',
                        required: ['status', 'message', 'actorType', 'occurredAt'],
                        properties: {
                          status: {
                            enum: [
                              'READY_TO_SHIP',
                              'IN_TRANSIT',
                              'OUT_FOR_DELIVERY',
                              'DELIVERY_EXCEPTION',
                              'DELIVERED',
                            ],
                          },
                          message: { bsonType: 'string', minLength: 3, maxLength: 240 },
                          location: { bsonType: 'string', minLength: 2, maxLength: 160 },
                          actorType: { enum: ['ADMIN', 'SYSTEM'] },
                          actorId: { bsonType: 'objectId' },
                          occurredAt: { bsonType: 'date' },
                        },
                      },
                    },
                    lastEventAt: { bsonType: 'date' },
                    shippedAt: { bsonType: 'date' },
                    deliveredAt: { bsonType: 'date' },
                  },
                },
              },
            },
          },
          {
            $expr: {
              $or: [
                { $eq: [{ $type: '$shipping' }, 'missing'] },
                {
                  $and: [
                    {
                      $eq: [
                        '$shipping.status',
                        { $arrayElemAt: ['$shipping.trackingEvents.status', -1] },
                      ],
                    },
                    {
                      $eq: [
                        '$shipping.lastEventAt',
                        { $arrayElemAt: ['$shipping.trackingEvents.occurredAt', -1] },
                      ],
                    },
                    {
                      $or: [
                        { $eq: ['$shipping.status', 'READY_TO_SHIP'] },
                        { $eq: [{ $type: '$shipping.shippedAt' }, 'date'] },
                      ],
                    },
                    {
                      $eq: [
                        { $eq: ['$shipping.status', 'DELIVERED'] },
                        { $eq: [{ $type: '$shipping.deliveredAt' }, 'date'] },
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
    await context.connection.model('Order').createIndexes();
  },
};
