import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';
const id = { type: MongoSchema.Types.ObjectId, required: true };
const quantity = {
  type: Number,
  required: true,
  min: 0,
  max: 1000000,
  validate: isNonNegativeSafeInteger,
};
const money = { type: Number, min: 0, max: 1000000000, validate: isNonNegativeSafeInteger };
const embedded = { ...embeddedSchemaOptions, versionKey: false as const };

@Schema({ ...rootSchemaOptions, collection: 'repair_suppliers' })
export class RepairSupplier {
  @Prop({ required: true, maxlength: 120 }) name!: string;
  @Prop({ required: true, maxlength: 40, uppercase: true, match: /^[A-Z0-9][A-Z0-9_-]*$/ })
  code!: string;
  @Prop({ maxlength: 120 }) contactName?: string;
  @Prop({ maxlength: 20 }) phone?: string;
  @Prop({ maxlength: 254 }) email?: string;
  @Prop({ maxlength: 1000 }) address?: string;
  @Prop({ required: true, default: true }) active!: boolean;
}
export const RepairSupplierSchema = SchemaFactory.createForClass(RepairSupplier);
RepairSupplierSchema.index({ code: 1 }, { unique: true, name: 'uq_repair_supplier_code' });

@Schema({ ...rootSchemaOptions, collection: 'spare_part_profiles' })
export class SparePartProfile {
  @Prop(id) productId!: Types.ObjectId;
  @Prop(id) variantId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 100, uppercase: true }) sku!: string;
  @Prop({ required: true, maxlength: 160 }) name!: string;
  @Prop({ required: true, maxlength: 120 }) quality!: string;
  @Prop({ type: [MongoSchema.Types.ObjectId], default: [] }) modelIds!: Types.ObjectId[];
  @Prop({ type: [String], default: [] }) modelLabels!: string[];
  @Prop({ type: MongoSchema.Types.ObjectId }) supplierId?: Types.ObjectId;
  @Prop({ maxlength: 120 }) bin?: string;
  @Prop(money) referenceCostInPaise?: number;
  @Prop({ ...money, required: true }) customerPriceInPaise!: number;
  @Prop({ required: true, default: true }) active!: boolean;
  @Prop({ required: true, default: false }) openingRecorded!: boolean;
}
export const SparePartProfileSchema = SchemaFactory.createForClass(SparePartProfile);
SparePartProfileSchema.index({ sku: 1 }, { unique: true, name: 'uq_spare_part_sku' });
SparePartProfileSchema.index({ variantId: 1 }, { unique: true, name: 'uq_spare_part_variant' });
SparePartProfileSchema.index({ modelIds: 1, active: 1 }, { name: 'ix_spare_part_models' });

@Schema({ ...rootSchemaOptions, collection: 'repair_stock_lots' })
export class RepairStockLot {
  @Prop(id) partId!: Types.ObjectId;
  @Prop({ required: true, enum: ['OPENING', 'RECEIPT', 'ADJUST_IN'] }) source!: string;
  @Prop({ required: true, maxlength: 100 }) sourceId!: string;
  @Prop({ type: MongoSchema.Types.ObjectId }) supplierId?: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId }) purchaseId?: Types.ObjectId;
  @Prop({ ...quantity, min: 1 }) quantity!: number;
  @Prop(quantity) remaining!: number;
  @Prop(money) unitCostInPaise?: number;
}
export const RepairStockLotSchema = SchemaFactory.createForClass(RepairStockLot);
RepairStockLotSchema.index({ partId: 1, createdAt: 1, _id: 1 }, { name: 'ix_repair_lot_fifo' });
RepairStockLotSchema.index(
  { sourceId: 1, partId: 1 },
  { unique: true, name: 'uq_repair_lot_source' },
);

@Schema(embedded)
export class RepairPurchaseLine {
  @Prop(id) partId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 100 }) sku!: string;
  @Prop({ required: true, maxlength: 160 }) name!: string;
  @Prop({ ...quantity, min: 1 }) ordered!: number;
  @Prop({ ...quantity, default: 0 }) received!: number;
  @Prop({ ...money, required: true }) unitCostInPaise!: number;
}
@Schema({ ...rootSchemaOptions, collection: 'repair_purchases' })
export class RepairPurchase {
  @Prop({ required: true, match: /^PO-[A-F0-9]{16}$/ }) number!: string;
  @Prop(id) supplierId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) supplierName!: string;
  @Prop({ required: true, enum: ['OPEN', 'PARTIAL', 'RECEIVED', 'CANCELLED'], default: 'OPEN' })
  status!: string;
  @Prop({ type: [SchemaFactory.createForClass(RepairPurchaseLine)], required: true })
  lines!: RepairPurchaseLine[];
  @Prop({ required: true, maxlength: 1000 }) note!: string;
  @Prop({ maxlength: 1000 }) cancellationReason?: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) createdBy!: Types.ObjectId;
}
export const RepairPurchaseSchema = SchemaFactory.createForClass(RepairPurchase);
RepairPurchaseSchema.index({ number: 1 }, { unique: true, name: 'uq_repair_purchase_number' });
RepairPurchaseSchema.index({ createdAt: -1, _id: -1 }, { name: 'ix_repair_purchase_queue' });

