import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { getAuthRequestContext } from '../admin-auth/http-context';
import { readRequestCookie } from '../admin-auth/cookie.util';
import { CartService } from './cart.service';
import { CustomerAccountRecoveryService } from './customer-account-recovery.service';
import { CustomerAccessGuard } from './customer-access.guard';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerCookieService } from './customer-cookie.service';
import {
  CUSTOMER_ACCESS_SECURITY,
  CUSTOMER_CART_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
  CUSTOMER_REFRESH_SECURITY,
} from './customer.constants';
import { CustomerCsrfGuard } from './customer-csrf.guard';
import { CustomerCsrfService } from './customer-csrf.service';
import type { AuthenticatedCustomer, CustomerView } from './customer.types';
import { CurrentCustomer } from './current-customer.decorator';
import {
  ChangeCustomerPasswordDto,
  ConfirmCustomerEmailChangeDto,
  CustomerLoginDto,
  CustomerRegisterDto,
  ForgotCustomerPasswordDto,
  ResetCustomerPasswordDto,
  VerifyCustomerEmailDto,
} from './dto/customer-auth.dto';

@ApiTags('customer-auth')
@Controller('customer/auth')
@UseGuards(CustomerCsrfGuard)
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly cookies: CustomerCookieService,
    private readonly csrf: CustomerCsrfService,
    private readonly carts: CartService,
    private readonly recovery: CustomerAccountRecoveryService,
  ) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Issue a signed customer CSRF token and matching cookie' })
  csrfToken(@Res({ passthrough: true }) response: Response): {
    csrfToken: string;
    expiresInSeconds: number;
  } {
    return {
      csrfToken: this.csrf.issue(response),
      expiresInSeconds: this.csrf.ttlSeconds,
    };
  }

  @Post('register')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a customer account and session' })
  @ApiCreatedResponse()
  async register(
    @Body() input: CustomerRegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ customer: CustomerView }> {
    const result = await this.auth.register(
      input.name,
      input.email,
      input.password,
      getAuthRequestContext(request),
    );
    await this.claimGuestCart(request, result.customer.id, response);
    this.cookies.setAuthCookies(response, result);
    return { customer: result.customer };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start a customer session and merge the current guest cart' })
  @ApiOkResponse()
  async login(
    @Body() input: CustomerLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ customer: CustomerView }> {
    const result = await this.auth.login(
      input.email,
      input.password,
      getAuthRequestContext(request),
    );
    await this.claimGuestCart(request, result.customer.id, response);
    this.cookies.setAuthCookies(response, result);
    return { customer: result.customer };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth(CUSTOMER_REFRESH_SECURITY)
  @ApiOperation({ summary: 'Atomically rotate the customer refresh token' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ customer: CustomerView }> {
    const refreshToken = readRequestCookie(request, CUSTOMER_REFRESH_COOKIE);
    try {
      if (!refreshToken) {
        throw new UnauthorizedException({
          code: 'CUSTOMER_SESSION_REQUIRED',
          message: 'Customer authentication is required',
        });
      }
      const result = await this.auth.refresh(refreshToken, getAuthRequestContext(request));
      await this.claimGuestCart(request, result.customer.id, response);
      this.cookies.setAuthCookies(response, result);
      return { customer: result.customer };
    } catch (error: unknown) {
      this.cookies.clearAuthCookies(response);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth(CUSTOMER_REFRESH_SECURITY)
  @ApiOperation({ summary: 'Revoke the current customer session' })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(
      readRequestCookie(request, CUSTOMER_REFRESH_COOKIE),
      getAuthRequestContext(request),
    );
    this.cookies.clearAllAuthCookies(response);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @UseGuards(CustomerAccessGuard)
  @ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Revoke every session for the current customer' })
  @ApiNoContentResponse()
  async logoutAll(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logoutAll(customer, getAuthRequestContext(request));
    this.cookies.clearAllAuthCookies(response);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(CustomerAccessGuard)
  @ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Return the current customer from the live session' })
  me(@CurrentCustomer() customer: AuthenticatedCustomer): { customer: CustomerView } {
    return {
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobile: customer.mobile,
        emailVerified: customer.emailVerified,
        mobileVerified: customer.mobileVerified,
        version: customer.version,
        communicationPreferences: customer.communicationPreferences,
      },
    };
  }

  @Post('verification-email')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseGuards(CustomerAccessGuard)
  @ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Queue a fresh verification email when still required' })
  @ApiAcceptedResponse()
  async requestVerificationEmail(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Req() request: Request,
  ): Promise<{ message: string }> {
    await this.recovery.requestEmailVerification(customer, getAuthRequestContext(request));
    return { message: 'If verification is still needed, a new link will be sent.' };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Consume a one-time customer email-verification token' })
  @ApiNoContentResponse()
  async verifyEmail(@Body() input: VerifyCustomerEmailDto, @Req() request: Request): Promise<void> {
    await this.recovery.verifyEmail(input.token, getAuthRequestContext(request));
  }

  @Post('change-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Confirm a new email and revoke all customer sessions' })
  @ApiNoContentResponse()
  async confirmEmailChange(
    @Body() input: ConfirmCustomerEmailChangeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.recovery.confirmEmailChange(input.token, getAuthRequestContext(request));
    this.cookies.clearAllAuthCookies(response);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Queue password-reset instructions without account disclosure' })
  @ApiAcceptedResponse()
  async forgotPassword(
    @Body() input: ForgotCustomerPasswordDto,
    @Req() request: Request,
  ): Promise<{ message: string }> {
    await this.recovery.requestPasswordReset(input.email, getAuthRequestContext(request));
    return { message: 'If an eligible account exists, reset instructions will be sent.' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Consume a one-time token, reset password, and revoke all sessions' })
  @ApiNoContentResponse()
  async resetPassword(
    @Body() input: ResetCustomerPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.recovery.resetPassword(
      input.token,
      input.newPassword,
      getAuthRequestContext(request),
    );
    this.cookies.clearAllAuthCookies(response);
  }

  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @UseGuards(CustomerAccessGuard)
  @ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Change password and revoke every customer session' })
  @ApiNoContentResponse()
  async changePassword(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: ChangeCustomerPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.changePassword(
      customer,
      input.currentPassword,
      input.newPassword,
      getAuthRequestContext(request),
    );
    this.cookies.clearAllAuthCookies(response);
  }

  private async claimGuestCart(
    request: Request,
    customerId: string,
    response: Response,
  ): Promise<void> {
    const guestToken = readRequestCookie(request, CUSTOMER_CART_COOKIE);
    if (!guestToken) return;
    if (await this.carts.claimGuestCart(guestToken, customerId)) {
      this.cookies.clearGuestCartCookie(response);
    }
  }
}
