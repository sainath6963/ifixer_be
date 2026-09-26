import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
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
import type { CategoryView, PageResult } from './catalog.types';
import { CategoryService } from './category.service';
import { CategoryListQueryDto, CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@ApiTags('admin-categories')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/categories')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a draft category' })
  async create(
    @Body() input: CreateCategoryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ category: CategoryView }> {
    return {
      category: await this.categories.create(input, admin, getAuthRequestContext(request)),
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List categories for the admin catalog' })
  list(@Query() query: CategoryListQueryDto): Promise<PageResult<CategoryView>> {
    return this.categories.list(query);
  }

  @Get(':categoryId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get one category' })
  async get(@Param('categoryId') categoryId: string): Promise<{ category: CategoryView }> {
    return { category: await this.categories.get(categoryId) };
  }

  @Patch(':categoryId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Update, activate, unpublish, or archive a category' })
  async update(
    @Param('categoryId') categoryId: string,
    @Body() input: UpdateCategoryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ category: CategoryView }> {
    return {
      category: await this.categories.update(
        categoryId,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }
}
