import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import {
  AuditActorType,
  CouponDiscountType,
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  ShipmentStatus,
  ShippingProvider,
} from '../../domain/enums';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../value-validators';
import { ProductAttribute, ProductAttributeSchema } from './catalog.schema';

@Schema(embeddedSchemaOptions)
export class CustomerSnapshot {
  @Prop({ trim: true, maxlength: 120 })
  name?: string;

  @Prop({ trim: true, lowercase: true, maxlength: 254 })
  email?: string;

  @Prop({ trim: true, match: /^\+?[1-9]\d{7,14}$/ })
  mobile?: string;
}

export const CustomerSnapshotSchema = SchemaFactory.createForClass(CustomerSnapshot);

@Schema(embeddedSchemaOptions)
export class AddressSnapshot {
  @Prop({ required: true, trim: true, maxlength: 120 })
  fullName!: string;

  @Prop({ required: true, trim: true, match: /^\+?[1-9]\d{7,14}$/ })
  phone!: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  line1!: string;

  @Prop({ trim: true, maxlength: 200 })
  line2?: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  city!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  state!: string;

  @Prop({ required: true, trim: true, match: /^\d{6}$/ })
  postalCode!: string;

  @Prop({ required: true, uppercase: true, minlength: 2, maxlength: 2, default: 'IN' })
  countryCode!: string;
}

export const AddressSnapshotSchema = SchemaFactory.createForClass(AddressSnapshot);

@Schema(embeddedSchemaOptions)
export class OrderItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 180 })
  productName!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 220 })
  productSlug!: string;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 100 })
  sku!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  variantTitle!: string;

  @Prop({ type: [ProductAttributeSchema], default: [] })
  attributes!: ProductAttribute[];

  @Prop({ trim: true, maxlength: 500 })
  imageStorageKey?: string;

  @Prop({ type: Number, required: true, validate: isNonNegativeSafeInteger })
  unitPriceInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  discountInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  taxInPaise!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  quantity!: number;

  @Prop({ type: Number, required: true, validate: isNonNegativeSafeInteger })
  lineTotalInPaise!: number;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema(embeddedSchemaOptions)
export class OrderTotals {
  @Prop({ type: Number, required: true, validate: isNonNegativeSafeInteger })
  subtotalInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  itemDiscountInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  couponDiscountInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  shippingInPaise!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  taxInPaise!: number;

  @Prop({ type: Number, required: true, validate: isNonNegativeSafeInteger })
  grandTotalInPaise!: number;
}

export const OrderTotalsSchema = SchemaFactory.createForClass(OrderTotals);

@Schema(embeddedSchemaOptions)
export class OrderCouponSnapshot {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coupon', required: true })
  couponId!: Types.ObjectId;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 32 })
  code!: string;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name!: string;

  @Prop({ required: true, enum: CouponDiscountType })
  discountType!: CouponDiscountType;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  configuredValue!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  discountInPaise!: number;
}

export const OrderCouponSnapshotSchema = SchemaFactory.createForClass(OrderCouponSnapshot);

@Schema(embeddedSchemaOptions)
export class OrderStatusEntry {
  @Prop({ required: true, trim: true, maxlength: 50 })
  dimension!: string;

  @Prop({ trim: true, maxlength: 50 })
  from?: string;

  @Prop({ required: true, trim: true, maxlength: 50 })
  to!: string;

  @Prop({ trim: true, maxlength: 500 })
  reason?: string;

  @Prop({ enum: AuditActorType, required: true })
  actorType!: AuditActorType;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  actorId?: Types.ObjectId;

  @Prop({ required: true, default: () => new Date() })
  occurredAt!: Date;
}

export const OrderStatusEntrySchema = SchemaFactory.createForClass(OrderStatusEntry);

@Schema(embeddedSchemaOptions)
export class ShipmentTrackingEvent {
  @Prop({ enum: ShipmentStatus, required: true })
  status!: ShipmentStatus;

  @Prop({ required: true, trim: true, maxlength: 240 })
  message!: string;

