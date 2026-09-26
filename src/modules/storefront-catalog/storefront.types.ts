export type StorefrontAvailability = 'IN_STOCK' | 'OUT_OF_STOCK';

export interface StorefrontImage {
  mediaAssetId: string;
  altText: string;
  width?: number;
  height?: number;
  sources: {
    original: string;
    thumbnail: string;
    card: string;
    large: string;
  };
}

export interface StorefrontCategoryReference {
  id: string;
  name: string;
  slug: string;
}

export interface StorefrontCategory extends StorefrontCategoryReference {
  description?: string;
  image?: StorefrontImage;
  children: StorefrontCategory[];
}

export interface StorefrontPriceRange {
  minInPaise: number;
  maxInPaise: number;
  currency: 'INR';
}

export interface StorefrontProductCard {
  id: string;
  name: string;
  slug: string;
  excerpt: string;
  categories: StorefrontCategoryReference[];
  priceRange: StorefrontPriceRange;
  primaryImage?: StorefrontImage;
  availability: StorefrontAvailability;
  isFeatured: boolean;
  tags: string[];
}

export interface StorefrontVariant {
  variantId: string;
  sku: string;
  title: string;
  attributes: Array<{ name: string; value: string }>;
  priceInPaise: number;
  compareAtPriceInPaise?: number;
  currency: 'INR';
  availability: StorefrontAvailability;
}

export interface StorefrontProductDetail extends StorefrontProductCard {
  description: string;
  variants: StorefrontVariant[];
  images: StorefrontImage[];
  publishedAt: Date;
}

export interface StorefrontPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
