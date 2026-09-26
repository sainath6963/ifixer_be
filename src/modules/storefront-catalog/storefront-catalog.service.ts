import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';

import {
  Category,
  CategoryDocument,
  MediaAsset,
  MediaAssetDocument,
  Product,
} from '../../database/schemas/catalog.schema';
import { InventoryLevel, InventoryLevelDocument } from '../../database/schemas/inventory.schema';
import { StoreSetting } from '../../database/schemas/operations.schema';
import { MediaStatus, ProductStatus } from '../../domain/enums';
import { StorefrontProductQueryDto, StorefrontProductSort } from './dto/storefront-query.dto';
import type {
  StorefrontAvailability,
  StorefrontCategory,
  StorefrontCategoryReference,
  StorefrontImage,
  StorefrontPage,
  StorefrontProductCard,
  StorefrontProductDetail,
  StorefrontVariant,
} from './storefront.types';

interface AggregateVariant {
  variantId: Types.ObjectId;
  sku: string;
  title: string;
  attributes: Array<{ name: string; value: string }>;
  priceInPaise: number;
  compareAtPriceInPaise?: number;
  isActive: boolean;
  sortOrder: number;
}

interface AggregateProduct {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  categoryIds: Types.ObjectId[];
  publicVariants: AggregateVariant[];
  images: Array<{
    mediaAssetId: Types.ObjectId;
    altText?: string;
    isPrimary: boolean;
    sortOrder: number;
  }>;
  tags: string[];
  isFeatured: boolean;
  publishedAt: Date;
  displayPriceInPaise: number;
  maximumPriceInPaise: number;
}

interface AggregateFacet {
  items: AggregateProduct[];
  metadata: Array<{ total: number }>;
}

@Injectable()
export class StorefrontCatalogService {
  private readonly mediaUrlPrefix: string;

