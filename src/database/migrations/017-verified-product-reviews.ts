import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const nonNegativeInteger = (field: string): Document => ({
  $and: [{ $eq: [{ $trunc: field }, field] }, { $gte: [field, 0] }],
});

async function ensureCollection(
  context: MigrationContext,
  name: string,
  model: string,
): Promise<void> {
  if (!(await context.database.listCollections({ name }).hasNext())) {
    await context.connection.model(model).createCollection();
  }
}

export const verifiedProductReviewsMigration: DatabaseMigration = {
  id: '017-verified-product-reviews',
  description: 'Add verified-buyer product reviews, moderation, and atomic rating summaries',
  async up(context): Promise<void> {
    await ensureCollection(context, 'product_reviews', 'ProductReview');
    await ensureCollection(context, 'product_review_summaries', 'ProductReviewSummary');
    await context.connection.model('ProductReview').createIndexes();
    await context.connection.model('ProductReviewSummary').createIndexes();

    await context.database.command({
      collMod: 'product_reviews',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'productId',
                'customerId',
                'orderId',
                'orderNumber',
                'productName',
                'productSlug',
                'displayName',
                'rating',
                'title',
                'body',
                'status',
              ],
              properties: {
                productId: { bsonType: 'objectId' },
                customerId: { bsonType: 'objectId' },
                orderId: { bsonType: 'objectId' },
                orderNumber: { bsonType: 'string', maxLength: 40 },
                productName: { bsonType: 'string', minLength: 1, maxLength: 180 },
                productSlug: { bsonType: 'string', minLength: 1, maxLength: 220 },
                displayName: { bsonType: 'string', minLength: 1, maxLength: 80 },
                rating: { bsonType: 'number', minimum: 1, maximum: 5 },
                title: { bsonType: 'string', minLength: 3, maxLength: 120 },
                body: { bsonType: 'string', minLength: 10, maxLength: 2000 },
                status: { enum: ['PENDING', 'PUBLISHED', 'REJECTED', 'WITHDRAWN'] },
                moderatedBy: { bsonType: 'objectId' },
                moderatedAt: { bsonType: 'date' },
                publishedAt: { bsonType: 'date' },
                rejectionReason: { bsonType: 'string', minLength: 3, maxLength: 1000 },
                withdrawnAt: { bsonType: 'date' },
              },
            },
          },
          { $expr: { $eq: [{ $trunc: '$rating' }, '$rating'] } },
          {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: ['$status', 'PENDING'] },
                    { $eq: [{ $type: '$publishedAt' }, 'missing'] },
                    { $eq: [{ $type: '$rejectionReason' }, 'missing'] },
                    { $eq: [{ $type: '$withdrawnAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'PUBLISHED'] },
                    { $eq: [{ $type: '$moderatedBy' }, 'objectId'] },
                    { $eq: [{ $type: '$moderatedAt' }, 'date'] },
                    { $eq: [{ $type: '$publishedAt' }, 'date'] },
                    { $eq: [{ $type: '$rejectionReason' }, 'missing'] },
                    { $eq: [{ $type: '$withdrawnAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'REJECTED'] },
                    { $eq: [{ $type: '$moderatedBy' }, 'objectId'] },
                    { $eq: [{ $type: '$moderatedAt' }, 'date'] },
                    { $eq: [{ $type: '$rejectionReason' }, 'string'] },
                    { $eq: [{ $type: '$publishedAt' }, 'missing'] },
                    { $eq: [{ $type: '$withdrawnAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'WITHDRAWN'] },
                    { $eq: [{ $type: '$withdrawnAt' }, 'date'] },
                    { $eq: [{ $type: '$publishedAt' }, 'missing'] },
                    { $eq: [{ $type: '$rejectionReason' }, 'missing'] },
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
      collMod: 'product_review_summaries',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['productId', 'reviewCount', 'ratingTotal'],
              properties: {
                productId: { bsonType: 'objectId' },
                reviewCount: { bsonType: 'number', minimum: 0 },
                ratingTotal: { bsonType: 'number', minimum: 0 },
              },
            },
          },
          {
            $expr: {
              $and: [
                nonNegativeInteger('$reviewCount'),
                nonNegativeInteger('$ratingTotal'),
                {
                  $or: [
                    {
                      $and: [{ $eq: ['$reviewCount', 0] }, { $eq: ['$ratingTotal', 0] }],
                    },
                    {
                      $and: [
                        { $gt: ['$reviewCount', 0] },
                        { $gte: ['$ratingTotal', '$reviewCount'] },
                        { $lte: ['$ratingTotal', { $multiply: ['$reviewCount', 5] }] },
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
