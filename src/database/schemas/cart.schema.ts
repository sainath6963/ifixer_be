import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { CartStatus } from '../../domain/enums';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isPositiveSafeInteger } from '../value-validators';

@Schema(embeddedSchemaOptions)
export class CartItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  variantId!: Types.ObjectId;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  quantity!: number;

  @Prop({ required: true, default: () => new Date() })
  addedAt!: Date;
}

export const CartItemSchema = SchemaFactory.createForClass(CartItem);

@Schema({ ...rootSchemaOptions, collection: 'carts' })
export class Cart {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ select: false, trim: true, minlength: 64, maxlength: 64 })
  guestTokenHash?: string;

  @Prop({ type: [CartItemSchema], default: [] })
  items!: CartItem[];

  @Prop({ enum: CartStatus, default: CartStatus.Active })
  status!: CartStatus;

  @Prop({ required: true })
  expiresAt!: Date;
}

export type CartDocument = HydratedDocument<Cart>;
export const CartSchema = SchemaFactory.createForClass(Cart);
CartSchema.index(
  { customerId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { customerId: { $type: 'objectId' }, status: CartStatus.Active },
    name: 'uq_carts_active_customer',
  },
);
CartSchema.index(
  { guestTokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: { guestTokenHash: { $type: 'string' } },
    name: 'uq_carts_guest_token_hash',
  },
);
CartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_carts_expiry' });
CartSchema.index({ status: 1, updatedAt: -1 }, { name: 'ix_carts_status_updated' });
CartSchema.pre('validate', function validateCartIdentityAndItems(): void {
  if (Boolean(this.customerId) === Boolean(this.guestTokenHash)) {
    this.invalidate('customerId', 'A cart must have exactly one customer or guest identity');
  }

  if (this.items.length > 50) {
    this.invalidate('items', 'A cart cannot contain more than 50 distinct items');
  }

  const itemKeys = this.items.map(
    (item) => `${item.productId.toHexString()}:${item.variantId.toHexString()}`,
  );
  if (new Set(itemKeys).size !== itemKeys.length) {
    this.invalidate('items', 'Cart items must be unique by product and variant');
  }
});
