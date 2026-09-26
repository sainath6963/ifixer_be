import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import {
  Category,
  MediaAsset,
  Product,
  ProductDocument,
} from '../../database/schemas/catalog.schema';
import {
  InventoryLevel,
  InventoryLevelDocument,
  InventoryMovement,
  InventoryReservation,
} from '../../database/schemas/inventory.schema';
import {
  InventoryMovementType,
  InventoryReservationStatus,
  MediaStatus,
  ProductStatus,
} from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { InventoryView, PageResult, ProductView } from './catalog.types';
import type { AdjustInventoryDto } from './dto/inventory.dto';
import type {
  AddProductVariantDto,
  CreateProductDto,
  CreateProductVariantDto,
  ProductListQueryDto,
  ReplaceProductImagesDto,
  UpdateProductDto,
  UpdateProductVariantDto,
} from './dto/product.dto';

interface VariantIdentity {
  sku: string;
  attributes: Array<{ name: string; value: string }>;
}

@Injectable()
export class ProductService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Category.name) private readonly categories: Model<Category>,
    @InjectModel(MediaAsset.name) private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(InventoryMovement.name)
    private readonly movements: Model<InventoryMovement>,
    @InjectModel(InventoryReservation.name)
    private readonly reservations: Model<InventoryReservation>,
    private readonly audit: AuthAuditService,
  ) {}

  async create(
    input: CreateProductDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<ProductView> {
    this.validateVariantInputs(input.variants);
    if (input.isFeatured) {
      throw new ConflictException({
        code: 'FEATURED_PRODUCT_INACTIVE',
        message: 'Publish the product before featuring it',
      });
    }
    const categoryIds = input.categoryIds ?? [];
    const productId = new Types.ObjectId();
    const variants = input.variants.map((variant) => ({
      variantId: new Types.ObjectId(),
      sku: variant.sku,
      title: variant.title.trim(),
      attributes: variant.attributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value.trim(),
      })),
      priceInPaise: variant.priceInPaise,
      compareAtPriceInPaise: variant.compareAtPriceInPaise,
      isActive: variant.isActive ?? true,
      sortOrder: variant.sortOrder ?? 0,
    }));

    try {
      const created = await this.connection.transaction(
        async (session): Promise<ProductDocument> => {
          await this.validateCategories(categoryIds, false, session);
          const [document] = await this.products.create(
            [
              {
                _id: productId,
                name: input.name.trim(),
                slug: input.slug,
                description: input.description.trim(),
                categoryIds: categoryIds.map((id) => new Types.ObjectId(id)),
                variants,
                images: [],
                tags: (input.tags ?? []).map((tag) => tag.trim().toLowerCase()),
                status: ProductStatus.Draft,
                isFeatured: input.isFeatured ?? false,
              },
            ],
            { session },
          );
          await this.inventory.create(
            input.variants.map((variant, index) => ({
              productId,
              variantId: variants[index].variantId,
              sku: variant.sku,
              onHand: variant.initialOnHand ?? 0,
              reserved: 0,
              sold: 0,
              reorderPoint: variant.reorderPoint ?? 0,
            })),
            { session },
          );
          const initialMovements = input.variants
            .map((variant, index) => ({ variant, variantId: variants[index].variantId }))
            .filter(({ variant }) => (variant.initialOnHand ?? 0) > 0)
            .map(({ variant, variantId }) => ({
              productId,
              variantId,
              type: InventoryMovementType.Restock,
              deltaOnHand: variant.initialOnHand,
              deltaReserved: 0,
              deltaSold: 0,
              referenceType: 'PRODUCT_CREATE',
              referenceId: productId.toHexString(),
              actorId: new Types.ObjectId(admin.id),
              note: 'Initial stock entered with product creation',
            }));
          if (initialMovements.length) {
            await this.movements.create(initialMovements, { session });
          }
          await this.audit.record(
            {
              action: 'PRODUCT_CREATED',
              resourceType: 'PRODUCT',
              resourceId: document.id,
              actorId: admin.id,
              context,
              metadata: { variantCount: variants.length },
            },
            session,
          );
          return document;
        },
      );
      return this.withInventory(created);
    } catch (error: unknown) {
      this.rethrowProductDuplicate(error);
      throw error;
    }
  }

  async list(query: ProductListQueryDto): Promise<PageResult<ProductView>> {
    const filter: Record<string, unknown> = { visibility: { $ne: 'REPAIR_INTERNAL' } };
    if (query.status) filter.status = query.status;
    if (query.categoryId) filter.categoryIds = new Types.ObjectId(query.categoryId);
    if (query.search?.trim()) filter.$text = { $search: query.search.trim() };
    const skip = (query.page - 1) * query.limit;
    const documentsPromise = query.search?.trim()
      ? this.products
          .find(filter)
          .sort({ score: { $meta: 'textScore' }, _id: -1 })
          .skip(skip)
          .limit(query.limit)
          .exec()
      : this.products
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(query.limit)
          .exec();
    const [documents, total] = await Promise.all([
      documentsPromise,
      this.products.countDocuments(filter),
    ]);
    return {
      items: documents.map((document) => this.toView(document)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(id: string): Promise<ProductView> {
    return this.withInventory(await this.findProduct(id));
  }

  async update(
    id: string,
    input: UpdateProductDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<ProductView> {
    this.assertObjectId(id);
    try {
      const updated = await this.connection.transaction(
        async (session): Promise<ProductDocument> => {
          const product = await this.products
            .findOne({ _id: id, visibility: { $ne: 'REPAIR_INTERNAL' } })
            .session(session)
            .exec();
          if (!product) throw this.notFound();
          this.assertVersion(product, input.expectedVersion);
          if (product.status === ProductStatus.Archived) {
            throw new ConflictException({
              code: 'PRODUCT_ARCHIVED',
              message: 'Archived products cannot be restored or edited',
            });
          }

          const categoryIds =
            input.categoryIds ?? product.categoryIds.map((value) => value.toHexString());
          const nextStatus = input.status ?? product.status;
          await this.validateCategories(categoryIds, nextStatus === ProductStatus.Active, session);
          if (nextStatus === ProductStatus.Active) {
            await this.validatePublishable(product, session);
          }
          if ((input.isFeatured ?? product.isFeatured) && nextStatus !== ProductStatus.Active) {
            throw new ConflictException({
              code: 'FEATURED_PRODUCT_INACTIVE',
              message: 'Only an active product can be featured',
            });
          }
          if (input.status === ProductStatus.Archived) {
            const activeReservation = await this.reservations
              .exists({ productId: product._id, status: InventoryReservationStatus.Active })
              .session(session);
            if (activeReservation) {
              throw new ConflictException({
                code: 'PRODUCT_ARCHIVE_BLOCKED',
                message: 'Product has active inventory reservations',
              });
            }
          }

          if (input.name !== undefined) product.name = input.name.trim();
          if (input.slug !== undefined) product.slug = input.slug;
          if (input.description !== undefined) product.description = input.description.trim();
          if (input.categoryIds !== undefined) {
            product.categoryIds = input.categoryIds.map((value) => new Types.ObjectId(value));
          }
          if (input.tags !== undefined) {
            product.tags = input.tags.map((tag) => tag.trim().toLowerCase());
          }
          if (input.status !== undefined) {
            product.status = input.status;
            if (input.status === ProductStatus.Active && !product.publishedAt) {
              product.publishedAt = new Date();
            }
          }
          if (input.isFeatured !== undefined) product.isFeatured = input.isFeatured;
          await product.save({ session });
          await this.audit.record(
            {
              action: 'PRODUCT_UPDATED',
              resourceType: 'PRODUCT',
              resourceId: product.id,
              actorId: admin.id,
              context,
              metadata: { status: product.status },
            },
            session,
          );
          return product;
        },
      );
      return this.withInventory(updated);
    } catch (error: unknown) {
      this.rethrowProductDuplicate(error);
      throw error;
    }
  }

  async addVariant(
    productId: string,
    input: AddProductVariantDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<ProductView> {
    this.assertObjectId(productId);
    this.validateVariantInputs([input]);
    const variantId = new Types.ObjectId();
    try {
      const product = await this.connection.transaction(
        async (session): Promise<ProductDocument> => {
          const document = await this.products
            .findOne({ _id: productId, visibility: { $ne: 'REPAIR_INTERNAL' } })
            .session(session)
            .exec();
          if (!document) throw this.notFound();
          this.assertMutable(document, input.expectedProductVersion);
          this.validateVariantUniqueness([...document.variants, input]);
          document.variants.push({
            variantId,
            sku: input.sku,
            title: input.title.trim(),
            attributes: input.attributes.map((attribute) => ({
              name: attribute.name,
              value: attribute.value.trim(),
            })),
            priceInPaise: input.priceInPaise,
            compareAtPriceInPaise: input.compareAtPriceInPaise,
            isActive: input.isActive ?? true,
            sortOrder: input.sortOrder ?? 0,
          });
          await document.save({ session });
          await this.inventory.create(
            [
              {
                productId: document._id,
                variantId,
                sku: input.sku,
                onHand: input.initialOnHand ?? 0,
                reserved: 0,
                sold: 0,
                reorderPoint: input.reorderPoint ?? 0,
              },
            ],
            { session },
          );
          if ((input.initialOnHand ?? 0) > 0) {
            await this.movements.create(
              [
                {
                  productId: document._id,
                  variantId,
                  type: InventoryMovementType.Restock,
                  deltaOnHand: input.initialOnHand,
                  deltaReserved: 0,
                  deltaSold: 0,
                  referenceType: 'VARIANT_CREATE',
                  referenceId: variantId.toHexString(),
                  actorId: new Types.ObjectId(admin.id),
                  note: 'Initial stock entered with variant creation',
                },
              ],
              { session },
            );
          }
          await this.audit.record(
            {
              action: 'PRODUCT_VARIANT_CREATED',
              resourceType: 'PRODUCT',
              resourceId: document.id,
              actorId: admin.id,
              context,
              metadata: { variantId: variantId.toHexString(), sku: input.sku },
            },
            session,
          );
          return document;
        },
      );
      return this.withInventory(product);
    } catch (error: unknown) {
      this.rethrowProductDuplicate(error);
      throw error;
    }
  }

  async updateVariant(
    productId: string,
    variantId: string,
    input: UpdateProductVariantDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<ProductView> {
    this.assertObjectId(productId);
    this.assertObjectId(variantId);
    try {
      const product = await this.connection.transaction(
        async (session): Promise<ProductDocument> => {
          const document = await this.products
            .findOne({ _id: productId, visibility: { $ne: 'REPAIR_INTERNAL' } })
            .session(session)
            .exec();
          if (!document) throw this.notFound();
          this.assertMutable(document, input.expectedProductVersion);
          const variant = document.variants.find(
            (item) => item.variantId.toHexString() === variantId,
          );
          if (!variant) throw this.variantNotFound();

          if (input.sku !== undefined) variant.sku = input.sku;
          if (input.title !== undefined) variant.title = input.title.trim();
          if (input.attributes !== undefined) {
            variant.attributes = input.attributes.map((attribute) => ({
              name: attribute.name,
              value: attribute.value.trim(),
            }));
          }
          if (input.priceInPaise !== undefined) variant.priceInPaise = input.priceInPaise;
          if (Object.prototype.hasOwnProperty.call(input, 'compareAtPriceInPaise')) {
            variant.compareAtPriceInPaise = input.compareAtPriceInPaise;
          }
          if (input.isActive !== undefined) variant.isActive = input.isActive;
          if (input.sortOrder !== undefined) variant.sortOrder = input.sortOrder;
          this.validateVariantPrices(variant.priceInPaise, variant.compareAtPriceInPaise);
          this.validateVariantUniqueness(document.variants);
          if (
            document.status === ProductStatus.Active &&
            !document.variants.some((item) => item.isActive)
          ) {
            throw new ConflictException({
              code: 'PRODUCT_ACTIVE_VARIANT_REQUIRED',
              message: 'Unpublish the product before deactivating its last active variant',
            });
          }
          await document.save({ session });
          if (input.sku !== undefined) {
            const inventoryUpdated = await this.inventory.updateOne(
              { productId: document._id, variantId: new Types.ObjectId(variantId) },
              { $set: { sku: input.sku }, $inc: { version: 1 } },
              { session },
            );
            if (inventoryUpdated.matchedCount !== 1) throw this.inventoryNotFound();
          }
          await this.audit.record(
            {
              action: 'PRODUCT_VARIANT_UPDATED',
              resourceType: 'PRODUCT',
              resourceId: document.id,
              actorId: admin.id,
              context,
              metadata: { variantId, sku: variant.sku, isActive: variant.isActive },
            },
            session,
          );
          return document;
        },
      );
      return this.withInventory(product);
    } catch (error: unknown) {
      this.rethrowProductDuplicate(error);
      throw error;
    }
  }

  async replaceImages(
    productId: string,
    input: ReplaceProductImagesDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<ProductView> {
    this.assertObjectId(productId);
    const ids = input.images.map((image) => image.mediaAssetId);
    if (
      new Set(ids).size !== ids.length ||
      input.images.filter((image) => image.isPrimary).length > 1
    ) {
      throw new ConflictException({
        code: 'PRODUCT_IMAGES_INVALID',
        message: 'Images must be unique and may contain only one primary image',
      });
    }

    const product = await this.connection.transaction(async (session): Promise<ProductDocument> => {
      const document = await this.products
        .findOne({ _id: productId, visibility: { $ne: 'REPAIR_INTERNAL' } })
        .session(session)
        .exec();
      if (!document) throw this.notFound();
      this.assertMutable(document, input.expectedProductVersion);
      await this.validateMediaIds(ids, session);
      if (
        document.status === ProductStatus.Active &&
        !input.images.some((image) => image.isPrimary)
      ) {
        throw new ConflictException({
          code: 'PRODUCT_PRIMARY_IMAGE_REQUIRED',
          message: 'An active product requires a primary image',
        });
      }
      document.images = input.images.map((image) => ({
        mediaAssetId: new Types.ObjectId(image.mediaAssetId),
        altText: image.altText?.trim(),
        isPrimary: image.isPrimary ?? false,
        sortOrder: image.sortOrder ?? 0,
      }));
      await document.save({ session });
      await this.audit.record(
        {
          action: 'PRODUCT_IMAGES_REPLACED',
          resourceType: 'PRODUCT',
          resourceId: document.id,
          actorId: admin.id,
          context,
          metadata: { imageCount: document.images.length },
        },
        session,
      );
      return document;
    });
    return this.withInventory(product);
  }

  async adjustInventory(
    productId: string,
    variantId: string,
    input: AdjustInventoryDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<InventoryView> {
    this.assertObjectId(productId);
    this.assertObjectId(variantId);
    return this.connection.transaction(async (session): Promise<InventoryView> => {
      const existing = await this.movements
        .findOne({
          referenceType: 'ADMIN_ADJUSTMENT',
          referenceId: input.idempotencyKey,
          variantId: new Types.ObjectId(variantId),
        })
        .session(session)
        .exec();
      if (existing) {
        if (
          existing.productId.toHexString() !== productId ||
          existing.deltaOnHand !== input.deltaOnHand
        ) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key was already used with different adjustment data',
          });
        }
        const current = await this.inventory
          .findOne({ productId, variantId })
          .session(session)
          .exec();
        if (!current) throw this.inventoryNotFound();
        return this.toInventoryView(current);
      }

      const product = await this.products
        .exists({
          _id: new Types.ObjectId(productId),
          status: { $ne: ProductStatus.Archived },
          visibility: { $ne: 'REPAIR_INTERNAL' },
          'variants.variantId': new Types.ObjectId(variantId),
        })
        .session(session);
      if (!product) throw this.variantNotFound();

      const updated = await this.inventory
        .findOneAndUpdate(
          {
            productId: new Types.ObjectId(productId),
            variantId: new Types.ObjectId(variantId),
            $expr: {
              $and: [
                { $gte: [{ $add: ['$onHand', input.deltaOnHand] }, 0] },
                { $gte: [{ $add: ['$onHand', input.deltaOnHand] }, '$reserved'] },
              ],
            },
          },
          { $inc: { onHand: input.deltaOnHand, version: 1 } },
          { session, returnDocument: 'after' },
        )
        .exec();
      if (!updated) {
        throw new ConflictException({
          code: 'INVENTORY_ADJUSTMENT_INVALID',
          message: 'Adjustment cannot reduce on-hand stock below zero or reserved stock',
        });
      }
      await this.movements.create(
        [
          {
            productId: new Types.ObjectId(productId),
            variantId: new Types.ObjectId(variantId),
            type: InventoryMovementType.Adjustment,
            deltaOnHand: input.deltaOnHand,
            deltaReserved: 0,
            deltaSold: 0,
            referenceType: 'ADMIN_ADJUSTMENT',
            referenceId: input.idempotencyKey,
            actorId: new Types.ObjectId(admin.id),
            note: input.note.trim(),
          },
        ],
        { session },
      );
      await this.audit.record(
        {
          action: 'INVENTORY_ADJUSTED',
          resourceType: 'INVENTORY_LEVEL',
          resourceId: updated.id,
          actorId: admin.id,
          context,
          metadata: { productId, variantId, deltaOnHand: input.deltaOnHand },
        },
        session,
      );
      return this.toInventoryView(updated);
    });
  }

  private async withInventory(product: ProductDocument): Promise<ProductView> {
    const levels = await this.inventory.find({ productId: product._id }).sort({ sku: 1 }).exec();
    return {
      ...this.toView(product),
      inventory: levels.map((level) => this.toInventoryView(level)),
    };
  }

  private async findProduct(id: string): Promise<ProductDocument> {
    this.assertObjectId(id);
    const product = await this.products
      .findOne({ _id: id, visibility: { $ne: 'REPAIR_INTERNAL' } })
      .exec();
    if (!product) throw this.notFound();
    return product;
  }

  private async validateCategories(
    categoryIds: string[],
    requireActive: boolean,
    session: ClientSession,
  ): Promise<void> {
    if (!categoryIds.length) {
      if (requireActive) {
        throw new ConflictException({
          code: 'PRODUCT_CATEGORY_REQUIRED',
          message: 'An active product requires at least one active category',
        });
      }
      return;
    }
    const objectIds = categoryIds.map((id) => new Types.ObjectId(id));
    const count = await this.categories
      .countDocuments({
        _id: { $in: objectIds },
        status: requireActive ? ProductStatus.Active : { $ne: ProductStatus.Archived },
      })
      .session(session);
    if (count !== new Set(categoryIds).size) {
      throw new ConflictException({
        code: 'PRODUCT_CATEGORY_INVALID',
        message: requireActive
          ? 'Every category must be active before publishing'
          : 'Every category must exist and not be archived',
      });
    }
    await this.categories.updateMany(
      {
        _id: { $in: objectIds },
        status: requireActive ? ProductStatus.Active : { $ne: ProductStatus.Archived },
      },
      { $inc: { referenceRevision: 1 } },
      { session },
    );
  }

  private async validatePublishable(
    product: ProductDocument,
    session: ClientSession,
  ): Promise<void> {
    if (!product.variants.some((variant) => variant.isActive)) {
      throw new ConflictException({
        code: 'PRODUCT_ACTIVE_VARIANT_REQUIRED',
        message: 'A product requires an active variant before publishing',
      });
    }
    const primary = product.images.find((image) => image.isPrimary);
    if (!primary) {
      throw new ConflictException({
        code: 'PRODUCT_PRIMARY_IMAGE_REQUIRED',
        message: 'A product requires a primary image before publishing',
      });
    }
    await this.validateMediaIds([primary.mediaAssetId.toHexString()], session);
  }

  private async validateMediaIds(ids: string[], session: ClientSession): Promise<void> {
    if (!ids.length) return;
    const count = await this.mediaAssets
      .countDocuments({
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        status: MediaStatus.Ready,
      })
      .session(session);
    if (count !== new Set(ids).size) {
      throw new ConflictException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'Every product image must reference a ready media asset',
      });
    }
    await this.mediaAssets.updateMany(
      { _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, status: MediaStatus.Ready },
      { $inc: { referenceRevision: 1 } },
      { session },
    );
  }

  private validateVariantInputs(variants: CreateProductVariantDto[]): void {
    for (const variant of variants) {
      this.validateVariantPrices(variant.priceInPaise, variant.compareAtPriceInPaise);
      const attributeNames = variant.attributes.map((attribute) => attribute.name);
      if (new Set(attributeNames).size !== attributeNames.length) {
        throw new ConflictException({
          code: 'PRODUCT_ATTRIBUTES_INVALID',
          message: 'Attribute names must be unique within each variant',
        });
      }
    }
    this.validateVariantUniqueness(variants);
  }

  private validateVariantUniqueness(variants: readonly VariantIdentity[]): void {
    const skus = variants.map((variant) => variant.sku.trim().toUpperCase());
    if (new Set(skus).size !== skus.length) {
      throw new ConflictException({
        code: 'PRODUCT_SKU_CONFLICT',
        message: 'Variant SKUs must be unique',
      });
    }

    const attributeKeys = variants.map((variant) =>
      variant.attributes
        .map((attribute) => `${attribute.name.trim().toLowerCase()}:${attribute.value.trim()}`)
        .sort()
        .join('|'),
    );
    if (new Set(attributeKeys).size !== attributeKeys.length) {
      throw new ConflictException({
        code: 'PRODUCT_VARIANT_ATTRIBUTES_CONFLICT',
        message: 'Variant attribute combinations must be unique',
      });
    }
  }

  private validateVariantPrices(price: number, compareAt?: number): void {
    if (compareAt !== undefined && compareAt <= price) {
      throw new ConflictException({
        code: 'PRODUCT_PRICE_INVALID',
        message: 'Compare-at price must be greater than the selling price',
      });
    }
  }

  private assertMutable(product: ProductDocument, expectedVersion: number): void {
    this.assertVersion(product, expectedVersion);
    if (product.status === ProductStatus.Archived) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'Archived products cannot be edited',
      });
    }
  }

  private assertVersion(product: ProductDocument, expectedVersion: number): void {
    if ((product.get('version') as number) !== expectedVersion) {
      throw new ConflictException({
        code: 'PRODUCT_VERSION_CONFLICT',
        message: 'Product changed since it was loaded; reload and retry',
      });
    }
  }

  private assertObjectId(value: string): void {
    if (!Types.ObjectId.isValid(value)) throw this.notFound();
  }

  private rethrowProductDuplicate(error: unknown): void {
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new ConflictException({
        code: 'PRODUCT_UNIQUE_CONFLICT',
        message: 'Product slug or variant SKU already exists',
      });
    }
  }

  private toView(product: ProductDocument): ProductView {
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      categoryIds: product.categoryIds.map((value) => value.toHexString()),
      variants: product.variants.map((variant) => ({
        variantId: variant.variantId.toHexString(),
        sku: variant.sku,
        title: variant.title,
        attributes: variant.attributes.map((attribute) => ({
          name: attribute.name,
          value: attribute.value,
        })),
        priceInPaise: variant.priceInPaise,
        compareAtPriceInPaise: variant.compareAtPriceInPaise,
        isActive: variant.isActive,
        sortOrder: variant.sortOrder,
      })),
      images: product.images.map((image) => ({
        mediaAssetId: image.mediaAssetId.toHexString(),
        altText: image.altText,
        isPrimary: image.isPrimary,
        sortOrder: image.sortOrder,
      })),
      tags: product.tags,
      status: product.status,
      isFeatured: product.isFeatured,
      publishedAt: product.publishedAt,
      version: product.get('version') as number,
      createdAt: product.get('createdAt') as Date,
      updatedAt: product.get('updatedAt') as Date,
    };
  }

  private toInventoryView(level: InventoryLevelDocument): InventoryView {
    return {
      variantId: level.variantId.toHexString(),
      sku: level.sku,
      onHand: level.onHand,
      reserved: level.reserved,
      available: level.onHand - level.reserved,
      sold: level.sold,
      reorderPoint: level.reorderPoint,
      version: level.get('version') as number,
    };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product was not found' });
  }

  private variantNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'PRODUCT_VARIANT_NOT_FOUND',
      message: 'Product variant was not found',
    });
  }

  private inventoryNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'INVENTORY_NOT_FOUND',
      message: 'Inventory level was not found',
    });
  }
}
