import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongoSchema, Types } from 'mongoose';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';

export enum RepairJobStatus {
  Received = 'RECEIVED',
  Diagnosing = 'DIAGNOSING',
  AwaitingApproval = 'AWAITING_APPROVAL',
  AwaitingParts = 'AWAITING_PARTS',
  Repairing = 'REPAIRING',
  Testing = 'TESTING',
  Ready = 'READY',
  Delivered = 'DELIVERED',
  Cancelled = 'CANCELLED',
  Unrepairable = 'UNREPAIRABLE',
}
export const repairTestKeys = [
  'power',
  'display',
  'touch',
  'charging',
  'audio',
  'cameras',
  'connectivity',
] as const;
const embedded = { ...embeddedSchemaOptions, versionKey: false as const };
const integer = { required: true, validate: isNonNegativeSafeInteger, max: 1000000000 };

@Schema(embedded)
export class RepairJobEvent {
  @Prop({ required: true }) at!: Date;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) actorId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) actorName!: string;
  @Prop({ required: true, maxlength: 40 }) action!: string;
  @Prop({ required: true, enum: RepairJobStatus }) status!: RepairJobStatus;
  @Prop({ required: true, maxlength: 2000 }) reason!: string;
}

@Schema(embedded)
export class RepairEstimateLine {
  @Prop({ required: true, maxlength: 160 }) description!: string;
  @Prop({ ...integer, min: 1, max: 100 }) quantity!: number;
  @Prop(integer) unitPriceInPaise!: number;
}
@Schema(embedded)
export class RepairApproval {
  @Prop({ required: true, enum: ['APPROVED', 'DECLINED'] }) decision!: string;
  @Prop({ required: true, enum: ['IN_PERSON', 'PHONE', 'MESSAGE'] }) method!: string;
  @Prop({ required: true, maxlength: 120 }) customerName!: string;
  @Prop({ required: true, maxlength: 1000 }) evidence!: string;
  @Prop({ required: true }) at!: Date;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) recordedBy!: Types.ObjectId;
}
@Schema(embedded)
export class RepairEstimate {
  @Prop({ ...integer, min: 1, max: 100 }) revision!: number;
  @Prop({ type: [SchemaFactory.createForClass(RepairEstimateLine)], required: true })
  lines!: RepairEstimateLine[];
  @Prop(integer) totalInPaise!: number;
  @Prop({ required: true, maxlength: 1000 }) reason!: string;
  @Prop({ required: true }) at!: Date;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) createdBy!: Types.ObjectId;
  @Prop({ type: SchemaFactory.createForClass(RepairApproval) }) approval?: RepairApproval;
}
@Schema(embedded)
export class RepairTest {
  @Prop({ required: true, enum: repairTestKeys }) key!: string;
  @Prop({ required: true, enum: ['PASS', 'FAIL', 'NA'] }) result!: string;
  @Prop({ maxlength: 500 }) notes?: string;
}

@Schema(embedded)
export class BillingDeliveryAuthorization {
  @Prop({ required: true }) invoiceNumber!: string;
  @Prop(integer) dueInPaise!: number;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) authorizedBy!: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) authorizedByName!: string;
  @Prop({ required: true }) at!: Date;
  @Prop({ required: true, maxlength: 500 }) reason!: string;
}

