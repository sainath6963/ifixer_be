import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { InventoryMovementType, InventoryReservationStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isSignedSafeInteger,
} from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'inventory_levels' })
export class InventoryLevel {
  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger }) repairConsumed!: number;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ required: true, uppercase: true, trim: true, maxlength: 100 })
  sku!: string;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  onHand!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  reserved!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  sold!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  reorderPoint!: number;
}

export type InventoryLevelDocument = HydratedDocument<InventoryLevel>;
export const InventoryLevelSchema = SchemaFactory.createForClass(InventoryLevel);
InventoryLevelSchema.index({ variantId: 1 }, { unique: true, name: 'uq_inventory_levels_variant' });
InventoryLevelSchema.index({ sku: 1 }, { unique: true, name: 'uq_inventory_levels_sku' });
InventoryLevelSchema.index({ productId: 1 }, { name: 'ix_inventory_levels_product' });
InventoryLevelSchema.index({ onHand: 1, reserved: 1 }, { name: 'ix_inventory_levels_stock' });
InventoryLevelSchema.virtual('available').get(function availableStock(): number {
  return this.onHand - this.reserved;
});
InventoryLevelSchema.pre('validate', function validateInventoryBounds(): void {
  if (this.reserved > this.onHand) {
    this.invalidate('reserved', 'Reserved stock cannot exceed on-hand stock');
  }
});

@Schema({ ...rootSchemaOptions, collection: 'inventory_reservations' })
export class InventoryReservation {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'RepairJob' }) repairJobId?: Types.ObjectId;
  @Prop({ required: true, trim: true, maxlength: 100 })
  reservationGroupId!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ReturnRequest' })
  returnRequestId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  quantity!: number;

  @Prop({ enum: InventoryReservationStatus, default: InventoryReservationStatus.Active })
  status!: InventoryReservationStatus;

  @Prop()
  expiresAt?: Date;

  @Prop()
  finalizedAt?: Date;
}

export type InventoryReservationDocument = HydratedDocument<InventoryReservation>;
export const InventoryReservationSchema = SchemaFactory.createForClass(InventoryReservation);
InventoryReservationSchema.index(
  { reservationGroupId: 1, variantId: 1 },
  { unique: true, name: 'uq_inventory_reservations_group_variant' },
);
InventoryReservationSchema.index(
  { returnRequestId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { returnRequestId: { $type: 'objectId' } },
    name: 'uq_inventory_reservations_return_variant',
  },
);
InventoryReservationSchema.index(
  { returnRequestId: 1, status: 1 },
  {
    partialFilterExpression: { returnRequestId: { $type: 'objectId' } },
    name: 'ix_inventory_reservations_return_status',
  },
);
InventoryReservationSchema.pre('validate', function validateReservationSource(): void {
  if ([this.orderId, this.returnRequestId, this.repairJobId].filter(Boolean).length !== 1)
    this.invalidate(
      'orderId',
      'A reservation must have exactly one order, return or repair job source',
    );
  if (this.repairJobId ? this.expiresAt !== undefined : !this.expiresAt)
    this.invalidate('expiresAt', 'Only retail reservations require an expiry');
});
InventoryReservationSchema.index(
  { status: 1, expiresAt: 1 },
  { name: 'ix_inventory_reservations_expiry_worker' },
);
InventoryReservationSchema.index({ orderId: 1 }, { name: 'ix_inventory_reservations_order' });
InventoryReservationSchema.index(
  { orderId: 1, status: 1 },
  { name: 'ix_inventory_reservations_order_status' },
);

@Schema({ ...rootSchemaOptions, collection: 'inventory_movements' })
export class InventoryMovement {
  @Prop({ type: MongooseSchema.Types.ObjectId }) partId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) repairJobId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) purchaseId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) lotId?: Types.ObjectId;
  @Prop({ maxlength: 100 }) sku?: string;
  @Prop({ validate: isSignedSafeInteger }) deltaConsumed?: number;
  @Prop({ validate: isNonNegativeSafeInteger }) costInPaise?: number;
  @Prop({ validate: isNonNegativeSafeInteger }) unknownCostQuantity?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ enum: InventoryMovementType, required: true })
  type!: InventoryMovementType;

  @Prop({ type: Number, required: true, validate: isSignedSafeInteger })
  deltaOnHand!: number;

  @Prop({ type: Number, required: true, validate: isSignedSafeInteger })
  deltaReserved!: number;

  @Prop({ type: Number, required: true, validate: isSignedSafeInteger })
  deltaSold!: number;

  @Prop({ required: true, trim: true, maxlength: 50 })
  referenceType!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  referenceId!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  actorId?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 500 })
  note?: string;
}

export type InventoryMovementDocument = HydratedDocument<InventoryMovement>;
export const InventoryMovementSchema = SchemaFactory.createForClass(InventoryMovement);
InventoryMovementSchema.index(
  { variantId: 1, createdAt: -1 },
  { name: 'ix_inventory_movements_variant_created' },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      referenceType: {
        $in: [
          'EXCHANGE_REPLACEMENT_RESERVE',
          'EXCHANGE_REPLACEMENT_COMMIT',
          'EXCHANGE_REPLACEMENT_EXPIRE',
        ],
      },
    },
    name: 'uq_inventory_movements_exchange_transition',
  },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      referenceType: {
        $in: ['CHECKOUT_RESERVATION', 'ORDER_CANCEL_RELEASE', 'ORDER_EXPIRY_RELEASE'],
      },
    },
    name: 'uq_inventory_movements_checkout_transition',
  },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { referenceType: 'RETURN_REQUEST_RECEIPT' },
    name: 'uq_inventory_movements_return_receipt',
  },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { referenceType: 'PAYMENT_CAPTURE_COMMIT' },
    name: 'uq_inventory_movements_payment_capture',
  },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { referenceType: 'ORDER_FULFILLMENT_RESTOCK' },
    name: 'uq_inventory_movements_fulfillment_restock',
  },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1 },
  { name: 'ix_inventory_movements_reference' },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { referenceType: 'ADMIN_ADJUSTMENT' },
    name: 'uq_inventory_movements_admin_adjustment',
  },
);

InventoryReservationSchema.index(
  { repairJobId: 1, status: 1 },
  { name: 'ix_inventory_reservation_repair' },
);
InventoryMovementSchema.index(
  { referenceType: 1, referenceId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'REPAIR' },
    name: 'uq_inventory_repair_operation',
  },
);
InventoryMovementSchema.index(
  { repairJobId: 1, createdAt: -1 },
  { name: 'ix_inventory_repair_job' },
);
InventoryMovementSchema.index(
  { partId: 1, createdAt: -1, _id: -1 },
  { name: 'ix_inventory_repair_part' },
);
