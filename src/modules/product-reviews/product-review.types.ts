import type { ProductReviewStatus } from '../../domain/enums';

export interface PublicProductReviewView {
  id: string;
  rating: number;
  title: string;
  body: string;
  displayName: string;
  verifiedPurchase: true;
  publishedAt: Date;
}

export interface CustomerProductReviewView {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  orderNumber: string;
  rating: number;
  title: string;
  body: string;
  status: ProductReviewStatus;
  rejectionReason?: string;
  publishedAt?: Date;
  withdrawnAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminProductReviewView extends CustomerProductReviewView {
  customerId: string;
  orderId: string;
  displayName: string;
  moderatedBy?: string;
  moderatedAt?: Date;
}

export interface ReviewSummaryView {
  reviewCount: number;
  averageRating: number;
}

export interface ProductReviewPage {
  items: PublicProductReviewView[];
  summary: ReviewSummaryView;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AdminProductReviewPage {
  items: AdminProductReviewView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CustomerReviewEligibilityView {
  eligible: boolean;
  reason?: string;
  deliveredOrderNumber?: string;
  review?: CustomerProductReviewView;
}
