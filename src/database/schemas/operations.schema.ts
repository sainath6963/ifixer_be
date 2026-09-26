import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { AuditActorType } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';

@Schema({ ...rootSchemaOptions, collection: 'store_settings' })
export class StoreSetting {
  @Prop({ required: true, trim: true, maxlength: 160 })
  key!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  value!: unknown;

  @Prop({ default: false })
  isPublic!: boolean;

  @Prop({ trim: true, maxlength: 500 })
  description?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser' })
  updatedBy?: Types.ObjectId;
}

export type StoreSettingDocument = HydratedDocument<StoreSetting>;
export const StoreSettingSchema = SchemaFactory.createForClass(StoreSetting);
StoreSettingSchema.index({ key: 1 }, { unique: true, name: 'uq_store_settings_key' });
StoreSettingSchema.index({ isPublic: 1, key: 1 }, { name: 'ix_store_settings_public_key' });

@Schema({ ...rootSchemaOptions, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ enum: AuditActorType, required: true })
  actorType!: AuditActorType;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  actorId?: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 160 })
  action!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  resourceType!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  resourceId!: string;

  @Prop({ trim: true, maxlength: 128 })
  requestId?: string;

  @Prop({ trim: true, maxlength: 128 })
  ipHash?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata!: Record<string, unknown>;

  @Prop({ required: true, default: () => new Date() })
  occurredAt!: Date;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ actorId: 1, occurredAt: -1 }, { name: 'ix_audit_logs_actor_time' });
AuditLogSchema.index(
  { resourceType: 1, resourceId: 1, occurredAt: -1 },
  { name: 'ix_audit_logs_resource_time' },
);
AuditLogSchema.index({ action: 1, occurredAt: -1 }, { name: 'ix_audit_logs_action_time' });