  @Prop({ trim: true, maxlength: 160 })
  location?: string;

  @Prop({ enum: AuditActorType, required: true })
  actorType!: AuditActorType;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  actorId?: Types.ObjectId;

  @Prop({ required: true })
  occurredAt!: Date;
}

export const ShipmentTrackingEventSchema = SchemaFactory.createForClass(ShipmentTrackingEvent);

@Schema(embeddedSchemaOptions)
export class ShippingDetails {
  @Prop({ enum: ShippingProvider, required: true, default: ShippingProvider.Manual })
  provider!: ShippingProvider;

  @Prop({ enum: ShipmentStatus, required: true })
  status!: ShipmentStatus;

  @Prop({ required: true, trim: true, maxlength: 100 })
  courierName!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  trackingNumber!: string;

  @Prop({ trim: true, maxlength: 500, match: /^https:\/\/[^\s]+$/i })
  trackingUrl?: string;

  @Prop({ trim: true, maxlength: 100 })
  serviceLevel?: string;

  @Prop()
  estimatedDeliveryAt?: Date;

  @Prop({ type: [ShipmentTrackingEventSchema], required: true })
  trackingEvents!: ShipmentTrackingEvent[];

  @Prop({ required: true })
  lastEventAt!: Date;

  @Prop()
  shippedAt?: Date;

  @Prop()
  deliveredAt?: Date;
}

export const ShippingDetailsSchema = SchemaFactory.createForClass(ShippingDetails);

@Schema({ ...rootSchemaOptions, collection: 'orders' })
export class Order {
  @Prop({ required: true, uppercase: true, trim: true, maxlength: 40 })
  orderNumber!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  idempotencyKey!: string;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  idempotencyRequestHash!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Cart', required: true })
  sourceCartId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ type: CustomerSnapshotSchema, required: true })
  customer!: CustomerSnapshot;

  @Prop({ type: AddressSnapshotSchema, required: true })
  shippingAddress!: AddressSnapshot;

  @Prop({ type: [OrderItemSchema], required: true })
  items!: OrderItem[];

  @Prop({ type: OrderTotalsSchema, required: true })
  totals!: OrderTotals;

  @Prop({ type: OrderCouponSnapshotSchema })
  coupon?: OrderCouponSnapshot;

  @Prop({ required: true, uppercase: true, enum: ['INR'], default: 'INR' })
  currency!: 'INR';

  @Prop({ enum: OrderLifecycleStatus, default: OrderLifecycleStatus.PendingPayment })
  lifecycleStatus!: OrderLifecycleStatus;

  @Prop({ enum: FinancialStatus, default: FinancialStatus.Unpaid })
  financialStatus!: FinancialStatus;

  @Prop({ enum: FulfillmentStatus, default: FulfillmentStatus.Unfulfilled })
  fulfillmentStatus!: FulfillmentStatus;

  @Prop({ required: true })
  paymentExpiresAt!: Date;

  @Prop({ type: [OrderStatusEntrySchema], default: [] })
  statusHistory!: OrderStatusEntry[];

  @Prop({ type: ShippingDetailsSchema })
  shipping?: ShippingDetails;

  @Prop({ trim: true, maxlength: 2000 })
  adminNote?: string;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  returnAllocationRevision!: number;
}

