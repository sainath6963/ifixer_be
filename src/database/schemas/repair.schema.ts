import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongoSchema, Types } from 'mongoose';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';

export enum RepairPricingMode {
  Diagnosis = 'DIAGNOSIS',
  Indicative = 'INDICATIVE',
}
export enum RepairBookingStatus {
  Requested = 'REQUESTED',
  Confirmed = 'CONFIRMED',
  Cancelled = 'CANCELLED',
  Converted = 'CONVERTED',
}

@Schema({ ...embeddedSchemaOptions, versionKey: false })
class CatalogBase {
  @Prop({ required: true, default: false }) active!: boolean;
  @Prop({ required: true, default: 0, validate: isNonNegativeSafeInteger }) sortOrder!: number;
}

@Schema({ ...rootSchemaOptions, collection: 'device_brands' })
export class DeviceBrand extends CatalogBase {
  @Prop({ required: true, trim: true, maxlength: 120 }) name!: string;
  @Prop({ required: true, maxlength: 160, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }) slug!: string;
}
export const DeviceBrandSchema = SchemaFactory.createForClass(DeviceBrand);
DeviceBrandSchema.index({ slug: 1 }, { unique: true, name: 'uq_device_brand_slug' });

@Schema({ ...rootSchemaOptions, collection: 'device_models' })
export class DeviceModel extends DeviceBrand {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, ref: 'DeviceBrand' })
  brandId!: Types.ObjectId;
}
export const DeviceModelSchema = SchemaFactory.createForClass(DeviceModel);
DeviceModelSchema.index(
  { brandId: 1, slug: 1 },
  { unique: true, name: 'uq_device_model_brand_slug' },
);

@Schema({ ...rootSchemaOptions, collection: 'repair_services' })
export class RepairService extends DeviceBrand {
  @Prop({ required: true, trim: true, maxlength: 1200 }) description!: string;
  @Prop({ required: true, enum: RepairPricingMode }) pricingMode!: RepairPricingMode;
  @Prop({ validate: isNonNegativeSafeInteger, max: 1000000000 }) priceInPaise?: number;
}
export const RepairServiceSchema = SchemaFactory.createForClass(RepairService);
RepairServiceSchema.index({ slug: 1 }, { unique: true, name: 'uq_repair_service_slug' });

@Schema({ ...rootSchemaOptions, collection: 'repair_service_options' })
export class RepairServiceOption extends CatalogBase {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, ref: 'DeviceModel' })
  modelId!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, ref: 'RepairService' })
  serviceId!: Types.ObjectId;
  @Prop({ required: true, enum: RepairPricingMode }) pricingMode!: RepairPricingMode;
  @Prop({ validate: isNonNegativeSafeInteger, max: 1000000000 }) priceInPaise?: number;
}
export const RepairServiceOptionSchema = SchemaFactory.createForClass(RepairServiceOption);
RepairServiceOptionSchema.index(
  { modelId: 1, serviceId: 1 },
  { unique: true, name: 'uq_repair_option_model_service' },
);

@Schema({ ...embeddedSchemaOptions, versionKey: false })
export class BookingEvent {
  @Prop({ required: true }) at!: Date;
  @Prop({ required: true, enum: ['ADMIN', 'CUSTOMER', 'GUEST'] }) actor!: string;
  @Prop({ type: MongoSchema.Types.ObjectId }) actorId?: Types.ObjectId;
  @Prop({ required: true, enum: ['CREATE', 'CONFIRM', 'RESCHEDULE', 'CANCEL', 'CONVERT'] })
  action!: string;
  @Prop({ required: true, enum: RepairBookingStatus }) status!: RepairBookingStatus;
  @Prop({ required: true, maxlength: 500 }) reason!: string;
  @Prop() visitAt?: Date;
}
const BookingEventSchema = SchemaFactory.createForClass(BookingEvent);

@Schema({ ...rootSchemaOptions, collection: 'repair_bookings' })
export class RepairBooking {
  @Prop({ match: /^JOB-[A-F0-9]{16}$/ }) jobNumber?: string;
  @Prop({ required: true, match: /^IFX-[A-F0-9]{16}$/ }) reference!: string;
  @Prop({ required: true, maxlength: 100 }) operationKey!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) requestHash!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/, select: false }) manageTokenHash!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'Customer' }) customerId?: Types.ObjectId;
  @Prop({ required: true, enum: ['ONLINE', 'WALK_IN'] }) source!: string;
  @Prop({ required: true, maxlength: 120 }) customerName!: string;
  @Prop({ required: true, match: /^\+?[1-9]\d{7,14}$/ }) phone!: string;
  @Prop({ maxlength: 254 }) email?: string;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'DeviceBrand' }) brandId?: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'DeviceModel' }) modelId?: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'RepairService' }) serviceId?: Types.ObjectId;
  @Prop({ required: true, maxlength: 400 }) deviceLabel!: string;
  @Prop({ required: true, maxlength: 160 }) serviceLabel!: string;
  @Prop({ required: true, maxlength: 2000 }) issue!: string;
  @Prop({ required: true, enum: RepairPricingMode }) pricingMode!: RepairPricingMode;
  @Prop({ validate: isNonNegativeSafeInteger, max: 1000000000 }) indicativePriceInPaise?: number;
  @Prop() requestedVisitAt?: Date;
  @Prop() confirmedVisitAt?: Date;
  @Prop({ required: true, enum: RepairBookingStatus, default: RepairBookingStatus.Requested })
  status!: RepairBookingStatus;
  @Prop({ type: [BookingEventSchema], required: true }) history!: BookingEvent[];
}
export type RepairBookingDocument = HydratedDocument<RepairBooking>;
export const RepairBookingSchema = SchemaFactory.createForClass(RepairBooking);
RepairBookingSchema.index({ reference: 1 }, { unique: true, name: 'uq_repair_booking_reference' });
RepairBookingSchema.index(
  { operationKey: 1 },
  { unique: true, name: 'uq_repair_booking_operation' },
);
RepairBookingSchema.index(
  { status: 1, createdAt: -1, _id: -1 },
  { name: 'ix_repair_booking_queue' },
);
RepairBookingSchema.index({ createdAt: -1, _id: -1 }, { name: 'ix_repair_booking_created' });
RepairBookingSchema.index({ customerId: 1, createdAt: -1 }, { name: 'ix_repair_booking_customer' });
