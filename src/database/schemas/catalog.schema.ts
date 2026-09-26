import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { MediaStatus, ProductStatus, StorageProvider } from '../../domain/enums';
import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'categories' })
export class Category {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 160 })
  slug!: string;

  @Prop({ trim: true, maxlength: 1000 })
  description?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Category.name })
  parentId?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'MediaAsset' })
  imageMediaId?: Types.ObjectId;

  @Prop({ enum: ProductStatus, default: ProductStatus.Draft })
  status!: ProductStatus;

  @Prop({
    type: Number,
    default: 0,
    validate: { validator: isNonNegativeSafeInteger, message: 'sortOrder must be an integer' },
  })
  sortOrder!: number;

  @Prop({ type: Number, default: 0, select: false, validate: isNonNegativeSafeInteger })
  referenceRevision!: number;
}

export type CategoryDocument = HydratedDocument<Category>;
export const CategorySchema = SchemaFactory.createForClass(Category);
CategorySchema.index({ slug: 1 }, { unique: true, name: 'uq_categories_slug' });
CategorySchema.index({ parentId: 1, status: 1, sortOrder: 1 }, { name: 'ix_categories_tree' });

@Schema({ ...embeddedSchemaOptions, versionKey: false })
export class ProductAttribute {
  @Prop({ required: true, trim: true, lowercase: true, maxlength: 50 })
  name!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  value!: string;
}

export const ProductAttributeSchema = SchemaFactory.createForClass(ProductAttribute);

@Schema({ ...embeddedSchemaOptions, versionKey: false })
export class ProductVariant {
  @Prop({ type: MongooseSchema.Types.ObjectId, default: () => new Types.ObjectId() })
  variantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 100 })
  sku!: string;

  @Prop({ required: true, trim: true, maxlength: 160 })
  title!: string;

  @Prop({ type: [ProductAttributeSchema], default: [] })
  attributes!: ProductAttribute[];

  @Prop({
    type: Number,
    required: true,
    validate: { validator: isNonNegativeSafeInteger, message: 'priceInPaise must be an integer' },
  })
  priceInPaise!: number;

  @Prop({
    type: Number,
    validate: {
      validator: isNonNegativeSafeInteger,
      message: 'compareAtPriceInPaise must be an integer',
    },
  })
  compareAtPriceInPaise?: number;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({
    type: Number,
    default: 0,
    validate: { validator: isNonNegativeSafeInteger, message: 'sortOrder must be an integer' },
  })
  sortOrder!: number;
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant);

@Schema({ ...embeddedSchemaOptions, versionKey: false })
export class ProductImage {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'MediaAsset', required: true })
  mediaAssetId!: Types.ObjectId;

  @Prop({ trim: true, maxlength: 180 })
  altText?: string;

  @Prop({ default: false })
  isPrimary!: boolean;

  @Prop({
    type: Number,
    default: 0,
    validate: { validator: isNonNegativeSafeInteger, message: 'sortOrder must be an integer' },
  })
  sortOrder!: number;
}

export const ProductImageSchema = SchemaFactory.createForClass(ProductImage);

@Schema({ ...rootSchemaOptions, collection: 'products' })
export class Product {
  @Prop({ required: true, enum: ['PUBLIC', 'REPAIR_INTERNAL'], default: 'PUBLIC' })
  visibility!: string;
  @Prop({ required: true, trim: true, maxlength: 180 })
  name!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 220 })
  slug!: string;

  @Prop({ required: true, trim: true, maxlength: 5000 })
  description!: string;

  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: Category.name, default: [] })
  categoryIds!: Types.ObjectId[];

  @Prop({ type: [ProductVariantSchema], required: true })
  variants!: ProductVariant[];

  @Prop({ type: [ProductImageSchema], default: [] })
  images!: ProductImage[];

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ enum: ProductStatus, default: ProductStatus.Draft })
  status!: ProductStatus;

  @Prop({ default: false })
  isFeatured!: boolean;

  @Prop()
  publishedAt?: Date;
}

