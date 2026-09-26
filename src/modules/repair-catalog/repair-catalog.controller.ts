import type { RepairCatalogEntry, RepairCatalogView } from './repair-catalog.types';
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { BrandDto, ModelDto, ServiceDto, OptionDto } from './repair-catalog.dto';
import { RepairCatalogService } from './repair-catalog.service';

@Controller('repair')
export class RepairCatalogController {
  constructor(private readonly catalog: RepairCatalogService) {}
  @Get('catalog') list(): Promise<RepairCatalogView> {
    return this.catalog.list();
  }
  @Get('brands') async brands(): Promise<{ brands: RepairCatalogEntry[] }> {
    return { brands: (await this.catalog.list()).brands };
  }
  @Get('models') async models(): Promise<{ models: RepairCatalogEntry[] }> {
    return { models: (await this.catalog.list()).models };
  }
  @Get('services') async services(): Promise<{
    services: RepairCatalogEntry[];
    options: RepairCatalogEntry[];
  }> {
    const catalog = await this.catalog.list();
    return { services: catalog.services, options: catalog.options };
  }
}

@Controller('admin/repair/catalog')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminRepairCatalogController {
  constructor(private readonly catalog: RepairCatalogService) {}
  @Get() list(): Promise<RepairCatalogView> {
    return this.catalog.list(true);
  }

  @Post('brands')
  async createBrand(
    @Body() input: BrandDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return { entry: await this.catalog.saveBrand(input, admin, getAuthRequestContext(request)) };
  }

  @Patch('brands/:id')
  async updateBrand(
    @Body() input: BrandDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return {
      entry: await this.catalog.saveBrand(input, admin, getAuthRequestContext(request), id),
    };
  }

  @Post('models')
  async createModel(
    @Body() input: ModelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return { entry: await this.catalog.saveModel(input, admin, getAuthRequestContext(request)) };
  }

  @Patch('models/:id')
  async updateModel(
    @Body() input: ModelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return {
      entry: await this.catalog.saveModel(input, admin, getAuthRequestContext(request), id),
    };
  }

  @Post('services')
  async createService(
    @Body() input: ServiceDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return { entry: await this.catalog.saveService(input, admin, getAuthRequestContext(request)) };
  }

  @Patch('services/:id')
  async updateService(
    @Body() input: ServiceDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return {
      entry: await this.catalog.saveService(input, admin, getAuthRequestContext(request), id),
    };
  }

  @Post('options')
  async createOption(
    @Body() input: OptionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return { entry: await this.catalog.saveOption(input, admin, getAuthRequestContext(request)) };
  }

  @Patch('options/:id')
  async updateOption(
    @Body() input: OptionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ entry: RepairCatalogEntry }> {
    return {
      entry: await this.catalog.saveOption(input, admin, getAuthRequestContext(request), id),
    };
  }
}
