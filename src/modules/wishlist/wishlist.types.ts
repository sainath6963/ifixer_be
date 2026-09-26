import type { StockAlertStatus } from '../../domain/enums';
import type { StorefrontProductCard } from '../storefront-catalog/storefront.types';

export interface WishlistItemView {
  id: string;
  addedAt: Date;
  product: StorefrontProductCard;
}

export interface WishlistPage {
  items: WishlistItemView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface StockAlertView {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  productSlug: string;
  variantTitle: string;
  sku: string;
  status: StockAlertStatus;
  requestedAt: Date;
  notifiedAt?: Date;
  cancelledAt?: Date;
  version: number;
}

export interface ProductStockAlertState {
  emailEligible: boolean;
  emailEligibilityReason?: string;
  activeVariantIds: string[];
}

export interface StockDemandView {
  productId: string;
  variantId: string;
  productName: string;
  productSlug: string;
  variantTitle: string;
  sku: string;
  subscriberCount: number;
  available: number;
  lastRequestedAt: Date;
}

export interface StockDemandPage {
  items: StockDemandView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
