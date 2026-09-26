import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import type { InventoryView, PageResult, ProductView } from './catalog.types';
import { AdjustInventoryDto } from './dto/inventory.dto';
import {
  AddProductVariantDto,
  CreateProductDto,
  ProductListQueryDto,
  ReplaceProductImagesDto,
  UpdateProductDto,
  UpdateProductVariantDto,
} from './dto/product.dto';
import { ProductService } from './product.service';

@ApiTags('admin-products')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/products')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a draft product, variants, and inventory atomically' })
  async create(
    @Body() input: CreateProductDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ product: ProductView }> {
    return { product: await this.products.create(input, admin, getAuthRequestContext(request)) };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List and search admin products' })
  list(@Query() query: ProductListQueryDto): Promise<PageResult<ProductView>> {
    return this.products.list(query);
  }

  @Get(':productId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get a product with live inventory levels' })
  async get(@Param('productId') productId: string): Promise<{ product: ProductView }> {
    return { product: await this.products.get(productId) };
  }

  @Patch(':productId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Update, publish, unpublish, feature, or archive a product' })
  async update(
    @Param('productId') productId: string,
    @Body() input: UpdateProductDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ product: ProductView }> {
    return {
      product: await this.products.update(productId, input, admin, getAuthRequestContext(request)),
    };
  }

  @Post(':productId/variants')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Add a variant and inventory level atomically' })
  async addVariant(
    @Param('productId') productId: string,
    @Body() input: AddProductVariantDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ product: ProductView }> {
    return {
      product: await this.products.addVariant(
        productId,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }

  @Patch(':productId/variants/:variantId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Update or deactivate a variant; variants are never hard-deleted' })
  async updateVariant(
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() input: UpdateProductVariantDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ product: ProductView }> {
    return {
      product: await this.products.updateVariant(
        productId,
        variantId,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }

  @Put(':productId/images')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Replace the ordered product image set' })
  async replaceImages(
    @Param('productId') productId: string,
    @Body() input: ReplaceProductImagesDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ product: ProductView }> {
    return {
      product: await this.products.replaceImages(
        productId,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }

  @Post(':productId/variants/:variantId/inventory-adjustments')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Apply an idempotent, audited physical-stock adjustment' })
  async adjustInventory(
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() input: AdjustInventoryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ inventory: InventoryView }> {
    return {
      inventory: await this.products.adjustInventory(
        productId,
        variantId,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }
}
