import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { PaymentAttemptStatus, PaymentProvider, RefundStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'payment_attempts' })
export class PaymentAttempt {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ required: true, uppercase: true, trim: true, maxlength: 40 })
  orderNumber!: string;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  attemptNumber!: number;

  @Prop({ required: true, trim: true, maxlength: 160 })
  idempotencyKey!: string;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  idempotencyRequestHash!: string;

  @Prop({ enum: PaymentProvider, default: PaymentProvider.Razorpay })
  provider!: PaymentProvider;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  amountInPaise!: number;

  @Prop({ required: true, uppercase: true, enum: ['INR'], default: 'INR' })
  currency!: 'INR';

  @Prop({ enum: PaymentAttemptStatus, default: PaymentAttemptStatus.Creating })
  status!: PaymentAttemptStatus;

  @Prop({ required: true, uppercase: true, trim: true, maxlength: 40 })
  providerReceipt!: string;

  @Prop({ trim: true, maxlength: 100 })
  providerOrderId?: string;

  @Prop({ trim: true, maxlength: 100 })
  providerPaymentId?: string;

  @Prop({ trim: true, maxlength: 120 })
  failureCode?: string;

  @Prop({ trim: true, maxlength: 1000 })
  failureDescription?: string;

  @Prop()
  signatureVerifiedAt?: Date;

  @Prop()
  authorizedAt?: Date;

  @Prop()
  capturedAt?: Date;

  @Prop()
  lastFailureAt?: Date;

  @Prop()
  lastReconciledAt?: Date;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  refundedInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  refundPendingInPaise!: number;
}

export type PaymentAttemptDocument = HydratedDocument<PaymentAttempt>;
export const PaymentAttemptSchema = SchemaFactory.createForClass(PaymentAttempt);
PaymentAttemptSchema.index(
  { orderId: 1, attemptNumber: 1 },
  { unique: true, name: 'uq_payment_attempts_order_attempt' },
);
PaymentAttemptSchema.index(
  { idempotencyKey: 1 },
  { unique: true, name: 'uq_payment_attempts_idempotency' },
);
PaymentAttemptSchema.index(
  { orderId: 1, provider: 1 },
  { unique: true, name: 'uq_payment_attempts_order_provider' },
);
PaymentAttemptSchema.index(
  { providerReceipt: 1 },
  { unique: true, name: 'uq_payment_attempts_provider_receipt' },
);
PaymentAttemptSchema.index(
  { providerOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerOrderId: { $type: 'string' } },
    name: 'uq_payment_attempts_provider_order_when_present',
  },
);
PaymentAttemptSchema.index(
  { providerPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerPaymentId: { $type: 'string' } },
    name: 'uq_payment_attempts_provider_payment_when_present',
  },
);
PaymentAttemptSchema.index({ status: 1, updatedAt: 1 }, { name: 'ix_payment_attempts_reconcile' });
PaymentAttemptSchema.index(
  { status: 1, lastReconciledAt: 1, updatedAt: 1 },
  { name: 'ix_payment_attempts_reconcile_v2' },
);
PaymentAttemptSchema.index(
  { status: 1, capturedAt: 1 },
  { name: 'ix_payment_attempts_status_captured' },
);

@Schema({ ...rootSchemaOptions, collection: 'refunds' })
export class Refund {
  @Prop({ required: true, uppercase: true, trim: true, maxlength: 40 })
  refundNumber!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: PaymentAttempt.name, required: true })
  paymentAttemptId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 160 })
  idempotencyKey!: string;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  idempotencyRequestHash!: string;

  @Prop({ enum: PaymentProvider, default: PaymentProvider.Razorpay })
  provider!: PaymentProvider;

  @Prop({ required: true, uppercase: true, trim: true, maxlength: 40 })
  providerReceipt!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  providerPaymentId!: string;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  amountInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  providerFeeInPaise!: number;

  @Prop({ required: true, uppercase: true, enum: ['INR'], default: 'INR' })
  currency!: 'INR';

  @Prop({ enum: RefundStatus, default: RefundStatus.Pending })
  status!: RefundStatus;

  @Prop({ trim: true, maxlength: 100 })
  providerRefundId?: string;

  @Prop({ trim: true, maxlength: 160 })
  acquirerReference?: string;

  @Prop({ required: true, trim: true, maxlength: 500 })
  reason!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser', required: true })
  requestedBy!: Types.ObjectId;

  @Prop()
  processedAt?: Date;

  @Prop({ trim: true, maxlength: 1000 })
  failureDescription?: string;

  @Prop({ trim: true, maxlength: 120 })
  failureCode?: string;

  @Prop()
  lastReconciledAt?: Date;
}

export type RefundDocument = HydratedDocument<Refund>;
export const RefundSchema = SchemaFactory.createForClass(Refund);
RefundSchema.index({ refundNumber: 1 }, { unique: true, name: 'uq_refunds_number' });
RefundSchema.index({ idempotencyKey: 1 }, { unique: true, name: 'uq_refunds_idempotency' });
RefundSchema.index({ providerReceipt: 1 }, { unique: true, name: 'uq_refunds_provider_receipt' });
RefundSchema.index(
  { providerRefundId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerRefundId: { $type: 'string' } },
    name: 'uq_refunds_provider_refund_when_present',
  },
);
RefundSchema.index({ orderId: 1, createdAt: -1 }, { name: 'ix_refunds_order_created' });
RefundSchema.index({ status: 1, updatedAt: 1 }, { name: 'ix_refunds_reconcile' });
RefundSchema.index(
  { status: 1, lastReconciledAt: 1, updatedAt: 1 },
  { name: 'ix_refunds_reconcile_v2' },
);
RefundSchema.index({ status: 1, processedAt: 1 }, { name: 'ix_refunds_status_processed' });
