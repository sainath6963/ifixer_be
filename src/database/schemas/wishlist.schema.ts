import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { StockAlertStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';

@Schema({ ...rootSchemaOptions, collection: 'wishlist_items' })
export class WishlistItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;
}

export type WishlistItemDocument = HydratedDocument<WishlistItem>;
export const WishlistItemSchema = SchemaFactory.createForClass(WishlistItem);
WishlistItemSchema.index(
  { customerId: 1, productId: 1 },
  { unique: true, name: 'uq_wishlist_items_customer_product' },
);
WishlistItemSchema.index(
  { customerId: 1, createdAt: -1, _id: -1 },
  { name: 'ix_wishlist_items_customer_created' },
);

@Schema({ ...rootSchemaOptions, collection: 'stock_alerts' })
export class StockAlert {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 180 })
  productName!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 220 })
  productSlug!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  variantTitle!: string;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 100 })
  sku!: string;

  @Prop({ enum: StockAlertStatus, default: StockAlertStatus.Active })
  status!: StockAlertStatus;

  @Prop({ default: true })
  active!: boolean;

  @Prop({ required: true, default: () => new Date() })
  requestedAt!: Date;

  @Prop()
  notifiedAt?: Date;

  @Prop()
  cancelledAt?: Date;
}

export type StockAlertDocument = HydratedDocument<StockAlert>;
export const StockAlertSchema = SchemaFactory.createForClass(StockAlert);
StockAlertSchema.index(
  { customerId: 1, variantId: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: 'uq_stock_alerts_customer_variant_active',
  },
);
StockAlertSchema.index({ active: 1, requestedAt: 1, _id: 1 }, { name: 'ix_stock_alerts_dispatch' });
StockAlertSchema.index(
  { active: 1, productId: 1, variantId: 1 },
  { name: 'ix_stock_alerts_active_demand' },
);
StockAlertSchema.index(
  { customerId: 1, active: 1, updatedAt: -1 },
  { name: 'ix_stock_alerts_customer_active_updated' },
);
StockAlertSchema.pre('validate', function validateStockAlertState(): void {
  const valid =
    (this.status === StockAlertStatus.Active &&
      this.active &&
      !this.notifiedAt &&
      !this.cancelledAt) ||
    (this.status === StockAlertStatus.Notified &&
      !this.active &&
      Boolean(this.notifiedAt) &&
      !this.cancelledAt) ||
    (this.status === StockAlertStatus.Cancelled &&
      !this.active &&
      Boolean(this.cancelledAt) &&
      !this.notifiedAt);
  if (!valid) this.invalidate('status', 'Stock alert state and timestamps are inconsistent');
});
