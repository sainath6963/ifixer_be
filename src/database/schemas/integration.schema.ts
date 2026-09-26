import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { OutboxStatus, PaymentProvider, WebhookStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'webhook_events' })
export class WebhookEvent {
  @Prop({ enum: PaymentProvider, required: true })
  provider!: PaymentProvider;

  @Prop({ required: true, trim: true, maxlength: 160 })
  eventId!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  eventType!: string;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  payloadHashSha256!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: Record<string, unknown>;

  @Prop({ enum: WebhookStatus, default: WebhookStatus.Received })
  status!: WebhookStatus;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  processingAttempts!: number;

  @Prop({ required: true, default: () => new Date() })
  receivedAt!: Date;

  @Prop()
  processedAt?: Date;

  @Prop({ trim: true, maxlength: 2000 })
  lastError?: string;
}

export type WebhookEventDocument = HydratedDocument<WebhookEvent>;
export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);
WebhookEventSchema.index(
  { provider: 1, eventId: 1 },
  { unique: true, name: 'uq_webhook_events_provider_event' },
);
WebhookEventSchema.index({ status: 1, receivedAt: 1 }, { name: 'ix_webhook_events_processing' });

@Schema({ ...rootSchemaOptions, collection: 'outbox_events' })
export class OutboxEvent {
  @Prop({ required: true, trim: true, maxlength: 100 })
  eventId!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  aggregateType!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  aggregateId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 160 })
  eventType!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: Record<string, unknown>;

  @Prop({ enum: OutboxStatus, default: OutboxStatus.Pending })
  status!: OutboxStatus;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  processingAttempts!: number;

  @Prop({ required: true, default: () => new Date() })
  availableAt!: Date;

  @Prop()
  lockedAt?: Date;

  @Prop({ trim: true, maxlength: 100 })
  lockToken?: string;

  @Prop()
  publishedAt?: Date;

  @Prop({ trim: true, maxlength: 2000 })
  lastError?: string;
}

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;
export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);
OutboxEventSchema.index({ eventId: 1 }, { unique: true, name: 'uq_outbox_events_event' });
OutboxEventSchema.index(
  { status: 1, availableAt: 1, lockedAt: 1 },
  { name: 'ix_outbox_events_worker' },
);
OutboxEventSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'ix_outbox_events_admin_status_created' },
);