export type ProductDocument = HydratedDocument<Product>;
export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ slug: 1 }, { unique: true, name: 'uq_products_slug' });
ProductSchema.index({ 'variants.sku': 1 }, { unique: true, name: 'uq_products_variant_sku' });
ProductSchema.index(
  { status: 1, categoryIds: 1, publishedAt: -1 },
  { name: 'ix_products_status_category_published' },
);
ProductSchema.index(
  { status: 1, isFeatured: 1, publishedAt: -1 },
  { name: 'ix_products_featured' },
);
ProductSchema.index(
  { status: 1, publishedAt: -1, _id: -1 },
  { name: 'ix_products_storefront_newest' },
);
ProductSchema.index(
  { status: 1, 'variants.isActive': 1, 'variants.priceInPaise': 1 },
  { name: 'ix_products_storefront_variant_price' },
);
ProductSchema.index(
  { name: 'text', description: 'text', tags: 'text' },
  { name: 'tx_products_search', weights: { name: 10, tags: 5, description: 1 } },
);
ProductSchema.pre('validate', function validateEmbeddedUniqueness(): void {
  const skus = this.variants.map((variant) => variant.sku.trim().toUpperCase());
  if (new Set(skus).size !== skus.length) {
    this.invalidate('variants', 'Variant SKUs must be unique within a product');
  }

  const attributeKeys = this.variants.map((variant) =>
    variant.attributes
      .map((attribute) => `${attribute.name.trim().toLowerCase()}:${attribute.value.trim()}`)
      .sort()
      .join('|'),
  );
  if (new Set(attributeKeys).size !== attributeKeys.length) {
    this.invalidate('variants', 'Variant attribute combinations must be unique');
  }

  if (this.images.filter((image) => image.isPrimary).length > 1) {
    this.invalidate('images', 'Only one product image can be primary');
  }
});

@Schema({ ...embeddedSchemaOptions, versionKey: false })
export class MediaVariant {
  @Prop({ required: true, trim: true, maxlength: 50 })
  name!: string;

  @Prop({ required: true, trim: true, maxlength: 500 })
  storageKey!: string;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  width!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  height!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  sizeBytes!: number;
}

export const MediaVariantSchema = SchemaFactory.createForClass(MediaVariant);

@Schema({ ...rootSchemaOptions, collection: 'media_assets' })
export class MediaAsset {
  @Prop({ enum: StorageProvider, default: StorageProvider.Local })
  storageProvider!: StorageProvider;

  @Prop({ required: true, trim: true, maxlength: 500 })
  storageKey!: string;

  @Prop({ required: true, trim: true, maxlength: 255 })
  originalFilename!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  mimeType!: string;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  sizeBytes!: number;

  @Prop({ required: true, lowercase: true, match: /^[a-f0-9]{64}$/ })
  checksumSha256!: string;

  @Prop({ type: Number, validate: isPositiveSafeInteger })
  width?: number;

  @Prop({ type: Number, validate: isPositiveSafeInteger })
  height?: number;

  @Prop({ enum: MediaStatus, default: MediaStatus.Pending })
  status!: MediaStatus;

  @Prop()
  deletedAt?: Date;

  @Prop({ type: [MediaVariantSchema], default: [] })
  variants!: MediaVariant[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Number, default: 0, select: false, validate: isNonNegativeSafeInteger })
  referenceRevision!: number;
}

export type MediaAssetDocument = HydratedDocument<MediaAsset>;
export const MediaAssetSchema = SchemaFactory.createForClass(MediaAsset);
MediaAssetSchema.index({ storageKey: 1 }, { unique: true, name: 'uq_media_assets_storage_key' });
MediaAssetSchema.index({ checksumSha256: 1 }, { name: 'ix_media_assets_checksum' });
MediaAssetSchema.index({ status: 1, createdAt: -1 }, { name: 'ix_media_assets_status_created' });
