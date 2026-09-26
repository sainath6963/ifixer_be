import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { ProductReviewStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'product_reviews' })
export class ProductReview {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ required: true, uppercase: true, trim: true, maxlength: 40 })
  orderNumber!: string;

  @Prop({ required: true, trim: true, maxlength: 180 })
  productName!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 220 })
  productSlug!: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  displayName!: string;

  @Prop({ type: Number, required: true, min: 1, max: 5, validate: isPositiveSafeInteger })
  rating!: number;

  @Prop({ required: true, trim: true, maxlength: 120 })
  title!: string;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  body!: string;

  @Prop({ enum: ProductReviewStatus, default: ProductReviewStatus.Pending })
  status!: ProductReviewStatus;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser' })
  moderatedBy?: Types.ObjectId;

  @Prop()
  moderatedAt?: Date;

  @Prop()
  publishedAt?: Date;

  @Prop({ trim: true, maxlength: 1000 })
  rejectionReason?: string;

  @Prop()
  withdrawnAt?: Date;
}

export type ProductReviewDocument = HydratedDocument<ProductReview>;
export const ProductReviewSchema = SchemaFactory.createForClass(ProductReview);
ProductReviewSchema.index(
  { customerId: 1, productId: 1 },
  { unique: true, name: 'uq_product_reviews_customer_product' },
);
ProductReviewSchema.index(
  { productId: 1, status: 1, publishedAt: -1, _id: -1 },
  { name: 'ix_product_reviews_public_product' },
);
ProductReviewSchema.index(
  { status: 1, createdAt: -1, _id: -1 },
  { name: 'ix_product_reviews_moderation_queue' },
);
ProductReviewSchema.index(
  { customerId: 1, updatedAt: -1 },
  { name: 'ix_product_reviews_customer_updated' },
);
ProductReviewSchema.pre('validate', function validateReviewState(): void {
  if (this.status === ProductReviewStatus.Pending) {
    if (this.publishedAt || this.rejectionReason || this.withdrawnAt) {
      this.invalidate('status', 'Pending reviews cannot contain a moderation outcome');
    }
  } else if (this.status === ProductReviewStatus.Published) {
    if (!this.publishedAt || !this.moderatedAt || !this.moderatedBy) {
      this.invalidate('status', 'Published reviews require moderation metadata');
    }
    if (this.rejectionReason || this.withdrawnAt) {
      this.invalidate('status', 'Published reviews cannot be rejected or withdrawn');
    }
  } else if (this.status === ProductReviewStatus.Rejected) {
    if (!this.moderatedAt || !this.moderatedBy || !this.rejectionReason) {
      this.invalidate('status', 'Rejected reviews require a reason and moderation metadata');
    }
    if (this.publishedAt || this.withdrawnAt) {
      this.invalidate('status', 'Rejected reviews cannot be published or withdrawn');
    }
  } else if (!this.withdrawnAt || this.publishedAt || this.rejectionReason) {
    this.invalidate('status', 'Withdrawn reviews require a withdrawal timestamp only');
  }
});

@Schema({ ...rootSchemaOptions, collection: 'product_review_summaries' })
export class ProductReviewSummary {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  reviewCount!: number;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  ratingTotal!: number;
}

export type ProductReviewSummaryDocument = HydratedDocument<ProductReviewSummary>;
export const ProductReviewSummarySchema = SchemaFactory.createForClass(ProductReviewSummary);
ProductReviewSummarySchema.index(
  { productId: 1 },
  { unique: true, name: 'uq_product_review_summaries_product' },
);
ProductReviewSummarySchema.pre('validate', function validateSummary(): void {
  const valid =
    (this.reviewCount === 0 && this.ratingTotal === 0) ||
    (this.reviewCount > 0 &&
      this.ratingTotal >= this.reviewCount &&
      this.ratingTotal <= this.reviewCount * 5);
  if (!valid) this.invalidate('ratingTotal', 'Rating summary is inconsistent');
});
