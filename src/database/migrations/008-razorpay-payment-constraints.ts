import type { Document } from 'mongodb';

import type { DatabaseMigration } from './migration';

const positiveSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 1] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

export const razorpayPaymentConstraintsMigration: DatabaseMigration = {
  id: '008-razorpay-payment-constraints',
  description: 'Add idempotent Razorpay payment attempts and capture transition constraints',
  async up(context): Promise<void> {
    await context.connection.model('PaymentAttempt').createIndexes();
    await context.connection.model('WebhookEvent').createIndexes();
    await context.connection.model('InventoryMovement').createIndexes();

    await context.database.command({
      collMod: 'payment_attempts',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'orderId',
                'orderNumber',
                'attemptNumber',
                'idempotencyKey',
                'idempotencyRequestHash',
                'provider',
                'providerReceipt',
                'amountInPaise',
                'currency',
                'status',
              ],
              properties: {
                orderId: { bsonType: 'objectId' },
                orderNumber: { bsonType: 'string', minLength: 1, maxLength: 40 },
                attemptNumber: { bsonType: 'number', minimum: 1 },
                idempotencyKey: { bsonType: 'string', minLength: 16, maxLength: 160 },
                idempotencyRequestHash: {
                  bsonType: 'string',
                  pattern: '^[a-f0-9]{64}$',
                },
                provider: { enum: ['RAZORPAY'] },
                providerReceipt: { bsonType: 'string', minLength: 1, maxLength: 40 },
                amountInPaise: { bsonType: 'number', minimum: 1 },
                currency: { enum: ['INR'] },
                status: {
                  enum: ['CREATING', 'CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
                },
                providerOrderId: { bsonType: 'string', minLength: 1, maxLength: 100 },
                providerPaymentId: { bsonType: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
          {
            $expr: {
              $and: [
                positiveSafeInteger('$attemptNumber'),
                positiveSafeInteger('$amountInPaise'),
                {
                  $or: [
                    { $in: ['$status', ['CREATING', 'FAILED', 'CANCELLED']] },
                    {
                      $and: [
                        { $in: ['$status', ['CREATED', 'AUTHORIZED', 'CAPTURED']] },
                        { $eq: [{ $type: '$providerOrderId' }, 'string'] },
                      ],
                    },
                  ],
                },
                {
                  $or: [
                    { $ne: ['$status', 'CAPTURED'] },
                    { $eq: [{ $type: '$providerPaymentId' }, 'string'] },
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
