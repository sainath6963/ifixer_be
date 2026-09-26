import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { ClientSession, Connection, Error as MongooseError, Model, Types } from 'mongoose';

import { Product } from '../../database/schemas/catalog.schema';
import { Order, type OrderDocument } from '../../database/schemas/order.schema';
import {
  ProductReview,
  ProductReviewDocument,
  ProductReviewSummary,
} from '../../database/schemas/product-review.schema';
import { FulfillmentStatus, ProductReviewStatus, ProductStatus } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerAuditService } from '../customer/customer-audit.service';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import type {
  AdminProductReviewListQueryDto,
  CreateProductReviewDto,
  ModerateProductReviewDto,
  ProductReviewListQueryDto,
  UpdateProductReviewDto,
} from './dto/product-review.dto';
import type {
  AdminProductReviewPage,
  AdminProductReviewView,
  CustomerProductReviewView,
  CustomerReviewEligibilityView,
  ProductReviewPage,
  PublicProductReviewView,
  ReviewSummaryView,
} from './product-review.types';

@Injectable()
export class ProductReviewService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ProductReview.name) private readonly reviews: Model<ProductReview>,
    @InjectModel(ProductReviewSummary.name)
    private readonly summaries: Model<ProductReviewSummary>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    private readonly customerAudit: CustomerAuditService,
    private readonly adminAudit: AuthAuditService,
  ) {}

  async publicList(
    productId: string,
    query: ProductReviewListQueryDto,
  ): Promise<ProductReviewPage> {
    const productObjectId = this.objectId(productId, 'PRODUCT_NOT_FOUND');
    const product = await this.products.exists({
      _id: productObjectId,
      status: ProductStatus.Active,
    });
    if (!product) throw this.productNotFound();
    const filter = { productId: productObjectId, status: ProductReviewStatus.Published };
    const [documents, total, summaryDocument] = await Promise.all([
      this.reviews
        .find(filter)
        .sort({ publishedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.reviews.countDocuments(filter),
      this.summaries.findOne({ productId: productObjectId }).exec(),
    ]);
    return {
      items: documents.map((document) => this.toPublicView(document)),
      summary: this.toSummary(summaryDocument),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async eligibility(
    customer: AuthenticatedCustomer,
    productId: string,
  ): Promise<CustomerReviewEligibilityView> {
    const productObjectId = this.objectId(productId, 'PRODUCT_NOT_FOUND');
    if (!(await this.products.exists({ _id: productObjectId }))) throw this.productNotFound();
    const existing = await this.reviews
      .findOne({ customerId: new Types.ObjectId(customer.id), productId: productObjectId })
      .exec();
    if (existing) {
      return {
        eligible: true,
        reason: this.existingReviewReason(existing.status),
        deliveredOrderNumber: existing.orderNumber,
        review: this.toCustomerView(existing),
      };
    }
    const order = await this.deliveredOrder(customer.id, productObjectId);
    return order
      ? { eligible: true, deliveredOrderNumber: order.orderNumber }
      : {
          eligible: false,
          reason: 'A delivered order containing this product is required before reviewing it.',
        };
  }

  async create(
    customer: AuthenticatedCustomer,
    input: CreateProductReviewDto,
    context: AuthRequestContext,
  ): Promise<CustomerProductReviewView> {
    const productId = this.objectId(input.productId, 'PRODUCT_NOT_FOUND');
    try {
      const document = await this.connection.transaction(async (session) => {
        const product = await this.products.findById(productId).session(session).exec();
        if (!product) throw this.productNotFound();
        const order = await this.deliveredOrder(customer.id, productId, session);
        if (!order) {
          throw new ConflictException({
            code: 'REVIEW_NOT_ELIGIBLE',
            message: 'Only customers with a delivered order can review this product',
          });
        }
        const [created] = await this.reviews.create(
          [
            {
              productId,
              customerId: new Types.ObjectId(customer.id),
              orderId: order._id,
              orderNumber: order.orderNumber,
              productName: product.name,
              productSlug: product.slug,
              displayName: this.publicDisplayName(customer.name),
              rating: input.rating,
              title: input.title.trim(),
              body: input.body.trim(),
              status: ProductReviewStatus.Pending,
            },
          ],
          { session },
        );
        await this.customerAudit.record(
          {
            action: 'PRODUCT_REVIEW_SUBMITTED',
            resourceType: 'PRODUCT_REVIEW',
            resourceId: created.id,
            actorId: customer.id,
            context,
            metadata: { productId: product.id, orderNumber: order.orderNumber },
          },
          session,
        );
        return created;
      });
      return this.toCustomerView(document);
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ConflictException({
          code: 'REVIEW_ALREADY_EXISTS',
          message: 'You already have a review for this product',
        });
      }
      throw error;
    }
  }

  async update(
    customer: AuthenticatedCustomer,
    reviewId: string,
    input: UpdateProductReviewDto,
    context: AuthRequestContext,
  ): Promise<CustomerProductReviewView> {
    const id = this.objectId(reviewId, 'REVIEW_NOT_FOUND');
    try {
      const document = await this.connection.transaction(async (session) => {
        const review = await this.reviews
          .findOne({ _id: id, customerId: new Types.ObjectId(customer.id) })
          .session(session)
          .exec();
        if (!review) throw this.reviewNotFound();
        if (review.get('version') !== input.expectedVersion) throw this.versionConflict();
        const wasPublished = review.status === ProductReviewStatus.Published;
        const previousRating = review.rating;
        review.rating = input.rating;
        review.title = input.title.trim();
        review.body = input.body.trim();
        review.status = ProductReviewStatus.Pending;
        review.moderatedBy = undefined;
        review.moderatedAt = undefined;
        review.publishedAt = undefined;
        review.rejectionReason = undefined;
        review.withdrawnAt = undefined;
        await review.save({ session });
        if (wasPublished) {
          await this.adjustSummary(review.productId, -1, -previousRating, session);
        }
        await this.customerAudit.record(
          {
            action: 'PRODUCT_REVIEW_UPDATED',
            resourceType: 'PRODUCT_REVIEW',
            resourceId: review.id,
            actorId: customer.id,
            context,
            metadata: { productId: review.productId.toHexString() },
          },
          session,
        );
        return review;
      });
      return this.toCustomerView(document);
    } catch (error: unknown) {
      if (error instanceof MongooseError.VersionError) throw this.versionConflict();
      throw error;
    }
  }

  async withdraw(
    customer: AuthenticatedCustomer,
    reviewId: string,
    expectedVersion: number,
    context: AuthRequestContext,
  ): Promise<CustomerProductReviewView> {
    const id = this.objectId(reviewId, 'REVIEW_NOT_FOUND');
    try {
      const document = await this.connection.transaction(async (session) => {
        const review = await this.reviews
          .findOne({ _id: id, customerId: new Types.ObjectId(customer.id) })
          .session(session)
          .exec();
        if (!review) throw this.reviewNotFound();
        if (review.get('version') !== expectedVersion) throw this.versionConflict();
        if (review.status === ProductReviewStatus.Withdrawn) return review;
        const wasPublished = review.status === ProductReviewStatus.Published;
        const previousRating = review.rating;
        review.status = ProductReviewStatus.Withdrawn;
        review.withdrawnAt = new Date();
        review.publishedAt = undefined;
        review.rejectionReason = undefined;
        review.moderatedBy = undefined;
        review.moderatedAt = undefined;
        await review.save({ session });
        if (wasPublished) {
          await this.adjustSummary(review.productId, -1, -previousRating, session);
        }
        await this.customerAudit.record(
          {
            action: 'PRODUCT_REVIEW_WITHDRAWN',
            resourceType: 'PRODUCT_REVIEW',
            resourceId: review.id,
            actorId: customer.id,
            context,
          },
          session,
        );
        return review;
      });
      return this.toCustomerView(document);
    } catch (error: unknown) {
      if (error instanceof MongooseError.VersionError) throw this.versionConflict();
      throw error;
    }
  }

  async adminList(query: AdminProductReviewListQueryDto): Promise<AdminProductReviewPage> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.rating) filter.rating = query.rating;
    const search = query.search?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { productName: { $regex: escaped, $options: 'i' } },
        { orderNumber: { $regex: escaped, $options: 'i' } },
        { displayName: { $regex: escaped, $options: 'i' } },
        { title: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [documents, total] = await Promise.all([
      this.reviews
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.reviews.countDocuments(filter),
    ]);
    return {
      items: documents.map((document) => this.toAdminView(document)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async moderate(
    reviewId: string,
    input: ModerateProductReviewDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<AdminProductReviewView> {
    if (![ProductReviewStatus.Published, ProductReviewStatus.Rejected].includes(input.status)) {
      throw new BadRequestException({
        code: 'REVIEW_MODERATION_STATUS_INVALID',
        message: 'Moderation can only publish or reject a review',
      });
    }
    const rejectionReason = input.rejectionReason?.trim();
    if (input.status === ProductReviewStatus.Rejected && !rejectionReason) {
      throw new BadRequestException({
        code: 'REVIEW_REJECTION_REASON_REQUIRED',
        message: 'A rejection reason is required',
      });
    }
    const id = this.objectId(reviewId, 'REVIEW_NOT_FOUND');
    try {
      const document = await this.connection.transaction(async (session) => {
        const review = await this.reviews.findById(id).session(session).exec();
        if (!review) throw this.reviewNotFound();
        if (review.get('version') !== input.expectedVersion) throw this.versionConflict();
        if (review.status === ProductReviewStatus.Withdrawn) {
          throw new ConflictException({
            code: 'REVIEW_WITHDRAWN',
            message: 'A withdrawn review cannot be moderated',
          });
        }
        const wasPublished = review.status === ProductReviewStatus.Published;
        const now = new Date();
        review.status = input.status;
        review.moderatedBy = new Types.ObjectId(admin.id);
        review.moderatedAt = now;
        review.withdrawnAt = undefined;
        if (input.status === ProductReviewStatus.Published) {
          review.publishedAt = wasPublished ? review.publishedAt : now;
          review.rejectionReason = undefined;
        } else {
          review.publishedAt = undefined;
          review.rejectionReason = rejectionReason;
        }
        await review.save({ session });
        if (!wasPublished && input.status === ProductReviewStatus.Published) {
          await this.adjustSummary(review.productId, 1, review.rating, session);
        } else if (wasPublished && input.status === ProductReviewStatus.Rejected) {
          await this.adjustSummary(review.productId, -1, -review.rating, session);
        }
        await this.adminAudit.record(
          {
            action:
              input.status === ProductReviewStatus.Published
                ? 'PRODUCT_REVIEW_PUBLISHED'
                : 'PRODUCT_REVIEW_REJECTED',
            resourceType: 'PRODUCT_REVIEW',
            resourceId: review.id,
            actorId: admin.id,
            context,
            metadata: {
              productId: review.productId.toHexString(),
              previousStatus: wasPublished ? ProductReviewStatus.Published : 'UNPUBLISHED',
              status: review.status,
            },
          },
          session,
        );
        return review;
      });
      return this.toAdminView(document);
    } catch (error: unknown) {
      if (error instanceof MongooseError.VersionError) throw this.versionConflict();
      throw error;
    }
  }

  private async deliveredOrder(
    customerId: string,
    productId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<OrderDocument | null> {
    const query = this.orders
      .findOne({
        customerId: new Types.ObjectId(customerId),
        fulfillmentStatus: FulfillmentStatus.Delivered,
        'items.productId': productId,
      })
      .sort({ 'shipping.deliveredAt': -1, createdAt: -1 });
    if (session) query.session(session);
    return query.exec();
  }

  private async adjustSummary(
    productId: Types.ObjectId,
    reviewCount: 1 | -1,
    ratingTotal: number,
    session: ClientSession,
  ): Promise<void> {
    if (reviewCount === 1) {
      await this.summaries.updateOne(
        { productId },
        {
          $setOnInsert: { productId },
          $inc: { reviewCount, ratingTotal },
        },
        { upsert: true, session, runValidators: true, setDefaultsOnInsert: false },
      );
      return;
    }
    const result = await this.summaries.updateOne(
      {
        productId,
        reviewCount: { $gte: 1 },
        ratingTotal: { $gte: -ratingTotal },
      },
      { $inc: { reviewCount, ratingTotal } },
      { session, runValidators: true },
    );
    if (result.modifiedCount !== 1) throw new Error('Product review summary invariant failed');
  }

  private toPublicView(document: ProductReviewDocument): PublicProductReviewView {
    if (!document.publishedAt) throw new Error('Published review timestamp is missing');
    return {
      id: document.id,
      rating: document.rating,
      title: document.title,
      body: document.body,
      displayName: document.displayName,
      verifiedPurchase: true,
      publishedAt: document.publishedAt,
    };
  }

  private toCustomerView(document: ProductReviewDocument): CustomerProductReviewView {
    return {
      id: document.id,
      productId: document.productId.toHexString(),
      productName: document.productName,
      productSlug: document.productSlug,
      orderNumber: document.orderNumber,
      rating: document.rating,
      title: document.title,
      body: document.body,
      status: document.status,
      rejectionReason: document.rejectionReason,
      publishedAt: document.publishedAt,
      withdrawnAt: document.withdrawnAt,
      version: document.get('version') as number,
      createdAt: document.get('createdAt') as Date,
      updatedAt: document.get('updatedAt') as Date,
    };
  }

  private toAdminView(document: ProductReviewDocument): AdminProductReviewView {
    return {
      ...this.toCustomerView(document),
      customerId: document.customerId.toHexString(),
      orderId: document.orderId.toHexString(),
      displayName: document.displayName,
      moderatedBy: document.moderatedBy?.toHexString(),
      moderatedAt: document.moderatedAt,
    };
  }

  private toSummary(document: ProductReviewSummary | null): ReviewSummaryView {
    const reviewCount = document?.reviewCount ?? 0;
    const ratingTotal = document?.ratingTotal ?? 0;
    return {
      reviewCount,
      averageRating: reviewCount ? Number((ratingTotal / reviewCount).toFixed(1)) : 0,
    };
  }

  private publicDisplayName(name: string | undefined): string {
    const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (!parts.length) return 'Verified customer';
    if (parts.length === 1) return parts[0].slice(0, 80);
    return `${parts[0]} ${parts.at(-1)?.charAt(0).toUpperCase()}.`.slice(0, 80);
  }

  private existingReviewReason(status: ProductReviewStatus): string {
    if (status === ProductReviewStatus.Published) return 'Your verified review is published.';
    if (status === ProductReviewStatus.Pending) return 'Your review is awaiting moderation.';
    if (status === ProductReviewStatus.Rejected) return 'Revise the review and submit it again.';
    return 'Your review is withdrawn. You can revise and resubmit it.';
  }

  private objectId(value: string, code: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new NotFoundException({
        code,
        message: code === 'PRODUCT_NOT_FOUND' ? 'Product not found' : 'Review not found',
      });
    }
    return new Types.ObjectId(value);
  }

  private productNotFound(): NotFoundException {
    return new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
  }

  private reviewNotFound(): NotFoundException {
    return new NotFoundException({ code: 'REVIEW_NOT_FOUND', message: 'Review not found' });
  }

  private versionConflict(): ConflictException {
    return new ConflictException({
      code: 'REVIEW_VERSION_CONFLICT',
      message: 'This review changed elsewhere. Refresh and try again.',
    });
  }
}
