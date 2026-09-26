import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import {
  Category,
  CategoryDocument,
  MediaAsset,
  Product,
} from '../../database/schemas/catalog.schema';
import { MediaStatus, ProductStatus } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { CategoryView, PageResult } from './catalog.types';
import type {
  CategoryListQueryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto';

@Injectable()
export class CategoryService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Category.name) private readonly categories: Model<Category>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(MediaAsset.name) private readonly mediaAssets: Model<MediaAsset>,
    private readonly audit: AuthAuditService,
  ) {}

  async create(
    input: CreateCategoryDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<CategoryView> {
    await this.validateParent(input.parentId);
    await this.validateMedia(input.imageMediaId);
    const categoryId = new Types.ObjectId();

    try {
      const created = await this.connection.transaction(
        async (session): Promise<CategoryDocument> => {
          await this.lockMedia(input.imageMediaId, session);
          const [document] = await this.categories.create(
            [
              {
                _id: categoryId,
                name: input.name.trim(),
                slug: input.slug,
                description: input.description?.trim(),
                parentId: input.parentId ? new Types.ObjectId(input.parentId) : undefined,
                imageMediaId: input.imageMediaId
                  ? new Types.ObjectId(input.imageMediaId)
                  : undefined,
                status: ProductStatus.Draft,
                sortOrder: input.sortOrder ?? 0,
              },
            ],
            { session },
          );
          await this.audit.record(
            {
              action: 'CATEGORY_CREATED',
              resourceType: 'CATEGORY',
              resourceId: document.id,
              actorId: admin.id,
              context,
            },
            session,
          );
          return document;
        },
      );
      return this.toView(created);
    } catch (error: unknown) {
      this.rethrowDuplicate(error, 'CATEGORY_SLUG_CONFLICT', 'Category slug already exists');
      throw error;
    }
  }

  async list(query: CategoryListQueryDto): Promise<PageResult<CategoryView>> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.parentId) filter.parentId = new Types.ObjectId(query.parentId);
    const skip = (query.page - 1) * query.limit;
    const [documents, total] = await Promise.all([
      this.categories
        .find(filter)
        .sort({ sortOrder: 1, name: 1, _id: 1 })
        .skip(skip)
        .limit(query.limit),
      this.categories.countDocuments(filter),
    ]);
    return {
      items: documents.map((document) => this.toView(document)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(id: string): Promise<CategoryView> {
    const category = await this.findCategory(id);
    return this.toView(category);
  }

  async update(
    id: string,
    input: UpdateCategoryDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<CategoryView> {
    const category = await this.findCategory(id);
    this.assertVersion(category, input.expectedVersion);
    const nextParentId = this.wasProvided(input, 'parentId')
      ? input.parentId
      : category.parentId?.toHexString();
    const nextImageMediaId = this.wasProvided(input, 'imageMediaId')
      ? input.imageMediaId
      : category.imageMediaId?.toHexString();
    await this.validateParent(nextParentId, category.id);
    await this.validateMedia(nextImageMediaId);

    const nextStatus = input.status ?? category.status;
    if (nextStatus === ProductStatus.Active && nextParentId) {
      const activeParent = await this.categories.exists({
        _id: new Types.ObjectId(nextParentId),
        status: ProductStatus.Active,
      });
      if (!activeParent) {
        throw new ConflictException({
          code: 'CATEGORY_PARENT_INACTIVE',
          message: 'Activate the parent category before activating this category',
        });
      }
    }
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.slug !== undefined) set.slug = input.slug;
    if (this.wasProvided(input, 'description')) {
      if (input.description) set.description = input.description.trim();
      else unset.description = 1;
    }
    if (this.wasProvided(input, 'parentId')) {
      if (input.parentId) set.parentId = new Types.ObjectId(input.parentId);
      else unset.parentId = 1;
    }
    if (this.wasProvided(input, 'imageMediaId')) {
      if (input.imageMediaId) set.imageMediaId = new Types.ObjectId(input.imageMediaId);
      else unset.imageMediaId = 1;
    }
    if (input.status !== undefined) set.status = input.status;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;

    try {
      const updated = await this.connection.transaction(
        async (session): Promise<CategoryDocument> => {
          if (input.status === ProductStatus.Archived) {
            const activeProduct = await this.products
              .exists({ categoryIds: category._id, status: ProductStatus.Active })
              .session(session);
            const child = await this.categories
              .exists({ parentId: category._id, status: { $ne: ProductStatus.Archived } })
              .session(session);
            if (activeProduct || child) {
              throw new ConflictException({
                code: 'CATEGORY_ARCHIVE_BLOCKED',
                message: 'Archive active products and child categories first',
              });
            }
          }
          if (this.wasProvided(input, 'imageMediaId')) {
            await this.lockMedia(input.imageMediaId, session);
          }
          const document = await this.categories
            .findOneAndUpdate(
              { _id: category._id, version: input.expectedVersion },
              {
                ...(Object.keys(set).length ? { $set: set } : {}),
                ...(Object.keys(unset).length ? { $unset: unset } : {}),
                $inc: { version: 1 },
              },
              { session, runValidators: true, returnDocument: 'after' },
            )
            .exec();
          if (!document) {
            throw this.versionConflict();
          }
          await this.audit.record(
            {
              action: 'CATEGORY_UPDATED',
              resourceType: 'CATEGORY',
              resourceId: document.id,
              actorId: admin.id,
              context,
              metadata: { status: document.status },
            },
            session,
          );
          return document;
        },
      );
      return this.toView(updated);
    } catch (error: unknown) {
      this.rethrowDuplicate(error, 'CATEGORY_SLUG_CONFLICT', 'Category slug already exists');
      throw error;
    }
  }

  private async findCategory(id: string): Promise<CategoryDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw this.notFound();
    }
    const category = await this.categories.findById(id).exec();
    if (!category) throw this.notFound();
    return category;
  }

  private async validateParent(parentId?: string | null, currentId?: string): Promise<void> {
    if (!parentId) return;
    if (!Types.ObjectId.isValid(parentId) || parentId === currentId) {
      throw new ConflictException({
        code: 'CATEGORY_PARENT_INVALID',
        message: 'Category parent is invalid',
      });
    }
    let cursor: string | undefined = parentId;
    for (let depth = 0; depth < 100 && cursor; depth += 1) {
      const parent: {
        _id: Types.ObjectId;
        parentId?: Types.ObjectId;
        status: ProductStatus;
      } | null = await this.categories.findById(cursor).select('_id parentId status').lean().exec();
      if (!parent || parent.status === ProductStatus.Archived) {
        throw new ConflictException({
          code: 'CATEGORY_PARENT_INVALID',
          message: 'Parent category does not exist or is archived',
        });
      }
      if (parent._id.toHexString() === currentId) {
        throw new ConflictException({
          code: 'CATEGORY_CYCLE',
          message: 'Category hierarchy cannot contain a cycle',
        });
      }
      cursor = parent.parentId?.toHexString();
    }
    if (cursor) {
      throw new ConflictException({
        code: 'CATEGORY_DEPTH_EXCEEDED',
        message: 'Category hierarchy exceeds the supported depth',
      });
    }
  }

  private async validateMedia(mediaId?: string | null): Promise<void> {
    if (!mediaId) return;
    const exists = Types.ObjectId.isValid(mediaId)
      ? await this.mediaAssets.exists({ _id: mediaId, status: MediaStatus.Ready })
      : null;
    if (!exists) {
      throw new ConflictException({
        code: 'CATEGORY_MEDIA_INVALID',
        message: 'Category image must reference a ready media asset',
      });
    }
  }

  private async lockMedia(
    mediaId: string | null | undefined,
    session: ClientSession,
  ): Promise<void> {
    if (!mediaId) return;
    const locked = await this.mediaAssets
      .findOneAndUpdate(
        { _id: new Types.ObjectId(mediaId), status: MediaStatus.Ready },
        { $inc: { referenceRevision: 1 } },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!locked) {
      throw new ConflictException({
        code: 'CATEGORY_MEDIA_INVALID',
        message: 'Category image must reference a ready media asset',
      });
    }
  }

  private assertVersion(category: CategoryDocument, expectedVersion: number): void {
    if ((category.get('version') as number) !== expectedVersion) throw this.versionConflict();
  }

  private wasProvided(input: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(input, key);
  }

  private toView(category: CategoryDocument): CategoryView {
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      parentId: category.parentId?.toHexString(),
      imageMediaId: category.imageMediaId?.toHexString(),
      status: category.status,
      sortOrder: category.sortOrder,
      version: category.get('version') as number,
      createdAt: category.get('createdAt') as Date,
      updatedAt: category.get('updatedAt') as Date,
    };
  }

  private rethrowDuplicate(error: unknown, code: string, message: string): void {
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new ConflictException({ code, message });
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category was not found' });
  }

  private versionConflict(): ConflictException {
    return new ConflictException({
      code: 'CATEGORY_VERSION_CONFLICT',
      message: 'Category changed since it was loaded; reload and retry',
    });
  }
}