  constructor(
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Category.name) private readonly categories: Model<Category>,
    @InjectModel(MediaAsset.name) private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(StoreSetting.name) private readonly settings: Model<StoreSetting>,
    config: ConfigService,
  ) {
    const apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
    this.mediaUrlPrefix = `/${apiPrefix}/media`;
  }

  async categoryTree(): Promise<{ categories: StorefrontCategory[] }> {
    const categoryDocuments = await this.categories
      .find({ status: ProductStatus.Active })
      .sort({ sortOrder: 1, name: 1, _id: 1 })
      .exec();
    const mediaIds = categoryDocuments
      .map((category) => category.imageMediaId)
      .filter((id): id is Types.ObjectId => Boolean(id));
    const mediaMap = await this.loadMediaMap(mediaIds);
    const nodeMap = new Map<string, StorefrontCategory>();
    for (const category of categoryDocuments) {
      const media = category.imageMediaId
        ? mediaMap.get(category.imageMediaId.toHexString())
        : undefined;
      nodeMap.set(category.id, {
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        image: media ? this.toImage(media, category.name) : undefined,
        children: [],
      });
    }

    const roots: StorefrontCategory[] = [];
    for (const category of categoryDocuments) {
      const node = nodeMap.get(category.id);
      if (!node) continue;
      const parent = category.parentId ? nodeMap.get(category.parentId.toHexString()) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return { categories: roots };
  }

  async productsPage(
    query: StorefrontProductQueryDto,
    featuredOnly = false,
  ): Promise<StorefrontPage<StorefrontProductCard>> {
    if (
      query.minPriceInPaise !== undefined &&
      query.maxPriceInPaise !== undefined &&
      query.minPriceInPaise > query.maxPriceInPaise
    ) {
      throw new BadRequestException({
        code: 'PRICE_RANGE_INVALID',
        message: 'Minimum price cannot exceed maximum price',
      });
    }

    const search = query.search?.trim();
    const match: Record<string, unknown> = {
      status: ProductStatus.Active,
      visibility: { $ne: 'REPAIR_INTERNAL' },
      publishedAt: { $lte: new Date() },
    };
    if (featuredOnly) match.isFeatured = true;
    if (search) match.$text = { $search: search };
    if (query.category) {
      match.categoryIds = { $in: await this.categoryAndDescendantIds(query.category) };
    }

    const variantMatch: Record<string, unknown> = { isActive: true };
    if (query.minPriceInPaise !== undefined || query.maxPriceInPaise !== undefined) {
      variantMatch.priceInPaise = {
        ...(query.minPriceInPaise !== undefined ? { $gte: query.minPriceInPaise } : {}),
        ...(query.maxPriceInPaise !== undefined ? { $lte: query.maxPriceInPaise } : {}),
      };
    }
    match.variants = { $elemMatch: variantMatch };

    const variantConditions: Array<Record<string, unknown>> = [
      { $eq: ['$$variant.isActive', true] },
    ];
    if (query.minPriceInPaise !== undefined) {
      variantConditions.push({ $gte: ['$$variant.priceInPaise', query.minPriceInPaise] });
    }
    if (query.maxPriceInPaise !== undefined) {
      variantConditions.push({ $lte: ['$$variant.priceInPaise', query.maxPriceInPaise] });
    }

    const pipeline: PipelineStage[] = [{ $match: match }];
    if (search) {
      pipeline.push({ $set: { searchScore: { $meta: 'textScore' } } });
    }
    pipeline.push(
      {
        $set: {
          publicVariants: {
            $filter: {
              input: '$variants',
              as: 'variant',
              cond: { $and: variantConditions },
            },
          },
        },
      },
      {
        $set: {
          displayPriceInPaise: { $min: '$publicVariants.priceInPaise' },
          maximumPriceInPaise: { $max: '$publicVariants.priceInPaise' },
        },
      },
    );

    const selectedSort =
      query.sort ?? (search ? StorefrontProductSort.Relevance : StorefrontProductSort.Newest);
    const sort: Record<string, 1 | -1> =
      selectedSort === StorefrontProductSort.PriceAscending
        ? { displayPriceInPaise: 1, _id: 1 }
        : selectedSort === StorefrontProductSort.PriceDescending
          ? { displayPriceInPaise: -1, _id: -1 }
          : selectedSort === StorefrontProductSort.Relevance && search
            ? { searchScore: -1, publishedAt: -1, _id: -1 }
            : { publishedAt: -1, _id: -1 };
    pipeline.push({
      $facet: {
        items: [
          { $sort: sort },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
        ],
        metadata: [{ $count: 'total' }],
      },
    });

    const [facet] = await this.products.aggregate<AggregateFacet>(pipeline).exec();
    const items = facet?.items ?? [];
    const total = facet?.metadata[0]?.total ?? 0;
    return {
      items: await this.enrichCards(items),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async productDetail(slug: string): Promise<{ product: StorefrontProductDetail }> {
    const product = await this.products
      .findOne({
        slug,
        status: ProductStatus.Active,
        visibility: { $ne: 'REPAIR_INTERNAL' },
        publishedAt: { $lte: new Date() },
      })
      .exec();
    if (!product) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product was not found' });
    }

    const activeVariants = product.variants
      .filter((variant) => variant.isActive)
      .sort(
        (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
      );
    const [levels, categoryDocuments, mediaMap] = await Promise.all([
      this.inventory.find({ productId: product._id }).exec(),
      this.categories
        .find({ _id: { $in: product.categoryIds }, status: ProductStatus.Active })
        .exec(),
      this.loadMediaMap(product.images.map((image) => image.mediaAssetId)),
    ]);
    const inventoryMap = new Map(
      levels.map((level) => [level.variantId.toHexString(), this.availability(level)]),
    );
    const variants: StorefrontVariant[] = activeVariants.map((variant) => ({
      variantId: variant.variantId.toHexString(),
      sku: variant.sku,
      title: variant.title,
      attributes: variant.attributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
      priceInPaise: variant.priceInPaise,
      compareAtPriceInPaise: variant.compareAtPriceInPaise,
      currency: 'INR',
      availability: inventoryMap.get(variant.variantId.toHexString()) ?? 'OUT_OF_STOCK',
    }));
    const imageEntries = product.images
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .flatMap((image) => {
        const media = mediaMap.get(image.mediaAssetId.toHexString());
        return media
          ? [
              {
                image: this.toImage(media, image.altText || product.name),
                isPrimary: image.isPrimary,
              },
            ]
          : [];
      });
    const images = imageEntries.map((entry) => entry.image);
    const categories = categoryDocuments.map((category) => this.toCategoryReference(category));
    const prices = activeVariants.map((variant) => variant.priceInPaise);
    const availability: StorefrontAvailability = variants.some(
      (variant) => variant.availability === 'IN_STOCK',
    )
      ? 'IN_STOCK'
      : 'OUT_OF_STOCK';

    return {
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        excerpt: this.excerpt(product.description),
        description: product.description,
        categories,
        priceRange: {
          minInPaise: Math.min(...prices),
          maxInPaise: Math.max(...prices),
          currency: 'INR',
        },
        primaryImage: imageEntries.find((entry) => entry.isPrimary)?.image,
        images,
        variants,
        availability,
        isFeatured: product.isFeatured,
        tags: product.tags,
        publishedAt: product.publishedAt as Date,
      },
    };
  }

  async productCardsByIds(ids: Types.ObjectId[]): Promise<Map<string, StorefrontProductCard>> {
    if (!ids.length) return new Map();
    const products = await this.products
      .aggregate<AggregateProduct>([
        {
          $match: {
            _id: { $in: ids },
            status: ProductStatus.Active,
            visibility: { $ne: 'REPAIR_INTERNAL' },
            publishedAt: { $lte: new Date() },
          },
        },
        {
          $set: {
            publicVariants: {
              $filter: {
                input: '$variants',
                as: 'variant',
                cond: { $eq: ['$$variant.isActive', true] },
              },
            },
          },
        },
        {
          $set: {
            displayPriceInPaise: { $min: '$publicVariants.priceInPaise' },
            maximumPriceInPaise: { $max: '$publicVariants.priceInPaise' },
          },
        },
      ])
      .exec();
    const cards = await this.enrichCards(products);
    return new Map(cards.map((card) => [card.id, card]));
  }

  async publicConfiguration(): Promise<{ settings: Record<string, unknown> }> {
    const documents = await this.settings.find({ isPublic: true }).sort({ key: 1 }).exec();
    return {
      settings: Object.fromEntries(documents.map((setting) => [setting.key, setting.value])),
    };
  }

  private async enrichCards(products: AggregateProduct[]): Promise<StorefrontProductCard[]> {
    if (!products.length) return [];
    const productIds = products.map((product) => product._id);
    const categoryIds = products.flatMap((product) => product.categoryIds);
    const primaryMediaIds = products.flatMap((product) => {
      const primary = product.images.find((image) => image.isPrimary);
      return primary ? [primary.mediaAssetId] : [];
    });
    const [levels, categoryDocuments, mediaMap] = await Promise.all([
      this.inventory.find({ productId: { $in: productIds } }).exec(),
      this.categories.find({ _id: { $in: categoryIds }, status: ProductStatus.Active }).exec(),
      this.loadMediaMap(primaryMediaIds),
    ]);
    const categoryMap = new Map(
      categoryDocuments.map((category) => [category.id, this.toCategoryReference(category)]),
    );
    const availabilityMap = new Map(
      levels.map((level) => [
        `${level.productId.toHexString()}:${level.variantId.toHexString()}`,
        this.availability(level),
      ]),
    );

    return products.map((product) => {
      const primary = product.images.find((image) => image.isPrimary);
      const media = primary ? mediaMap.get(primary.mediaAssetId.toHexString()) : undefined;
      const availability: StorefrontAvailability = product.publicVariants.some(
        (variant) =>
          availabilityMap.get(`${product._id.toHexString()}:${variant.variantId.toHexString()}`) ===
          'IN_STOCK',
      )
        ? 'IN_STOCK'
        : 'OUT_OF_STOCK';
      return {
        id: product._id.toHexString(),
        name: product.name,
        slug: product.slug,
        excerpt: this.excerpt(product.description),
        categories: product.categoryIds.flatMap((id) => {
          const category = categoryMap.get(id.toHexString());
          return category ? [category] : [];
        }),
        priceRange: {
          minInPaise: product.displayPriceInPaise,
          maxInPaise: product.maximumPriceInPaise,
          currency: 'INR',
        },
        primaryImage: media ? this.toImage(media, primary?.altText || product.name) : undefined,
        availability,
        isFeatured: product.isFeatured,
        tags: product.tags,
      };
    });
  }

  private async categoryAndDescendantIds(slug: string): Promise<Types.ObjectId[]> {
    const root = await this.categories
      .findOne({ slug, status: ProductStatus.Active })
      .select('_id')
      .exec();
    if (!root) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Category was not found',
      });
    }

    const ids = [root._id];
    let frontier = [root._id];
    for (let depth = 0; depth < 100 && frontier.length; depth += 1) {
      const children = await this.categories
        .find({ parentId: { $in: frontier }, status: ProductStatus.Active })
        .select('_id')
        .exec();
      frontier = children.map((child) => child._id);
      ids.push(...frontier);
    }
    return ids;
  }

  private async loadMediaMap(ids: Types.ObjectId[]): Promise<Map<string, MediaAssetDocument>> {
    const uniqueIds = [...new Set(ids.map((id) => id.toHexString()))].map(
      (id) => new Types.ObjectId(id),
    );
    if (!uniqueIds.length) return new Map();
    const documents = await this.mediaAssets
      .find({ _id: { $in: uniqueIds }, status: MediaStatus.Ready })
      .exec();
    return new Map(documents.map((media) => [media.id, media]));
  }

  private toImage(media: MediaAssetDocument, altText: string): StorefrontImage {
    const base = `${this.mediaUrlPrefix}/${media.id}`;
    return {
      mediaAssetId: media.id,
      altText,
      width: media.width,
      height: media.height,
      sources: {
        original: `${base}/original`,
        thumbnail: `${base}/thumbnail`,
        card: `${base}/card`,
        large: `${base}/large`,
      },
    };
  }

  private toCategoryReference(category: CategoryDocument): StorefrontCategoryReference {
    return { id: category.id, name: category.name, slug: category.slug };
  }

  private availability(level: InventoryLevelDocument): StorefrontAvailability {
    return level.onHand - level.reserved > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
  }

  private excerpt(description: string): string {
    return description.length <= 220 ? description : `${description.slice(0, 219).trimEnd()}…`;
  }
}
