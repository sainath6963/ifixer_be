import type { ProductStatus } from '../../domain/enums';

export interface PageResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CategoryView {
  id: string;
  name: string;
  slug: string;
  description?: string;
  parentId?: string;
  imageMediaId?: string;
  status: ProductStatus;
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaVariantView {
  name: string;
  width: number;
  height: number;
  sizeBytes: number;
  url: string;
}

export interface MediaAssetView {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  width?: number;
  height?: number;
  status: string;
  originalUrl: string;
  variants: MediaVariantView[];
  createdAt: Date;
}

export interface InventoryView {
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  sold: number;
  reorderPoint: number;
  version: number;
}

export interface ProductAttributeView {
  name: string;
  value: string;
}

export interface ProductVariantView {
  variantId: string;
  sku: string;
  title: string;
  attributes: ProductAttributeView[];
  priceInPaise: number;
  compareAtPriceInPaise?: number;
  isActive: boolean;
  sortOrder: number;
}

export interface ProductImageView {
  mediaAssetId: string;
  altText?: string;
  isPrimary: boolean;
  sortOrder: number;
}

export interface ProductView {
  id: string;
  name: string;
  slug: string;
  description: string;
  categoryIds: string[];
  variants: ProductVariantView[];
  images: ProductImageView[];
  tags: string[];
  status: ProductStatus;
  isFeatured: boolean;
  publishedAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  inventory?: InventoryView[];
}
