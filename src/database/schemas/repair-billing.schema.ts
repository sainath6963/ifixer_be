import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';
const embedded = { ...embeddedSchemaOptions, versionKey: false as const };
const money = {
  type: Number,
  required: true,
  min: 0,
  max: 1000000000,
  validate: isNonNegativeSafeInteger,
};
const id = { type: MongoSchema.Types.ObjectId, required: true };
@Schema(embedded)
export class BillingTax {
  @Prop({ required: true, maxlength: 80 }) label!: string;
  @Prop({ type: Number, required: true, min: 0, max: 10000, validate: isNonNegativeSafeInteger })
  rateBps!: number;
}
@Schema(embedded)
export class BillingIssuer {
  @Prop({ required: true, maxlength: 160 }) name!: string;
  @Prop({ required: true, maxlength: 1000 }) address!: string;
  @Prop({ required: true, maxlength: 20 }) phone!: string;
  @Prop({ maxlength: 80 }) taxId?: string;
}
@Schema({ ...rootSchemaOptions, collection: 'repair_billing_settings' })
export class RepairBillingSettings {
  @Prop({ required: true, enum: ['SHOP'], default: 'SHOP' }) key!: string;
  @Prop({ type: SchemaFactory.createForClass(BillingIssuer), required: true })
  issuer!: BillingIssuer;
  @Prop({ type: [SchemaFactory.createForClass(BillingTax)], default: [] }) taxes!: BillingTax[];
  @Prop({ ...money, max: 1095 }) warrantyDays!: number;
  @Prop({ required: true, maxlength: 2000 }) warrantyCoverage!: string;
  @Prop({ required: true, maxlength: 2000 }) warrantyExclusions!: string;
  @Prop({ maxlength: 1000 }) invoiceNote?: string;
}
export const RepairBillingSettingsSchema = SchemaFactory.createForClass(RepairBillingSettings);
RepairBillingSettingsSchema.index({ key: 1 }, { unique: true, name: 'uq_repair_billing_settings' });
@Schema(embedded)
export class RepairInvoiceLine {
  @Prop({ required: true, enum: ['PART', 'LABOUR', 'SERVICE'] }) kind!: string;
  @Prop({ required: true, maxlength: 160 }) description!: string;
  @Prop({ ...money, min: 1, max: 100 }) quantity!: number;
  @Prop(money) unitPriceInPaise!: number;
}
@Schema(embedded)
export class InvoiceTax extends BillingTax {
  @Prop(money) amountInPaise!: number;
}
@Schema({ ...rootSchemaOptions, collection: 'repair_invoices' })
export class RepairInvoice {
  @Prop({ required: true }) number!: string;
  @Prop(id) jobId!: Types.ObjectId;
  @Prop({ required: true }) jobNumber!: string;
  @Prop({ type: SchemaFactory.createForClass(BillingIssuer), required: true })
  issuer!: BillingIssuer;
  @Prop({ required: true, maxlength: 120 }) customerName!: string;
  @Prop({ required: true, maxlength: 20 }) phone!: string;
  @Prop({ required: true, maxlength: 400 }) deviceLabel!: string;
  @Prop({ maxlength: 120 }) serial?: string;
  @Prop({ maxlength: 15 }) imei?: string;
  @Prop({ ...money, min: 1, max: 100 }) estimateRevision!: number;
  @Prop({ type: [SchemaFactory.createForClass(RepairInvoiceLine)], required: true })
  lines!: RepairInvoiceLine[];
  @Prop(money) subtotalInPaise!: number;
  @Prop(money) discountInPaise!: number;
  @Prop(money) taxableInPaise!: number;
  @Prop({ type: [SchemaFactory.createForClass(InvoiceTax)], default: [] }) taxes!: InvoiceTax[];
  @Prop(money) totalInPaise!: number;
  @Prop({ ...money, max: 1095 }) warrantyDays!: number;
  @Prop({ required: true, maxlength: 2000 }) warrantyCoverage!: string;
  @Prop({ required: true, maxlength: 2000 }) warrantyExclusions!: string;
  @Prop({ maxlength: 1000 }) note?: string;
  @Prop(id) issuedBy!: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) issuedByName!: string;
}
export const RepairInvoiceSchema = SchemaFactory.createForClass(RepairInvoice);
RepairInvoiceSchema.index({ number: 1 }, { unique: true, name: 'uq_repair_invoice_number' });
RepairInvoiceSchema.index({ jobId: 1 }, { unique: true, name: 'uq_repair_invoice_job' });
RepairInvoiceSchema.index({ createdAt: -1, _id: -1 }, { name: 'ix_repair_invoice_queue' });
@Schema({ ...rootSchemaOptions, collection: 'repair_money_entries' })
export class RepairMoneyEntry {
  @Prop({ required: true }) number!: string;
  @Prop(id) jobId!: Types.ObjectId;
  @Prop({ required: true }) jobNumber!: string;
  @Prop({ required: true, enum: ['PAYMENT', 'REFUND', 'CREDIT'] }) kind!: string;
  @Prop({ ...money, min: 1 }) amountInPaise!: number;
  @Prop({ enum: ['CASH', 'UPI'] }) method?: string;
  @Prop({ maxlength: 100 }) reference?: string;
  @Prop({ type: MongoSchema.Types.ObjectId }) paymentId?: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId }) invoiceId?: Types.ObjectId;
  @Prop({ match: /^INV-[0-9]{6,9}$/ }) invoiceNumber?: string;
  @Prop({ match: /^RCP-[0-9]{6,9}$/ }) paymentNumber?: string;
  @Prop({ required: true, maxlength: 500 }) reason!: string;
  @Prop({ type: SchemaFactory.createForClass(BillingIssuer), required: true })
  issuer!: BillingIssuer;
  @Prop({ required: true, maxlength: 120 }) customerName!: string;
  @Prop(id) recordedBy!: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) recordedByName!: string;
}
export const RepairMoneyEntrySchema = SchemaFactory.createForClass(RepairMoneyEntry);
RepairMoneyEntrySchema.index({ number: 1 }, { unique: true, name: 'uq_repair_money_number' });
RepairMoneyEntrySchema.index({ jobId: 1, createdAt: 1 }, { name: 'ix_repair_money_job' });
RepairMoneyEntrySchema.index(
  { reference: 1 },
  { unique: true, partialFilterExpression: { method: 'UPI' }, name: 'uq_repair_upi_reference' },
);
@Schema({ ...rootSchemaOptions, collection: 'repair_warranties' })
export class RepairWarranty {
  @Prop(id) invoiceId!: Types.ObjectId;
  @Prop(id) jobId!: Types.ObjectId;
  @Prop({ ...money, max: 1095 }) days!: number;
  @Prop() startsAt?: Date;
  @Prop() endsAt?: Date;
}
export const RepairWarrantySchema = SchemaFactory.createForClass(RepairWarranty);
RepairWarrantySchema.index({ invoiceId: 1 }, { unique: true, name: 'uq_repair_warranty_invoice' });
RepairWarrantySchema.index({ jobId: 1 }, { unique: true, name: 'uq_repair_warranty_job' });
@Schema({ ...rootSchemaOptions, collection: 'repair_billing_operations' })
export class RepairBillingOperation {
  @Prop({ required: true }) key!: string;
  @Prop({ required: true }) requestHash!: string;
  @Prop({ required: true }) kind!: string;
  @Prop({ required: true }) result!: string;
  @Prop(id) actorId!: Types.ObjectId;
}
export const RepairBillingOperationSchema = SchemaFactory.createForClass(RepairBillingOperation);
RepairBillingOperationSchema.index(
  { key: 1 },
  { unique: true, name: 'uq_repair_billing_operation' },
);
@Schema({ ...rootSchemaOptions, collection: 'repair_billing_sequences' })
export class RepairBillingSequence {
  @Prop({ required: true }) key!: string;
  @Prop({ ...money, default: 0 }) value!: number;
}
export const RepairBillingSequenceSchema = SchemaFactory.createForClass(RepairBillingSequence);
RepairBillingSequenceSchema.index({ key: 1 }, { unique: true, name: 'uq_repair_billing_sequence' });