export type OrderDocument = HydratedDocument<Order>;
export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ orderNumber: 1 }, { unique: true, name: 'uq_orders_number' });
OrderSchema.index({ idempotencyKey: 1 }, { unique: true, name: 'uq_orders_idempotency' });
OrderSchema.index({ customerId: 1, createdAt: -1 }, { name: 'ix_orders_customer_created' });
OrderSchema.index(
  { customerId: 1, lifecycleStatus: 1, createdAt: -1 },
  { name: 'ix_orders_customer_lifecycle_created' },
);
OrderSchema.index({ 'customer.mobile': 1, createdAt: -1 }, { name: 'ix_orders_mobile_created' });
OrderSchema.index({ 'customer.email': 1, createdAt: -1 }, { name: 'ix_orders_email_created' });
OrderSchema.index(
  { lifecycleStatus: 1, financialStatus: 1, createdAt: -1 },
  { name: 'ix_orders_lifecycle_financial_created' },
);
OrderSchema.index(
  { fulfillmentStatus: 1, createdAt: -1 },
  { name: 'ix_orders_fulfillment_created' },
);
OrderSchema.index(
  { 'shipping.status': 1, 'shipping.lastEventAt': 1 },
  {
    partialFilterExpression: { 'shipping.status': { $type: 'string' } },
    name: 'ix_orders_shipment_status_last_event',
  },
);
OrderSchema.index(
  { 'shipping.courierName': 1, 'shipping.trackingNumber': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'shipping.courierName': { $type: 'string' },
      'shipping.trackingNumber': { $type: 'string' },
    },
    name: 'uq_orders_courier_tracking_when_present',
  },
);
OrderSchema.index(
  { lifecycleStatus: 1, paymentExpiresAt: 1 },
  { name: 'ix_orders_payment_expiry' },
);
OrderSchema.pre('validate', function validateOrderInvariants(): void {
  if (this.items.length === 0) {
    this.invalidate('items', 'An order must contain at least one item');
  }

  if (!this.customer.email && !this.customer.mobile) {
    this.invalidate('customer', 'Customer email or mobile is required');
  }

  const calculatedSubtotal = this.items.reduce(
    (total, item) => total + item.unitPriceInPaise * item.quantity,
    0,
  );
  if (calculatedSubtotal !== this.totals.subtotalInPaise) {
    this.invalidate('totals.subtotalInPaise', 'Subtotal does not match order items');
  }

  const calculatedGrandTotal =
    this.totals.subtotalInPaise -
    this.totals.itemDiscountInPaise -
    this.totals.couponDiscountInPaise +
    this.totals.shippingInPaise +
    this.totals.taxInPaise;
  if (calculatedGrandTotal !== this.totals.grandTotalInPaise) {
    this.invalidate('totals.grandTotalInPaise', 'Grand total breakdown is inconsistent');
  }

  if (Boolean(this.coupon) !== this.totals.couponDiscountInPaise > 0) {
    this.invalidate('coupon', 'Coupon snapshot must match the coupon discount total');
  }
  if (this.coupon?.discountInPaise !== undefined) {
    if (this.coupon.discountInPaise !== this.totals.couponDiscountInPaise) {
      this.invalidate('coupon.discountInPaise', 'Coupon snapshot discount is inconsistent');
    }
  }

  for (const [index, item] of this.items.entries()) {
    const expectedLineTotal =
      item.unitPriceInPaise * item.quantity - item.discountInPaise + item.taxInPaise;
    if (expectedLineTotal !== item.lineTotalInPaise) {
      this.invalidate(`items.${index}.lineTotalInPaise`, 'Line total is inconsistent');
    }
  }

  if (this.shipping) {
    if (!this.shipping.trackingEvents.length || this.shipping.trackingEvents.length > 100) {
      this.invalidate(
        'shipping.trackingEvents',
        'Shipment tracking must contain between 1 and 100 events',
      );
    }
    const lastEvent = this.shipping.trackingEvents.at(-1);
    if (lastEvent?.status !== this.shipping.status) {
      this.invalidate('shipping.status', 'Shipment status must match its latest tracking event');
    }
    if (lastEvent?.occurredAt?.getTime() !== this.shipping.lastEventAt?.getTime()) {
      this.invalidate('shipping.lastEventAt', 'Shipment last event timestamp is inconsistent');
    }
    if (this.shipping.status !== ShipmentStatus.ReadyToShip && !this.shipping.shippedAt) {
      this.invalidate('shipping.shippedAt', 'Dispatched shipments require a shipped timestamp');
    }
    if (
      (this.shipping.status === ShipmentStatus.Delivered) !==
      Boolean(this.shipping.deliveredAt)
    ) {
      this.invalidate('shipping.deliveredAt', 'Delivered timestamp must match shipment status');
    }
  }
});
