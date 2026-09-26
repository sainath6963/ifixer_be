import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { NotificationChannel, NotificationStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'notifications' })
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'OutboxEvent', required: true })
  outboxEventId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 100 })
  sourceEventId!: string;

  @Prop({ enum: NotificationChannel, default: NotificationChannel.Email })
  channel!: NotificationChannel;

  @Prop({ required: true, trim: true, maxlength: 160 })
  templateKey!: string;

  @Prop({ required: true, trim: true, maxlength: 254 })
  recipient!: string;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  deliveryKey!: string;

  @Prop({ trim: true, maxlength: 300 })
  subject?: string;

  @Prop({ required: true, maxlength: 20_000 })
  textBody!: string;

  @Prop({ maxlength: 50_000 })
  htmlBody?: string;

  @Prop({ enum: NotificationStatus, default: NotificationStatus.Pending })
  status!: NotificationStatus;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  attempts!: number;

  @Prop({ required: true, default: () => new Date() })
  nextAttemptAt!: Date;

  @Prop()
  lockedAt?: Date;

  @Prop({ trim: true, maxlength: 100 })
  lockToken?: string;

  @Prop({ trim: true, maxlength: 500 })
  providerMessageId?: string;

  @Prop()
  sentAt?: Date;

  @Prop({ trim: true, maxlength: 2000 })
  lastError?: string;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index(
  { deliveryKey: 1 },
  { unique: true, name: 'uq_notifications_delivery_key' },
);
NotificationSchema.index(
  { status: 1, nextAttemptAt: 1, lockedAt: 1 },
  { name: 'ix_notifications_worker' },
);
NotificationSchema.index(
  { outboxEventId: 1, createdAt: -1 },
  { name: 'ix_notifications_outbox_created' },
);
NotificationSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'ix_notifications_admin_status_created' },
);
NotificationSchema.index(
  { channel: 1, status: 1, createdAt: -1 },
  { name: 'ix_notifications_admin_channel_status_created' },
);
NotificationSchema.pre('validate', function validateChannelPayload(): void {
  if (this.channel === NotificationChannel.Email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.recipient)) {
      this.invalidate('recipient', 'Email notifications require a valid email recipient');
    }
    if (!this.subject) this.invalidate('subject', 'Email notifications require a subject');
    if (!this.htmlBody) this.invalidate('htmlBody', 'Email notifications require an HTML body');
    return;
  }
  if (!/^\+?[1-9]\d{7,14}$/.test(this.recipient)) {
    this.invalidate('recipient', 'Mobile notifications require an E.164-compatible recipient');
  }
});
