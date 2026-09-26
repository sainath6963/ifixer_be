import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { getAuthRequestContext } from '../admin-auth/http-context';
import { CustomerAccountRecoveryService } from './customer-account-recovery.service';
import { CustomerAccessGuard } from './customer-access.guard';
import { CUSTOMER_ACCESS_SECURITY } from './customer.constants';
import { CustomerCookieService } from './customer-cookie.service';
import { CustomerCsrfGuard } from './customer-csrf.guard';
import { CustomerProfileService, type MobileChallengeView } from './customer-profile.service';
import type { AuthenticatedCustomer, CustomerView } from './customer.types';
import { CurrentCustomer } from './current-customer.decorator';
import {
  ConfirmCustomerMobileChangeDto,
  DeactivateCustomerAccountDto,
  RequestCustomerEmailChangeDto,
  RequestCustomerMobileChangeDto,
  UpdateCustomerPreferencesDto,
  UpdateCustomerProfileDto,
} from './dto/customer-profile.dto';

@ApiTags('customer-profile')
@Controller('customer/profile')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
export class CustomerProfileController {
  constructor(
    private readonly profiles: CustomerProfileService,
    private readonly recovery: CustomerAccountRecoveryService,
    private readonly cookies: CustomerCookieService,
  ) {}

  @Patch()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse()
  async updateProfile(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: UpdateCustomerProfileDto,
    @Req() request: Request,
  ): Promise<{ customer: CustomerView }> {
    return {
      customer: await this.profiles.updateName(
        customer,
        input.name,
        input.expectedVersion,
        getAuthRequestContext(request),
      ),
    };
  }

  @Patch('preferences')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse()
  async updatePreferences(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: UpdateCustomerPreferencesDto,
    @Req() request: Request,
  ): Promise<{ customer: CustomerView }> {
    return {
      customer: await this.profiles.updatePreferences(
        customer,
        input.marketingEmail,
        input.backInStockEmail,
        input.orderUpdatesSms,
        input.orderUpdatesWhatsapp,
        input.expectedVersion,
        getAuthRequestContext(request),
      ),
    };
  }

  @Post('email-change')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async requestEmailChange(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: RequestCustomerEmailChangeDto,
    @Req() request: Request,
  ): Promise<{ message: string }> {
    await this.recovery.requestEmailChange(
      customer,
      input.newEmail,
      input.currentPassword,
      getAuthRequestContext(request),
    );
    return { message: 'A confirmation link has been sent to the new email address.' };
  }

  @Post('mobile-change')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  requestMobileChange(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: RequestCustomerMobileChangeDto,
    @Req() request: Request,
  ): Promise<MobileChallengeView> {
    return this.profiles.requestMobileChange(
      customer,
      input.mobile,
      input.currentPassword,
      getAuthRequestContext(request),
    );
  }

  @Post('mobile-change/confirm')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmMobileChange(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: ConfirmCustomerMobileChangeDto,
    @Req() request: Request,
  ): Promise<{ customer: CustomerView }> {
    return {
      customer: await this.profiles.confirmMobileChange(
        customer,
        input.challengeId,
        input.otp,
        input.expectedVersion,
        getAuthRequestContext(request),
      ),
    };
  }

  @Post('deactivate')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async deactivate(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: DeactivateCustomerAccountDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.profiles.deactivate(
      customer,
      input.currentPassword,
      input.reason,
      getAuthRequestContext(request),
    );
    this.cookies.clearAllAuthCookies(response);
  }
}