@Schema(embedded)
export class RepairReceiptLine {
  @Prop(id) partId!: Types.ObjectId;
  @Prop({ ...quantity, max: 29 }) lineIndex!: number;
  @Prop({ ...quantity, min: 1 }) quantity!: number;
  @Prop({ ...money, required: true }) unitCostInPaise!: number;
}
@Schema({ ...rootSchemaOptions, collection: 'repair_goods_receipts' })
export class RepairGoodsReceipt {
  @Prop(id) purchaseId!: Types.ObjectId;
  @Prop(id) supplierId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) reference!: string;
  @Prop({ required: true, maxlength: 1000 }) note!: string;
  @Prop({ type: [SchemaFactory.createForClass(RepairReceiptLine)], required: true })
  lines!: RepairReceiptLine[];
  @Prop(id) receivedBy!: Types.ObjectId;
}
export const RepairGoodsReceiptSchema = SchemaFactory.createForClass(RepairGoodsReceipt);
RepairGoodsReceiptSchema.index(
  { purchaseId: 1, createdAt: -1 },
  { name: 'ix_repair_receipt_purchase' },
);

@Schema(embedded)
export class RepairCostAllocation {
  @Prop(id) lotId!: Types.ObjectId;
  @Prop({ ...quantity, min: 1 }) quantity!: number;
  @Prop(money) unitCostInPaise?: number;
  @Prop({ ...quantity, default: 0 }) returnedUsable!: number;
  @Prop({ ...quantity, default: 0 }) returnedDamaged!: number;
}
@Schema({ ...rootSchemaOptions, collection: 'repair_part_usages' })
export class RepairPartUsage {
  @Prop(id) jobId!: Types.ObjectId;
  @Prop({ required: true }) jobNumber!: string;
  @Prop(id) partId!: Types.ObjectId;
  @Prop(id) reservationId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 100 }) sku!: string;
  @Prop({ required: true, maxlength: 160 }) name!: string;
  @Prop({ ...quantity, min: 1 }) quantity!: number;
  @Prop({ ...quantity, min: 1, max: 100 }) estimateRevision!: number;
  @Prop({ ...money, required: true }) customerPriceInPaise!: number;
  @Prop({ required: true, enum: ['RESERVED', 'CONSUMED', 'RELEASED'], default: 'RESERVED' })
  status!: string;
  @Prop({ required: true, maxlength: 500 }) compatibilityNote!: string;
  @Prop({ required: true, maxlength: 500 }) note!: string;
  @Prop({ type: [SchemaFactory.createForClass(RepairCostAllocation)], default: [] })
  allocations!: RepairCostAllocation[];
  @Prop() consumedAt?: Date;
  @Prop() releasedAt?: Date;
  @Prop({ ...quantity, default: 0 }) returnedUsable!: number;
  @Prop({ ...quantity, default: 0 }) returnedDamaged!: number;
}
export const RepairPartUsageSchema = SchemaFactory.createForClass(RepairPartUsage);
RepairPartUsageSchema.index({ jobId: 1, createdAt: 1 }, { name: 'ix_repair_usage_job' });
RepairPartUsageSchema.index(
  { reservationId: 1 },
  { unique: true, name: 'uq_repair_usage_reservation' },
);

@Schema({ ...rootSchemaOptions, collection: 'repair_stock_operations' })
export class RepairStockOperation {
  @Prop({ required: true, maxlength: 100 }) key!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) requestHash!: string;
  @Prop({ required: true, maxlength: 120 }) kind!: string;
  @Prop({ required: true, maxlength: 100 }) resultId!: string;
  @Prop(id) actorId!: Types.ObjectId;
}
export const RepairStockOperationSchema = SchemaFactory.createForClass(RepairStockOperation);
RepairStockOperationSchema.index({ key: 1 }, { unique: true, name: 'uq_repair_stock_operation' });
