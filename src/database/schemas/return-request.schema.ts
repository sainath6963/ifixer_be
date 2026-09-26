import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import {
  AuditActorType,
  ExchangeReservationStatus,
  ReturnReason,
  ReturnRequestStatus,
  ReturnRequestType,
  ReturnResolutionType,
} from '../../domain/enums';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../value-validators';
import { ProductAttribute, ProductAttributeSchema } from './catalog.schema';

@Schema(embeddedSchemaOptions)
export class RequestedExchangeVariant {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 100 })
  sku!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  title!: string;

  @Prop({ type: [ProductAttributeSchema], default: [] })
  attributes!: ProductAttribute[];
}

export const RequestedExchangeVariantSchema =
  SchemaFactory.createForClass(RequestedExchangeVariant);

@Schema(embeddedSchemaOptions)
export class ReturnRequestItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 180 })
  productName!: string;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 100 })
  sku!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  variantTitle!: string;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  quantity!: number;

  @Prop({ enum: ReturnReason, required: true })
  reason!: ReturnReason;

  @Prop({ trim: true, maxlength: 1000 })
  reasonDetail?: string;

  @Prop({ type: RequestedExchangeVariantSchema })
  requestedExchangeVariant?: RequestedExchangeVariant;

  @Prop({ type: Number, required: true, validate: isNonNegativeSafeInteger })
  estimatedValueInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  restockedQuantity!: number;
}

export const ReturnRequestItemSchema = SchemaFactory.createForClass(ReturnRequestItem);

@Schema(embeddedSchemaOptions)
export class ReturnRequestStatusHistory {
  @Prop({ enum: ReturnRequestStatus, required: true })
  status!: ReturnRequestStatus;

  @Prop({ enum: AuditActorType, required: true })
  actorType!: AuditActorType;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  actorId?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 1000 })
  message?: string;

  @Prop({ required: true })
  occurredAt!: Date;
}

export const ReturnRequestStatusHistorySchema = SchemaFactory.createForClass(
  ReturnRequestStatusHistory,
);

@Schema(embeddedSchemaOptions)
export class ReturnRequestResolution {
  @Prop({ enum: ReturnResolutionType, required: true })
  type!: ReturnResolutionType;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Refund' })
  refundId?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 100 })
  courierName?: string;

  @Prop({ trim: true, maxlength: 160 })
  trackingNumber?: string;

  @Prop({ trim: true, maxlength: 500 })
  trackingUrl?: string;
}

export const ReturnRequestResolutionSchema = SchemaFactory.createForClass(ReturnRequestResolution);

@Schema({ ...rootSchemaOptions, collection: 'return_requests' })
export class ReturnRequest {
  @Prop({ required: true, trim: true, uppercase: true, maxlength: 40 })
  returnNumber!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 40 })
  orderNumber!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ enum: ReturnRequestType, required: true })
  type!: ReturnRequestType;

  @Prop({ enum: ReturnRequestStatus, default: ReturnRequestStatus.Requested })
  status!: ReturnRequestStatus;

  @Prop({ type: [ReturnRequestItemSchema], required: true })
  items!: ReturnRequestItem[];

  @Prop({ trim: true, maxlength: 1000 })
  customerNote?: string;

  @Prop({ trim: true, maxlength: 1000 })
  customerMessage?: string;

  @Prop({ trim: true, maxlength: 2000 })
  internalNote?: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  idempotencyKey!: string;

  @Prop({ required: true, match: /^[a-f0-9]{64}$/ })
  idempotencyRequestHash!: string;

  @Prop({ required: true })
  requestedAt!: Date;

  @Prop()
  decidedAt?: Date;

  @Prop()
  receivedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  cancelledAt?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser' })
  lastAdminId?: Types.ObjectId;

  @Prop({ type: ReturnRequestResolutionSchema })
  resolution?: ReturnRequestResolution;

  @Prop({ type: [ReturnRequestStatusHistorySchema], required: true })
  statusHistory!: ReturnRequestStatusHistory[];

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  evidenceCount!: number;

  @Prop({ enum: ExchangeReservationStatus })
  exchangeReservationStatus?: ExchangeReservationStatus;

  @Prop()
  exchangeReservationExpiresAt?: Date;

  @Prop()
  exchangeReservationFinalizedAt?: Date;
}

export type ReturnRequestDocument = HydratedDocument<ReturnRequest>;
export const ReturnRequestSchema = SchemaFactory.createForClass(ReturnRequest);
ReturnRequestSchema.index({ returnNumber: 1 }, { unique: true, name: 'uq_return_requests_number' });
ReturnRequestSchema.index(
  { customerId: 1, idempotencyKey: 1 },
  { unique: true, name: 'uq_return_requests_customer_idempotency' },
);
ReturnRequestSchema.index(
  { status: 1, exchangeReservationStatus: 1, exchangeReservationExpiresAt: 1, _id: 1 },
  {
    partialFilterExpression: { exchangeReservationStatus: ExchangeReservationStatus.Active },
    name: 'ix_return_requests_exchange_reservation_expiry',
  },
);
ReturnRequestSchema.index(
  { orderId: 1, status: 1, createdAt: -1 },
  { name: 'ix_return_requests_order_status' },
);
ReturnRequestSchema.index(
  { customerId: 1, createdAt: -1, _id: -1 },
  { name: 'ix_return_requests_customer_created' },
);
ReturnRequestSchema.index(
  { status: 1, createdAt: -1, _id: -1 },
  { name: 'ix_return_requests_admin_queue' },
);
ReturnRequestSchema.index(
  { 'resolution.refundId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'resolution.refundId': { $type: 'objectId' } },
    name: 'uq_return_requests_resolution_refund',
  },
);
ReturnRequestSchema.pre('validate', function validateReturnRequest(): void {
  if (!this.items.length) this.invalidate('items', 'At least one return item is required');
  const variantIds = this.items.map((item) => item.variantId.toHexString());
  if (new Set(variantIds).size !== variantIds.length) {
    this.invalidate('items', 'Each ordered variant may appear only once');
  }
  for (const item of this.items) {
    if (item.restockedQuantity > item.quantity) {
      this.invalidate('items', 'Restocked quantity cannot exceed requested quantity');
    }
    if (this.type === ReturnRequestType.Exchange && !item.requestedExchangeVariant) {
      this.invalidate('items', 'An exchange target is required for every exchange item');
    }
    if (this.type === ReturnRequestType.Return && item.requestedExchangeVariant) {
      this.invalidate('items', 'Return items cannot contain exchange targets');
    }
  }
  if (this.exchangeReservationStatus && this.type !== ReturnRequestType.Exchange) {
    this.invalidate('exchangeReservationStatus', 'Only exchanges can reserve replacement stock');
  }
  if (
    this.exchangeReservationStatus === ExchangeReservationStatus.Active &&
    (!this.exchangeReservationExpiresAt || this.exchangeReservationFinalizedAt)
  ) {
    this.invalidate('exchangeReservationStatus', 'Active exchange reservations require an expiry');
  }
  if (
    this.exchangeReservationStatus &&
    this.exchangeReservationStatus !== ExchangeReservationStatus.Active &&
    !this.exchangeReservationFinalizedAt
  ) {
    this.invalidate(
      'exchangeReservationStatus',
      'Finalized exchange reservations require a finalized time',
    );
  }
});
