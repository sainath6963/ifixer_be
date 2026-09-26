import { ObjectId, type Document } from 'mongodb';
import { createHash } from 'node:crypto';

import type { DatabaseMigration } from './migration';

const positiveSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 1] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

const nonNegativeSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

export const adminOrderRefundOperationsMigration: DatabaseMigration = {
  id: '009-admin-order-refund-operations',
  description: 'Add admin fulfillment, refund ledger, and Razorpay refund constraints',
  async up(context): Promise<void> {
    const paymentAttempts = context.database.collection('payment_attempts');
    const refunds = context.database.collection('refunds');

    await paymentAttempts.updateMany({}, [
      {
        $set: {
          refundedInPaise: { $ifNull: ['$refundedInPaise', 0] },
          refundPendingInPaise: { $ifNull: ['$refundPendingInPaise', 0] },
        },
      },
    ]);

    const legacyRefunds = await refunds
      .find({
        $or: [
          { idempotencyRequestHash: { $exists: false } },
          { providerReceipt: { $exists: false } },
          { providerPaymentId: { $exists: false } },
          { currency: { $exists: false } },
          { providerFeeInPaise: { $exists: false } },
        ],
      })
      .toArray();
    for (const refund of legacyRefunds) {
      const paymentAttemptId = refund.paymentAttemptId as unknown;
      if (!(paymentAttemptId instanceof ObjectId)) {
        throw new Error(
          `Cannot migrate legacy refund ${String(refund._id)} with an invalid payment`,
        );
      }
      const attempt = await paymentAttempts.findOne({ _id: paymentAttemptId });
      const providerPaymentId = attempt?.providerPaymentId as unknown;
      if (!attempt || typeof providerPaymentId !== 'string') {
        throw new Error(`Cannot migrate legacy refund ${String(refund._id)} without a payment ID`);
      }
      const providerReceipt = String(refund.refundNumber);
      const legacyIdempotencyKey =
        typeof refund.idempotencyKey === 'string' ? refund.idempotencyKey : '';
      const legacyAmountInPaise =
        typeof refund.amountInPaise === 'number' ? refund.amountInPaise : 0;
      const providerFeeInPaise =
        typeof refund.providerFeeInPaise === 'number' ? refund.providerFeeInPaise : 0;
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            legacyRefundId: String(refund._id),
            idempotencyKey: legacyIdempotencyKey,
            amountInPaise: legacyAmountInPaise,
          }),
        )
        .digest('hex');
      await refunds.updateOne(
        { _id: refund._id },
        {
          $set: {
            idempotencyRequestHash: requestHash,
            providerReceipt,
            providerPaymentId,
            currency: 'INR',
            providerFeeInPaise,
          },
        },
      );
    }

    await context.connection.model('Order').createIndexes();
    await context.connection.model('PaymentAttempt').createIndexes();
    await context.connection.model('Refund').createIndexes();
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
                'refundedInPaise',
                'refundPendingInPaise',
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
                refundedInPaise: { bsonType: 'number', minimum: 0 },
                refundPendingInPaise: { bsonType: 'number', minimum: 0 },
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
                nonNegativeSafeInteger('$refundedInPaise'),
                nonNegativeSafeInteger('$refundPendingInPaise'),
                {
                  $lte: [{ $add: ['$refundedInPaise', '$refundPendingInPaise'] }, '$amountInPaise'],
                },
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

    await context.database.command({
      collMod: 'refunds',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'refundNumber',
                'orderId',
                'paymentAttemptId',
                'idempotencyKey',
                'idempotencyRequestHash',
                'provider',
                'providerReceipt',
                'providerPaymentId',
                'amountInPaise',
                'providerFeeInPaise',
                'currency',
                'status',
                'reason',
                'requestedBy',
              ],
              properties: {
                refundNumber: { bsonType: 'string', minLength: 1, maxLength: 40 },
                orderId: { bsonType: 'objectId' },
                paymentAttemptId: { bsonType: 'objectId' },
                idempotencyKey: { bsonType: 'string', minLength: 16, maxLength: 160 },
                idempotencyRequestHash: {
                  bsonType: 'string',
                  pattern: '^[a-f0-9]{64}$',
                },
                provider: { enum: ['RAZORPAY'] },
                providerReceipt: { bsonType: 'string', minLength: 1, maxLength: 40 },
                providerPaymentId: { bsonType: 'string', minLength: 1, maxLength: 100 },
                amountInPaise: { bsonType: 'number', minimum: 1 },
                providerFeeInPaise: { bsonType: 'number', minimum: 0 },
                currency: { enum: ['INR'] },
                status: { enum: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] },
                providerRefundId: { bsonType: 'string', minLength: 1, maxLength: 100 },
                acquirerReference: { bsonType: 'string', minLength: 1, maxLength: 160 },
                reason: { bsonType: 'string', minLength: 1, maxLength: 500 },
                requestedBy: { bsonType: 'objectId' },
                failureCode: { bsonType: 'string', minLength: 1, maxLength: 120 },
                failureDescription: { bsonType: 'string', minLength: 1, maxLength: 1000 },
                processedAt: { bsonType: 'date' },
                lastReconciledAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $and: [
                positiveSafeInteger('$amountInPaise'),
                nonNegativeSafeInteger('$providerFeeInPaise'),
                {
                  $or: [
                    { $in: ['$status', ['PENDING', 'FAILED']] },
                    { $eq: [{ $type: '$providerRefundId' }, 'string'] },
                  ],
                },
                {
                  $or: [
                    { $in: ['$status', ['PENDING', 'PROCESSING']] },
                    { $eq: [{ $type: '$processedAt' }, 'date'] },
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
