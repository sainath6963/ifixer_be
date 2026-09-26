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
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminAuthService } from './admin-auth.service';
import {
  ADMIN_ACCESS_SECURITY,
  ADMIN_REFRESH_COOKIE,
  ADMIN_REFRESH_SECURITY,
} from './auth.constants';
import type { AdminView, AuthenticatedAdmin } from './auth.types';
import { AdminCookieService } from './cookie.service';
import { readRequestCookie } from './cookie.util';
import { CsrfGuard } from './csrf.guard';
import { CsrfService } from './csrf.service';
import { CurrentAdmin } from './current-admin.decorator';
import { ChangeAdminPasswordDto } from './dto/change-password.dto';
import { AdminLoginDto } from './dto/login.dto';
import { getAuthRequestContext } from './http-context';
import { AdminRoles } from './roles.decorator';
import { AdminRolesGuard } from './roles.guard';

@ApiTags('admin-auth')
@Controller('admin/auth')
@UseGuards(CsrfGuard)
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly cookies: AdminCookieService,
    private readonly csrf: CsrfService,
  ) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Issue a signed CSRF token and matching browser cookie' })
  @ApiOkResponse({ description: 'CSRF token issued' })
  csrfToken(@Res({ passthrough: true }) response: Response): {
    csrfToken: string;
    expiresInSeconds: number;
  } {
    return {
      csrfToken: this.csrf.issue(response),
      expiresInSeconds: this.csrf.ttlSeconds,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start an admin session' })
  @ApiOkResponse({ description: 'Signed HttpOnly authentication cookies issued' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  async login(
    @Body() input: AdminLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ admin: AdminView }> {
    const result = await this.auth.login(
      input.email,
      input.password,
      getAuthRequestContext(request),
    );
    this.cookies.setAuthCookies(response, result);
    return { admin: result.admin };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth(ADMIN_REFRESH_SECURITY)
  @ApiOperation({ summary: 'Atomically rotate the admin refresh token' })
  @ApiOkResponse({ description: 'Authentication cookies rotated' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ admin: AdminView }> {
    const refreshToken = readRequestCookie(request, ADMIN_REFRESH_COOKIE);
    try {
      if (!refreshToken) {
        throw new UnauthorizedException({
          code: 'ADMIN_SESSION_REQUIRED',
          message: 'Admin authentication is required',
        });
      }
      const result = await this.auth.refresh(refreshToken, getAuthRequestContext(request));
      this.cookies.setAuthCookies(response, result);
      return { admin: result.admin };
    } catch (error: unknown) {
      this.cookies.clearAuthCookies(response);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth(ADMIN_REFRESH_SECURITY)
  @ApiOperation({ summary: 'Revoke the current admin session' })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const refreshToken = readRequestCookie(request, ADMIN_REFRESH_COOKIE);
    await this.auth.logout(refreshToken, getAuthRequestContext(request));
    this.cookies.clearAllCookies(response);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminAccessGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception, AdminRole.Technician)
  @ApiCookieAuth(ADMIN_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Revoke all sessions for the current admin' })
  @ApiNoContentResponse()
  async logoutAll(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logoutAll(admin, getAuthRequestContext(request));
    this.cookies.clearAllCookies(response);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminAccessGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception, AdminRole.Technician)
  @ApiCookieAuth(ADMIN_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Return the current admin and live roles' })
  @ApiOkResponse()
  me(@CurrentAdmin() admin: AuthenticatedAdmin): { admin: AdminView } {
    return {
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        roles: admin.roles,
      },
    };
  }

  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminAccessGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception, AdminRole.Technician)
  @ApiCookieAuth(ADMIN_ACCESS_SECURITY)
  @ApiOperation({ summary: 'Change password and revoke every admin session' })
  @ApiNoContentResponse()
  async changePassword(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() input: ChangeAdminPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.changePassword(
      admin,
      input.currentPassword,
      input.newPassword,
      getAuthRequestContext(request),
    );
    this.cookies.clearAllCookies(response);
  }
}
