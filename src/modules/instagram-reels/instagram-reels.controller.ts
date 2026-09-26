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
import type { Request } from 'express';
import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { InstagramReelsQueryDto, SaveInstagramReelDto } from './instagram-reels.dto';
import { InstagramReelsService, ReelView, ReelsPage } from './instagram-reels.service';

@Controller('repair/reels')
export class InstagramReelsController {
  constructor(private readonly reels: InstagramReelsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: InstagramReelsQueryDto): Promise<ReelsPage> {
    return this.reels.list(query.page, false, query.limit);
  }
}
@Controller('admin/repair/reels')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminInstagramReelsController {
  constructor(private readonly reels: InstagramReelsService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: InstagramReelsQueryDto): Promise<ReelsPage> {
    return this.reels.list(query.page, true, query.limit);
  }
  @Post()
  create(
    @Body() input: SaveInstagramReelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<ReelView> {
    return this.reels.save(input, admin, getAuthRequestContext(request));
  }
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() input: SaveInstagramReelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<ReelView> {
    return this.reels.save(input, admin, getAuthRequestContext(request), id);
  }
}
