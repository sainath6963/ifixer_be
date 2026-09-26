import type { StorefrontImage } from '../storefront-catalog/storefront.types';

export type CartItemAvailability = 'AVAILABLE' | 'INSUFFICIENT_STOCK' | 'UNAVAILABLE';

export interface CartItemView {
  productId: string;
  variantId: string;
  quantity: number;
  availability: CartItemAvailability;
  productName?: string;
  productSlug?: string;
  variantTitle?: string;
  sku?: string;
  attributes?: Array<{ name: string; value: string }>;
  unitPriceInPaise?: number;
  lineTotalInPaise?: number;
  primaryImage?: StorefrontImage;
}

export interface CartView {
  id?: string;
  version: number;
  items: CartItemView[];
  distinctItemCount: number;
  totalQuantity: number;
  subtotalInPaise: number;
  currency: 'INR';
  readyForCheckout: boolean;
  expiresAt?: Date;
}

export interface CartIdentity {
  customerId?: string;
  guestToken?: string;
}

export interface CartOperationResult {
  cart: CartView;
  guestTokenToSet?: string;
}
