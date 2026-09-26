import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'instagram_reels' })
export class InstagramReel {
  @Prop({ required: true, match: /^https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]{5,64}\/$/ })
  url!: string;
  @Prop({ default: '', maxlength: 120 }) title!: string;
  @Prop({ required: true, default: false }) active!: boolean;
  @Prop({ required: true, default: 0, max: 9999, validate: isNonNegativeSafeInteger })
  sortOrder!: number;
}
export const InstagramReelSchema = SchemaFactory.createForClass(InstagramReel);
InstagramReelSchema.index({ url: 1 }, { unique: true, name: 'uq_instagram_reel_url' });
InstagramReelSchema.index(
  { active: 1, sortOrder: 1, _id: -1 },
  { name: 'ix_instagram_reel_public' },
);
