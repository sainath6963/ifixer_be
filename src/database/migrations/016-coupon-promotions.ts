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

async function ensureCollection(
  context: MigrationContext,
  name: string,
  model: string,
): Promise<void> {
  const exists = await context.database.listCollections({ name }).hasNext();
  if (!exists) await context.connection.model(model).createCollection();
}

export const couponPromotionsMigration: DatabaseMigration = {
  id: '016-coupon-promotions',
  description: 'Add transactional coupon campaigns, reservations, and checkout snapshots',
  async up(context): Promise<void> {
    await ensureCollection(context, 'coupons', 'Coupon');
    await ensureCollection(context, 'coupon_redemptions', 'CouponRedemption');
    await context.connection.model('Coupon').createIndexes();
    await context.connection.model('CouponRedemption').createIndexes();

    await context.database.command({
      collMod: 'coupons',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'code',
                'name',
                'status',
                'discountType',
                'minimumSubtotalInPaise',
                'usageLimit',
                'reservedCount',
                'redeemedCount',
                'startsAt',
                'endsAt',
                'createdBy',
                'updatedBy',
              ],
              properties: {
                code: { bsonType: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{2,31}$' },
                name: { bsonType: 'string', minLength: 1, maxLength: 120 },
                description: { bsonType: 'string', maxLength: 500 },
                status: { enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] },
                discountType: { enum: ['PERCENTAGE', 'FIXED_AMOUNT'] },
                percentageOff: { bsonType: 'number', minimum: 1, maximum: 90 },
                fixedAmountInPaise: { bsonType: 'number', minimum: 1 },
                maximumDiscountInPaise: { bsonType: 'number', minimum: 1 },
                minimumSubtotalInPaise: { bsonType: 'number', minimum: 0 },
                usageLimit: { bsonType: 'number', minimum: 1, maximum: 1000000 },
                reservedCount: { bsonType: 'number', minimum: 0 },
                redeemedCount: { bsonType: 'number', minimum: 0 },
                startsAt: { bsonType: 'date' },
                endsAt: { bsonType: 'date' },
                createdBy: { bsonType: 'objectId' },
                updatedBy: { bsonType: 'objectId' },
              },
            },
          },
          {
            $expr: {
              $and: [
                nonNegativeSafeInteger('$minimumSubtotalInPaise'),
                positiveSafeInteger('$usageLimit'),
                nonNegativeSafeInteger('$reservedCount'),
                nonNegativeSafeInteger('$redeemedCount'),
                { $lt: ['$startsAt', '$endsAt'] },
                {
                  $lte: [{ $add: ['$reservedCount', '$redeemedCount'] }, '$usageLimit'],
                },
                {
                  $or: [
                    {
                      $and: [
                        { $eq: ['$discountType', 'PERCENTAGE'] },
                        positiveSafeInteger('$percentageOff'),
                        { $lte: ['$percentageOff', 90] },
                        { $eq: [{ $type: '$fixedAmountInPaise' }, 'missing'] },
                      ],
                    },
                    {
                      $and: [
                        { $eq: ['$discountType', 'FIXED_AMOUNT'] },
                        positiveSafeInteger('$fixedAmountInPaise'),
                        { $eq: [{ $type: '$percentageOff' }, 'missing'] },
                        { $eq: [{ $type: '$maximumDiscountInPaise' }, 'missing'] },
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

    await context.database.command({
      collMod: 'coupon_redemptions',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'couponId',
                'customerId',
                'orderId',
                'code',
                'status',
                'active',
                'discountInPaise',
                'reservedAt',
                'expiresAt',
              ],
              properties: {
                couponId: { bsonType: 'objectId' },
                customerId: { bsonType: 'objectId' },
                orderId: { bsonType: 'objectId' },
                code: { bsonType: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{2,31}$' },
                status: { enum: ['RESERVED', 'REDEEMED', 'RELEASED'] },
                active: { bsonType: 'bool' },
                discountInPaise: { bsonType: 'number', minimum: 1 },
                reservedAt: { bsonType: 'date' },
                expiresAt: { bsonType: 'date' },
                finalizedAt: { bsonType: 'date' },
              },
            },
          },
          { $expr: positiveSafeInteger('$discountInPaise') },
          {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: ['$status', 'RESERVED'] },
                    { $eq: ['$active', true] },
                    { $eq: [{ $type: '$finalizedAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'REDEEMED'] },
                    { $eq: ['$active', true] },
                    { $eq: [{ $type: '$finalizedAt' }, 'date'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'RELEASED'] },
                    { $eq: ['$active', false] },
                    { $eq: [{ $type: '$finalizedAt' }, 'date'] },
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

    const orderInfo = await context.database
      .listCollections({ name: 'orders' }, { nameOnly: false })
      .next();
    const orderValidator = (orderInfo?.options?.validator ?? {}) as Document;
    await context.database.command({
      collMod: 'orders',
      validator: {
        $and: [
          orderValidator,
          {
            $jsonSchema: {
              bsonType: 'object',
              properties: {
                coupon: {
                  bsonType: 'object',
                  required: [
                    'couponId',
                    'code',
                    'name',
                    'discountType',
                    'configuredValue',
                    'discountInPaise',
                  ],
                  properties: {
                    couponId: { bsonType: 'objectId' },
                    code: { bsonType: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{2,31}$' },
                    discountType: { enum: ['PERCENTAGE', 'FIXED_AMOUNT'] },
                    configuredValue: { bsonType: 'number', minimum: 1 },
                    discountInPaise: { bsonType: 'number', minimum: 1 },
                  },
                },
              },
            },
          },
          {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: [{ $type: '$coupon' }, 'missing'] },
                    { $eq: ['$totals.couponDiscountInPaise', 0] },
                  ],
                },
                {
                  $and: [
                    { $eq: [{ $type: '$coupon' }, 'object'] },
                    { $gt: ['$totals.couponDiscountInPaise', 0] },
                    {
                      $eq: ['$coupon.discountInPaise', '$totals.couponDiscountInPaise'],
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