@Schema({ ...rootSchemaOptions, collection: 'repair_jobs' })
export class RepairJob {
  @Prop({ type: SchemaFactory.createForClass(BillingDeliveryAuthorization) })
  billingAuthorization?: BillingDeliveryAuthorization;
  @Prop({ match: /^JOB-[A-F0-9]{16}$/ }) warrantySourceJobNumber?: string;
  @Prop({ match: /^INV-[0-9]{6,9}$/ }) warrantySourceInvoiceNumber?: string;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'DeviceModel' }) modelId?: Types.ObjectId;
  @Prop({ required: true, match: /^JOB-[A-F0-9]{16}$/ }) number!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'RepairBooking' }) bookingId?: Types.ObjectId;
  @Prop({ match: /^IFX-[A-F0-9]{16}$/ }) bookingReference?: string;
  @Prop({ required: true }) operationKey!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) requestHash!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'Customer' }) customerId?: Types.ObjectId;
  @Prop({ required: true, maxlength: 120 }) customerName!: string;
  @Prop({ required: true, match: /^\+?[1-9]\d{7,14}$/ }) phone!: string;
  @Prop({ maxlength: 254 }) email?: string;
  @Prop({ required: true, maxlength: 400 }) deviceLabel!: string;
  @Prop({ maxlength: 15, match: /^\d{15}$/ }) imei?: string;
  @Prop({ maxlength: 120 }) serial?: string;
  @Prop({ required: true, maxlength: 2000 }) issue!: string;
  @Prop({ required: true, maxlength: 2000 }) condition!: string;
  @Prop({ required: true, maxlength: 1000 }) accessories!: string;
  @Prop() targetAt?: Date;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'AdminUser' }) technicianId?: Types.ObjectId;
  @Prop({ maxlength: 120 }) technicianName?: string;
  @Prop({ required: true, enum: RepairJobStatus, default: RepairJobStatus.Received })
  status!: RepairJobStatus;
  @Prop({ required: true, enum: ['IN_SHOP', 'RETURNED'], default: 'IN_SHOP' }) custody!: string;
  @Prop() returnedAt?: Date;
  @Prop({ maxlength: 120 }) returnedTo?: string;
  @Prop({ maxlength: 2000 }) diagnosis?: string;
  @Prop({ type: [SchemaFactory.createForClass(RepairEstimate)], default: [] })
  estimates!: RepairEstimate[];
  @Prop({ type: [SchemaFactory.createForClass(RepairTest)], default: [] }) tests!: RepairTest[];
  @Prop({ ...integer, default: 0, max: 8 }) photoCount!: number;
  @Prop({ type: [SchemaFactory.createForClass(RepairJobEvent)], required: true })
  history!: RepairJobEvent[];
}
export type RepairJobDocument = HydratedDocument<RepairJob>;
export const RepairJobSchema = SchemaFactory.createForClass(RepairJob);
RepairJobSchema.index({ warrantySourceJobNumber: 1 }, { name: 'ix_repair_warranty_followup' });
RepairJobSchema.index({ number: 1 }, { unique: true, name: 'uq_repair_job_number' });
RepairJobSchema.index({ operationKey: 1 }, { unique: true, name: 'uq_repair_job_operation' });
RepairJobSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: { bookingId: { $type: 'objectId' } },
    name: 'uq_repair_job_booking',
  },
);
RepairJobSchema.index({ status: 1, createdAt: -1, _id: -1 }, { name: 'ix_repair_job_queue' });
RepairJobSchema.index(
  { technicianId: 1, createdAt: -1, _id: -1 },
  { name: 'ix_repair_job_technician' },
);
RepairJobSchema.index({ custody: 1, targetAt: 1 }, { name: 'ix_repair_job_custody_target' });

// Small, normalized private images live in separate documents. Binary and metadata commit
// together, avoiding a public media URL or orphaned files after a failed transaction.
@Schema({ ...rootSchemaOptions, collection: 'repair_job_photos' })
export class RepairJobPhoto {
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'RepairJob', required: true })
  jobId!: Types.ObjectId;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) checksum!: string;
  @Prop({ type: Buffer, required: true, select: false }) bytes!: Buffer;
  @Prop({ ...integer, min: 1, max: 3145728 }) sizeBytes!: number;
  @Prop({ ...integer, min: 1, max: 2000 }) width!: number;
  @Prop({ ...integer, min: 1, max: 2000 }) height!: number;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) uploadedBy!: Types.ObjectId;
}
export const RepairJobPhotoSchema = SchemaFactory.createForClass(RepairJobPhoto);
RepairJobPhotoSchema.index(
  { jobId: 1, checksum: 1 },
  { unique: true, name: 'uq_repair_job_photo' },
);
