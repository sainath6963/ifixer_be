import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum WebsiteEventType {
  PageView = 'PAGE_VIEW',
  GoogleReviewClick = 'GOOGLE_REVIEW_CLICK',
}

export enum WebsiteTrafficSource {
  Direct = 'DIRECT',
  Google = 'GOOGLE',
  Instagram = 'INSTAGRAM',
  Facebook = 'FACEBOOK',
  WhatsApp = 'WHATSAPP',
  Other = 'OTHER',
}

export enum WebsiteTrafficDevice {
  Mobile = 'MOBILE',
  Tablet = 'TABLET',
  Desktop = 'DESKTOP',
}

@Schema({
  collection: 'website_events',
  versionKey: false,
  strict: 'throw',
  minimize: false,
  autoCreate: false,
  autoIndex: false,
})
export class WebsiteEvent {
  @Prop({ required: true, enum: WebsiteEventType })
  eventType!: WebsiteEventType;

  @Prop({ required: true, match: /^[a-f0-9]{64}$/ })
  visitorHash!: string;

  @Prop({ required: true, match: /^[a-f0-9]{64}$/ })
  sessionHash!: string;

  @Prop({ required: true, maxlength: 200 })
  path!: string;

  @Prop({ required: true, enum: WebsiteTrafficSource })
  source!: WebsiteTrafficSource;

  @Prop({ maxlength: 253, default: '' })
  referrerHost!: string;

  @Prop({ required: true, enum: WebsiteTrafficDevice })
  device!: WebsiteTrafficDevice;

  @Prop({ required: true })
  recordedAt!: Date;

  @Prop({ required: true })
  expiresAt!: Date;
}

export const WebsiteEventSchema = SchemaFactory.createForClass(WebsiteEvent);
WebsiteEventSchema.index({ eventType: 1, recordedAt: -1 }, { name: 'ix_website_events_type_time' });
WebsiteEventSchema.index(
  { eventType: 1, sessionHash: 1, recordedAt: -1 },
  { name: 'ix_website_events_session_time' },
);
WebsiteEventSchema.index(
  { eventType: 1, visitorHash: 1, recordedAt: -1 },
  { name: 'ix_website_events_visitor_time' },
);
WebsiteEventSchema.index(
  { eventType: 1, path: 1, recordedAt: -1 },
  { name: 'ix_website_events_path_time' },
);
WebsiteEventSchema.index({ expiresAt: 1 }, { name: 'ttl_website_events', expireAfterSeconds: 0 });
