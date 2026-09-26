import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { CustomerAccessGuard } from '../customer/customer-access.guard';
import { CUSTOMER_ACCESS_SECURITY } from '../customer/customer.constants';
import { CustomerCsrfGuard } from '../customer/customer-csrf.guard';
import { CurrentCustomer } from '../customer/current-customer.decorator';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import { ReturnEvidenceService } from './return-evidence.service';
import type { ReturnEvidenceView } from './return-evidence.types';

@ApiTags('customer-return-evidence')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/orders/:orderNumber/returns/:returnNumber/evidence')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerReturnEvidenceController {
  constructor(private readonly evidence: ReturnEvidenceService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List private evidence attached to an owned return request' })
  async list(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderNumber') orderNumber: string,
    @Param('returnNumber') returnNumber: string,
  ): Promise<{ evidence: ReturnEvidenceView[] }> {
    return { evidence: await this.evidence.customerList(customer, orderNumber, returnNumber) };
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10_485_760, files: 1, fields: 0 },
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
  @ApiOperation({ summary: 'Normalize and privately store one return evidence image' })
  async upload(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderNumber') orderNumber: string,
    @Param('returnNumber') returnNumber: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: Request,
  ): Promise<{ evidence: ReturnEvidenceView }> {
    return {
      evidence: await this.evidence.upload(
        customer,
        orderNumber,
        returnNumber,
        file,
        getAuthRequestContext(request),
      ),
    };
  }

  @Get(':evidenceId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('Cross-Origin-Resource-Policy', 'same-origin')
  @ApiOkResponse({ description: 'Authenticated WebP evidence stream' })
  async content(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderNumber') orderNumber: string,
    @Param('returnNumber') returnNumber: string,
    @Param('evidenceId') evidenceId: string,
  ): Promise<StreamableFile> {
    const delivery = await this.evidence.customerDelivery(
      customer,
      orderNumber,
      returnNumber,
      evidenceId,
    );
    return new StreamableFile(delivery.stream, {
      type: delivery.mimeType,
      length: delivery.sizeBytes,
    });
  }

  @Delete(':evidenceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiOperation({ summary: 'Delete evidence while the request is still pending review' })
  async delete(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderNumber') orderNumber: string,
    @Param('returnNumber') returnNumber: string,
    @Param('evidenceId') evidenceId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.evidence.customerDelete(
      customer,
      orderNumber,
      returnNumber,
      evidenceId,
      getAuthRequestContext(request),
    );
  }
}

@ApiTags('admin-return-evidence')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/returns/:returnNumber/evidence')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminReturnEvidenceController {
  constructor(private readonly evidence: ReturnEvidenceService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List private evidence for an admin return request' })
  async list(
    @Param('returnNumber') returnNumber: string,
  ): Promise<{ evidence: ReturnEvidenceView[] }> {
    return { evidence: await this.evidence.adminList(returnNumber) };
  }

  @Get(':evidenceId/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('Cross-Origin-Resource-Policy', 'same-origin')
  @ApiOkResponse({ description: 'Authenticated WebP evidence stream' })
  async content(
    @Param('returnNumber') returnNumber: string,
    @Param('evidenceId') evidenceId: string,
  ): Promise<StreamableFile> {
    const delivery = await this.evidence.adminDelivery(returnNumber, evidenceId);
    return new StreamableFile(delivery.stream, {
      type: delivery.mimeType,
      length: delivery.sizeBytes,
    });
  }
}
