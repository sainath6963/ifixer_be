import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
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
import type { MediaAssetView, PageResult } from './catalog.types';
import { MediaListQueryDto } from './dto/media.dto';
import { LocalMediaService, MediaDeliveryVariant } from './local-media.service';

@ApiTags('admin-media')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/media')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminMediaController {
  constructor(private readonly media: LocalMediaService) {}

  @Post('images')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 26_214_400, files: 1, fields: 0 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Validate, normalize, and store one product image locally' })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ media: MediaAssetView }> {
    return { media: await this.media.uploadImage(file, admin, getAuthRequestContext(request)) };
  }

  @Get()
  @ApiOperation({ summary: 'List media assets' })
  list(@Query() query: MediaListQueryDto): Promise<PageResult<MediaAssetView>> {
    return this.media.list(query);
  }

  @Delete(':assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiOperation({ summary: 'Delete an unreferenced media asset and its local files' })
  async delete(
    @Param('assetId') assetId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<void> {
    await this.media.delete(assetId, admin, getAuthRequestContext(request));
  }
}

@ApiTags('media')
@Controller('media')
export class MediaDeliveryController {
  constructor(private readonly media: LocalMediaService) {}

  @Get(':assetId/:variant')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @ApiOperation({ summary: 'Stream a normalized public image variant' })
  @ApiOkResponse({ description: 'WebP image stream' })
  async get(
    @Param('assetId') assetId: string,
    @Param('variant') variant: string,
  ): Promise<StreamableFile> {
    if (!['original', 'thumbnail', 'card', 'large'].includes(variant)) {
      throw new NotFoundException({
        code: 'MEDIA_VARIANT_NOT_FOUND',
        message: 'Media variant was not found',
      });
    }
    const delivery = await this.media.delivery(assetId, variant as MediaDeliveryVariant);
    return new StreamableFile(delivery.stream, {
      type: delivery.mimeType,
      length: delivery.sizeBytes,
    });
  }
}
