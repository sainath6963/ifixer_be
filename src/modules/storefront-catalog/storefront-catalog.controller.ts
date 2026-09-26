import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { StorefrontProductQueryDto, StorefrontProductSlugDto } from './dto/storefront-query.dto';
import { StorefrontCatalogService } from './storefront-catalog.service';
import type {
  StorefrontCategory,
  StorefrontPage,
  StorefrontProductCard,
  StorefrontProductDetail,
} from './storefront.types';

@ApiTags('storefront-catalog')
@Controller('catalog')
export class StorefrontCatalogController {
  constructor(private readonly catalog: StorefrontCatalogService) {}

  @Get('config')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get settings explicitly marked public' })
  configuration(): Promise<{ settings: Record<string, unknown> }> {
    return this.catalog.publicConfiguration();
  }

  @Get('categories')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get the active category tree' })
  categories(): Promise<{ categories: StorefrontCategory[] }> {
    return this.catalog.categoryTree();
  }

  @Get('products')
  @Header('Cache-Control', 'public, max-age=15, stale-while-revalidate=30')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'List, search, filter, and sort published products' })
  products(
    @Query() query: StorefrontProductQueryDto,
  ): Promise<StorefrontPage<StorefrontProductCard>> {
    return this.catalog.productsPage(query);
  }

  @Get('products/featured')
  @Header('Cache-Control', 'public, max-age=15, stale-while-revalidate=30')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'List featured published products' })
  featuredProducts(
    @Query() query: StorefrontProductQueryDto,
  ): Promise<StorefrontPage<StorefrontProductCard>> {
    return this.catalog.productsPage(query, true);
  }

  @Get('products/:slug')
  @Header('Cache-Control', 'public, max-age=15, stale-while-revalidate=30')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get one published product by slug' })
  product(
    @Param() params: StorefrontProductSlugDto,
  ): Promise<{ product: StorefrontProductDetail }> {
    return this.catalog.productDetail(params.slug);
  }
}
