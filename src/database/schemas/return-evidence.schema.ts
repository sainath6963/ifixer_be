import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { ReturnEvidenceStatus, StorageProvider } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import { isPositiveSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'return_evidence' })
export class ReturnEvidence {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ReturnRequest', required: true })
  returnRequestId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ enum: StorageProvider, default: StorageProvider.Local })
  storageProvider!: StorageProvider;

  @Prop({
    required: true,
    trim: true,
    maxlength: 500,
    match: /^private\/return-evidence\/[a-f0-9]{2}\/[a-f0-9]{24}\/[a-f0-9]{24}\.webp$/,
  })
  storageKey!: string;

  @Prop({ required: true, trim: true, maxlength: 255 })
  originalFilename!: string;

  @Prop({ required: true, enum: ['image/webp'] })
  mimeType!: 'image/webp';

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  sizeBytes!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  width!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  height!: number;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  checksumSha256!: string;

  @Prop({ enum: ReturnEvidenceStatus, default: ReturnEvidenceStatus.Pending })
  status!: ReturnEvidenceStatus;

  @Prop()
  deletedAt?: Date;
}

export type ReturnEvidenceDocument = HydratedDocument<ReturnEvidence>;
export const ReturnEvidenceSchema = SchemaFactory.createForClass(ReturnEvidence);
ReturnEvidenceSchema.index(
  { storageKey: 1 },
  { unique: true, name: 'uq_return_evidence_storage_key' },
);
ReturnEvidenceSchema.index(
  { returnRequestId: 1, createdAt: 1, _id: 1 },
  { name: 'ix_return_evidence_request_created' },
);
ReturnEvidenceSchema.index(
  { returnRequestId: 1, checksumSha256: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['PENDING', 'READY'] } },
    name: 'uq_return_evidence_request_checksum',
  },
);
ReturnEvidenceSchema.index({ status: 1, createdAt: 1 }, { name: 'ix_return_evidence_maintenance' });
